import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SinopeAccessory } from './platformAccessory';
import { SinopePlatformConfig } from './config';
import { NeviwebApi } from './neviweb';
import { deviceKind } from './types';

export class SinopePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly neviweb: NeviwebApi;
  private readonly handlers = new Map<string, SinopeAccessory>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(public readonly log: Logger, public readonly config: PlatformConfig & SinopePlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    if (!Number.isInteger(config.pollInterval ?? 60) || (config.pollInterval ?? 60) < 30 || (config.pollInterval ?? 60) > 3600) {
      throw new Error('pollInterval must be between 30 and 3600 seconds');
    }
    this.neviweb = new NeviwebApi(config, log);
    api.on('didFinishLaunching', () => { void this.startDiscovery(); });
    api.on('shutdown', () => { void this.shutdown(); });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (!this.accessories.some(a => a.UUID === accessory.UUID)) { this.accessories.push(accessory); }
    const device = accessory.context.device;
    // Restore read handlers even if the cloud is unavailable at launch.
    if (device && deviceKind(device) && !this.stopped) {
      this.handlers.set(accessory.UUID, new SinopeAccessory(this, accessory, device, deviceKind(device)));
    }
  }

  private async startDiscovery(): Promise<void> {
    try { await this.discoverDevices(); }
    catch {
      this.log.error('Sinopé discovery unavailable; keeping cached accessories and retrying in 60 seconds.');
      if (!this.stopped) {
        this.retry = setTimeout(() => { this.retry = undefined; void this.startDiscovery(); }, 60000);
        this.retry.unref();
      }
    }
  }

  async discoverDevices(): Promise<void> {
    if (this.stopped) { return; }
    if (!await this.neviweb.login()) { throw new Error('Neviweb authentication unavailable'); }
    const devices = await this.neviweb.fetchDevices();
    if (this.stopped) { return; }
    const seen = new Set<string>();
    for (const device of devices) {
      const kind = deviceKind(device);
      if (!kind) { continue; }
      // Same identifier and UUID algorithm as the deployed plugin.
      const uuid = this.api.hap.uuid.generate(device.identifier);
      if (seen.has(uuid)) { continue; }
      seen.add(uuid);
      const existing = this.accessories.find(a => a.UUID === uuid);
      const accessory = existing || new this.api.platformAccessory(device.name, uuid);
      const unchanged = JSON.stringify(accessory.context.device) === JSON.stringify(device);
      accessory.context.device = device;
      if (!unchanged || !this.handlers.has(uuid)) {
        this.handlers.get(uuid)?.dispose();
        this.handlers.set(uuid, new SinopeAccessory(this, accessory, device, kind));
      }
      if (existing) { this.api.updatePlatformAccessories([accessory]); }
      else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    }
    // Never delete cached devices on a transient or partial cloud response.
    this.log.info('Sinopé discovery complete: %d supported devices.', seen.size);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) { return; }
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    for (const handler of this.handlers.values()) { handler.dispose(); }
    try { await this.neviweb.logout(); }
    catch { this.log.debug('Sinopé session could not be closed during shutdown.'); }
  }
}
