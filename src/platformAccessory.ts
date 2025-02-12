import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import {SinopeDevice, SinopeDeviceState, SinopeDeviceStateRequest, SinopeSwitchDevice} from './types';
import { SinopePlatform } from './platform';
import AsyncLock from 'async-lock';

const STATE_KEY = 'state';

class State {
  currentTemperature? = 0;
  targetTemperature? = 0;
  currentHeatingCoolingState? = 0;
  targetHeatingCoolingState? = 0;
  onOff?: boolean;
  lock = new AsyncLock({ timeout: 5000 });
  validUntil = 0;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SinopeAccessory {
  private service: Service;
  private state = new State();

  constructor(
    private readonly platform: SinopePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: SinopeDevice,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.device.vendor)
      .setCharacteristic(this.platform.Characteristic.Model, this.device.sku)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.identifier);

    // create a new Thermostat service
    this.service = this.accessory.getService(this.platform.Service.Thermostat)
    || this.accessory.addService(this.platform.Service.Thermostat);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // create handlers for required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .on('get', this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .on('get', this.handleTargetHeatingCoolingStateGet.bind(this))
      .on('set', this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .on('get', this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .on('get', this.handleTargetTemperatureGet.bind(this))
      .on('set', this.handleTargetTemperatureSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .on('get', this.handleTemperatureDisplayUnitsGet.bind(this))
      .on('set', this.handleTemperatureDisplayUnitsSet.bind(this));

    this.updateState();
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  async handleCurrentHeatingCoolingStateGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    const state = await this.getState();
    callback(null, state.currentHeatingCoolingState);
  }


  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  async handleTargetHeatingCoolingStateGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    const state = await this.getState();
    callback(null, state.targetHeatingCoolingState);
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:' + value);

    const state = await this.getState();
    const mode = Number(value);
    let setpointMode = '';

    if (mode === 0) {
      setpointMode = 'off';
    } else if (mode !== 0 && state.targetHeatingCoolingState === 0) {
      // Only set setpointMode to 'auto' if the target state was 0 (off),
      // because Neviweb sets the mode to 'autoBypass' automatically when the
      // temperature is manually modified, but the API does not accept this last value
      setpointMode = 'auto';
    } else {
      callback(null);
      return;
    }

    const body: SinopeDeviceStateRequest = {setpointMode: setpointMode};
    try {
      await this.platform.neviweb.updateDevice(this.device.id, body);
      this.platform.log.debug('updated device %s with TargetTemperature %d', this.device.name, value);
    } catch(error) {
      this.platform.log.error('could not update TargetTemperature of device %s', this.device.name);
    }

    callback(null);
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  async handleCurrentTemperatureGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const state = await this.getState();
    callback(null, state.currentTemperature);
  }


  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  async handleTargetTemperatureGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const state = await this.getState();
    callback(null, state.targetTemperature);
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  async handleTargetTemperatureSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Triggered SET TargetTemperature:' + value);

    const body: SinopeDeviceStateRequest = {roomSetpoint: Number(value)};
    try {
      await this.platform.neviweb.updateDevice(this.device.id, body);
      this.platform.log.debug('updated device %s with TargetTemperature %d', this.device.name, value);
    } catch(error) {
      this.platform.log.error('could not update TargetTemperature of device %s', this.device.name);
    }

    callback(null);
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');

    callback(null, 1);
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Triggered SET TemperatureDisplayUnits:' + value);



    callback(null);
  }

  private async getState(): Promise<State> {
    return await this.state.lock.acquire(STATE_KEY, async () => {
      if (!this.isValid(this.state.validUntil)) {
        this.platform.log.debug('updating state for accessory %s', this.device.name);
        await this.updateState();
      } else {
        this.platform.log.debug('state is still valid for accessory %s', this.device.name);
      }
      return this.state;
    });
  }

