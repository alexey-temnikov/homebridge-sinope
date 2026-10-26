import type { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SinopeDevice, SinopeDeviceState, SinopeDeviceStateRequest, DeviceKind } from './types';
import type { SinopePlatform } from './platform';
import { CommandQueue, StateCache } from './state-cache';

interface DeviceState {
  currentTemperature?: number;
  targetTemperature?: number;
  currentHeatingCoolingState?: number;
  targetHeatingCoolingState?: number;
  onOff?: boolean;
  intensity?: number;
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** All handler failures become HomeKit errors, never process-level rejections. */
export class SinopeAccessory {
  readonly service: Service;
  private readonly cache: StateCache<DeviceState>;
  private readonly commands = new CommandQueue();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private displayUnits = 0;

  constructor(
    private readonly platform: SinopePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: SinopeDevice,
    private readonly kind: DeviceKind = 'thermostat',
  ) {
    const { Service: S, Characteristic: C } = platform;
    const info = accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, device.vendor || 'Sinopé')
      .setCharacteristic(C.Model, device.sku).setCharacteristic(C.SerialNumber, device.identifier);
    const type = kind === 'thermostat' ? S.Thermostat : kind === 'outlet' ? S.Outlet : kind === 'dimmer' ? S.Lightbulb : S.Switch;
    this.service = accessory.getService(type) || accessory.addService(type);
    this.service.setCharacteristic(C.Name, device.name);
    this.cache = new StateCache(async () => {
      const raw = kind === 'thermostat' ? await platform.neviweb.fetchThermostat(device.id, /ZB/.test(device.sku)) :
        kind === 'dimmer' ? await platform.neviweb.fetchDimmer(device.id) : await platform.neviweb.fetchSwitch(device.id);
      const state = this.normalize(raw);
      if (!this.disposed) { this.apply(state); }
      return state;
    });
    if (kind === 'thermostat') {
      // Neviweb TH1123/TH1124 allow frost-protection setpoints below HAP's default 10 C.
      this.service.getCharacteristic(C.TargetTemperature).setProps({ minValue: 5, maxValue: 30, minStep: 0.5 });
      this.service.getCharacteristic(C.TargetHeatingCoolingState).setProps({ validValues: /ZB/.test(device.sku) ? [0, 1] : [0, 1, 3] });
      this.get(C.CurrentHeatingCoolingState, 'currentHeatingCoolingState');
      this.get(C.TargetHeatingCoolingState, 'targetHeatingCoolingState');
      this.get(C.CurrentTemperature, 'currentTemperature');
      this.get(C.TargetTemperature, 'targetTemperature');
      this.set(C.TargetTemperature, async value => {
        if (!finite(value, 5, 30) || Math.abs(value * 2 - Math.round(value * 2)) > 1e-6) { throw this.invalid(); }
        await this.write({ roomSetpoint: value });
      });
      this.set(C.TargetHeatingCoolingState, async value => {
        const zigbee = /ZB/.test(device.sku);
        if (!(zigbee ? [0, 1] : [0, 1, 3]).includes(Number(value)) || typeof value !== 'number') { throw this.invalid(); }
        await this.write(zigbee ? { systemMode: value === 0 ? 'off' : 'heat' } :
          { setpointMode: value === 0 ? 'off' : value === 3 ? 'auto' : 'manual' });
      });
      const units = this.service.getCharacteristic(C.TemperatureDisplayUnits);
      this.displayUnits = units.value === 1 ? 1 : 0;
      units.onGet(() => this.displayUnits);
      this.set(C.TemperatureDisplayUnits, async value => {
        if (value !== 0 && value !== 1) { throw this.invalid(); }
        // A HomeKit display preference; all API temperatures remain Celsius.
        this.displayUnits = value;
      });
    } else {
      this.get(C.On, 'onOff');
      this.set(C.On, async value => {
        if (typeof value !== 'boolean' && value !== 0 && value !== 1) { throw this.invalid(); }
        await this.write({ onOff: value ? 'on' : 'off' });
      });
      if (kind === 'dimmer') {
        this.get(C.Brightness, 'intensity');
        this.set(C.Brightness, async value => {
          if (!finite(value, 0, 100) || !Number.isInteger(value)) { throw this.invalid(); }
          await this.write({ intensity: value }); // No blind duplicate PUT.
        });
      }
      // OutletInUse requires real load telemetry, not the relay's on/off value.
      if (kind === 'outlet') { this.service.getCharacteristic(C.OutletInUse).onGet(() => this.unavailable()); }
    }
    this.timer = setInterval(() => this.refresh(), (platform.config.pollInterval ?? 60) * 1000);
    this.timer.unref();
    this.refresh();
  }

