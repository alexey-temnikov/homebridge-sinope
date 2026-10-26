import type { Logger } from 'homebridge';
import { NeviwebRestClient } from './rest-client';
import { SinopePlatformConfig } from './config';
import { SinopeDevice, SinopeDeviceState, SinopeDeviceStateRequest } from './types';
export class NeviwebApi {
  private readonly restClient: NeviwebRestClient;
  constructor(private readonly config: SinopePlatformConfig, log: Logger) { this.restClient = new NeviwebRestClient(config, log); }
  login(): Promise<boolean> { return this.restClient.login(); }
  logout(): Promise<boolean> { return this.restClient.logout(); }
  async fetchDevices(): Promise<SinopeDevice[]> {
    const location = this.config.locationid;
    const data = await this.restClient.request<unknown>({
      path: '/devices' + (location === undefined || location === '' ? '' : `?location$id=${encodeURIComponent(location)}`),
    });
    if (!Array.isArray(data)) { throw new Error('Invalid Neviweb device list'); }
    return data.filter((d): d is SinopeDevice => d && Number.isSafeInteger(d.id) && d.id > 0 &&
      typeof d.identifier === 'string' && d.identifier.length > 0 && typeof d.name === 'string' && typeof d.sku === 'string');
  }
  fetchDevice(id: number, attributes: string): Promise<SinopeDeviceState> {
    return this.restClient.request({ path: `/device/${id}/attribute?attributes=${attributes}` });
  }
  fetchThermostat(id: number, zigbee = false): Promise<SinopeDeviceState> {
    return this.fetchDevice(id, `roomTemperature,outputPercentDisplay,${zigbee ? 'systemMode' : 'setpointMode'},alarmsActive0,roomSetpoint`);
  }
  fetchSwitch(id: number): Promise<SinopeDeviceState> { return this.fetchDevice(id, 'onOff'); }
  fetchDimmer(id: number): Promise<SinopeDeviceState> { return this.fetchDevice(id, 'onOff,intensity'); }
  updateDevice(id: number, data: SinopeDeviceStateRequest): Promise<unknown> {
    return this.restClient.request({ path: `/device/${id}/attribute`, method: 'PUT', data });
  }
}