  private async updateState() {
    let deviceState: SinopeDeviceState;
    try {
      deviceState = await this.platform.neviweb.fetchDevice(this.device.id);
      this.platform.log.debug('fetched update for device %s from Neviweb API: %s', this.device.name, JSON.stringify(deviceState));

      this.state.validUntil = this.currentEpoch() + 10;

      if (deviceState.roomTemperature != null && deviceState.roomTemperature.value != null) {
        this.state.currentTemperature = deviceState.roomTemperature.value;
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            this.state.currentTemperature,
        );

        this.state.targetTemperature = deviceState.roomSetpoint;
        if (this.state.targetTemperature != undefined) {
          this.service.updateCharacteristic(
              this.platform.Characteristic.TargetTemperature,
              this.state.targetTemperature,
          );
        }

        if (deviceState.outputPercentDisplay != undefined && deviceState.outputPercentDisplay > 0) {
          this.state.currentHeatingCoolingState = 1;
        } else {
          this.state.currentHeatingCoolingState = 0;
        }
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeatingCoolingState,
            this.state.currentHeatingCoolingState,
        );

        if (deviceState.setpointMode === 'auto') {
          this.state.targetHeatingCoolingState = 3;
        } else if (deviceState.setpointMode === 'off') {
          this.state.targetHeatingCoolingState = 0;
        } else {
          this.state.targetHeatingCoolingState = 1;
        }
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeatingCoolingState,
            this.state.targetHeatingCoolingState,
        );
      } else if (deviceState.onOff != undefined) {
        this.state.onOff = deviceState.onOff == "on" ? true : false;
        if (this.state.onOff != undefined) {
          this.service.updateCharacteristic(
              this.platform.Characteristic.OutletInUse,
              this.state.onOff,
          );
        }
      }

      // this.state.targetHeatingCoolingState = 1;
      // this.service.updateCharacteristic(
      //   this.platform.Characteristic.TargetHeatingCoolingState,
      //   this.state.targetHeatingCoolingState,
      // );
    } catch(error) {
      this.platform.log.error('could not fetch update for device %s from Neviweb API', this.device.name);
    }
  }

  private currentEpoch(): number {
    return Math.ceil((new Date()).getTime() / 1000);
  }

  private isValid(timestamp: number): boolean {
    return timestamp > this.currentEpoch() && timestamp !== undefined;
  }
}


export class SinopeSwitchAccessory {
  private service: Service;
  private state = new State();

  constructor(
      private readonly platform: SinopePlatform,
      private readonly accessory: PlatformAccessory,
      private readonly device: SinopeSwitchDevice,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Manufacturer, this.device.vendor)
        .setCharacteristic(this.platform.Characteristic.Model, this.device.sku)
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.identifier);

    // create a new Thermostat service
    this.service = this.accessory.getService(this.platform.Service.Switch)
        || this.accessory.addService(this.platform.Service.Switch);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);


    this.service.getCharacteristic(this.platform.Characteristic.On)
        .on('get', this.getOnCharacteristicHandler.bind(this))
        .on('set', this.setOnCharacteristicHandler.bind(this))

    this.updateState();
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  async getOnCharacteristicHandler(callback: CharacteristicGetCallback) {
    this.platform.log.debug('Triggered GET getOnCharacteristicHandler');

    const state = await this.getState();
    callback(null, state.onOff);
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  async setOnCharacteristicHandler(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Triggered SET Senope Switch State:' + value);

    const body: SinopeDeviceStateRequest = {onOff: value ? "on" : "off"};
    try {
      await this.platform.neviweb.updateDevice(this.device.id, body);
      this.platform.log.debug('updated device %s with TargetTemperature %d', this.device.name, value);
    } catch(error) {
      this.platform.log.error('could not update TargetTemperature of device %s', this.device.name);
    }

    callback(null);
  }


  private async getState(): Promise<State> {
    return await this.state.lock.acquire(STATE_KEY, async () => {
      if (!this.isValid(this.state.validUntil)) {
        this.platform.log.debug('updating state for accessory %s', this.device.name);
        await this.updateState();
      } else {
        this.platform.log.debug('state is still valid for accessory %s', this.device.name);
      }
      return this.state;
    });
  }

  private async updateState() {
    let deviceState: SinopeDeviceState;
    try {
      deviceState = await this.platform.neviweb.fetchDevice(this.device.id);
      this.platform.log.debug('fetched update for device %s from Neviweb API: %s', this.device.name, JSON.stringify(deviceState));

      this.state.validUntil = this.currentEpoch() + 10;

    if (deviceState.onOff != undefined) {
        this.state.onOff = deviceState.onOff == "on" ? true : false;
        if (this.state.onOff != undefined) {
          this.service.updateCharacteristic(
              this.platform.Characteristic.OutletInUse,
              this.state.onOff,
          );
        }
      }

    } catch(error) {
      this.platform.log.error('could not fetch update for device %s from Neviweb API', this.device.name);
    }
  }

  private currentEpoch(): number {
    return Math.ceil((new Date()).getTime() / 1000);
  }

  private isValid(timestamp: number): boolean {
    return timestamp > this.currentEpoch() && timestamp !== undefined;
  }
}