  private invalid(): Error {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
  }

  private unavailable(): never {
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private get(type: Parameters<Service['getCharacteristic']>[0], key: keyof DeviceState): void {
    this.service.getCharacteristic(type)!.onGet(async () => {
      try {
        const value = (await this.cache.get())[key];
        if (value === undefined || this.disposed) { return this.unavailable(); }
        return value;
      } catch { return this.unavailable(); }
    });
  }

  private set(type: Parameters<Service['getCharacteristic']>[0], action: (value: CharacteristicValue) => Promise<void>): void {
    this.service.getCharacteristic(type)!.onSet(async value => {
      if (this.disposed) { return this.unavailable(); }
      try { await action(value); }
      catch (error) {
        if (error instanceof this.platform.api.hap.HapStatusError) { throw error; }
        return this.unavailable();
      }
    });
  }

  private async write(body: SinopeDeviceStateRequest): Promise<void> {
    await this.commands.run(async () => {
      if (this.disposed) { return this.unavailable(); }
      this.cache.invalidate();
      try { await this.platform.neviweb.updateDevice(this.device.id, body); }
      finally { this.cache.invalidate(); }
    });
  }

  private normalize(raw: SinopeDeviceState): DeviceState {
    if (!raw || typeof raw !== 'object') { throw new Error('Invalid device state'); }
    if (this.kind === 'thermostat') {
      const mode = /ZB/.test(this.device.sku) ? raw.systemMode : raw.setpointMode;
      if (!finite(raw.roomTemperature?.value, 0, 100) || !finite(raw.roomSetpoint, 5, 30) ||
          !['off', 'auto', 'manual', 'autoBypass', 'heat'].includes(mode || '')) {
        throw new Error('Incomplete thermostat state');
      }
      const output = typeof raw.outputPercentDisplay === 'object' ? raw.outputPercentDisplay?.percent : raw.outputPercentDisplay;
      if (!finite(output, 0, 100)) { throw new Error('Invalid heating output'); }
      return {
        currentTemperature: raw.roomTemperature.value, targetTemperature: raw.roomSetpoint,
        currentHeatingCoolingState: output > 0 ? 1 : 0,
        targetHeatingCoolingState: mode === 'off' ? 0 : mode === 'auto' ? 3 : 1,
      };
    }
    if (raw.onOff !== 'on' && raw.onOff !== 'off') { throw new Error('Invalid relay state'); }
    if (this.kind === 'dimmer' && !finite(raw.intensity, 0, 100)) { throw new Error('Invalid brightness'); }
    return { onOff: raw.onOff === 'on', intensity: raw.intensity };
  }

  private apply(state: DeviceState): void {
    const C = this.platform.Characteristic;
    const values: [Parameters<Service['getCharacteristic']>[0], keyof DeviceState][] = this.kind === 'thermostat' ? [
      [C.CurrentTemperature, 'currentTemperature'], [C.TargetTemperature, 'targetTemperature'],
      [C.CurrentHeatingCoolingState, 'currentHeatingCoolingState'], [C.TargetHeatingCoolingState, 'targetHeatingCoolingState'],
    ] : [[C.On, 'onOff'], ...(this.kind === 'dimmer' ? [[C.Brightness, 'intensity'] as [typeof Characteristic.Brightness, keyof DeviceState]] : [])];
    for (const [type, key] of values) {
      const value = state[key];
      if (value !== undefined) { this.service.updateCharacteristic(type, value); }
    }
  }

  private refresh(): void {
    if (this.disposed) { return; }
    void this.cache.get().catch(() => { this.platform.log.warn('Could not refresh Sinopé device %s; HomeKit reads will report unavailable.', this.device.name); });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}

export class SinopeSwitchAccessory extends SinopeAccessory {
  constructor(p: SinopePlatform, a: PlatformAccessory, d: SinopeDevice) { super(p, a, d, 'switch'); }
}
export class SinopeOutletAccessory extends SinopeAccessory {
  constructor(p: SinopePlatform, a: PlatformAccessory, d: SinopeDevice) { super(p, a, d, 'outlet'); }
}
export class SinopeDimmerAccessory extends SinopeAccessory {
  constructor(p: SinopePlatform, a: PlatformAccessory, d: SinopeDevice) { super(p, a, d, 'dimmer'); }
}
export { SinopeAccessory as SinopeThermostatAccessory };
