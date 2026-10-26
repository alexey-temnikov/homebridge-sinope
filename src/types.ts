export interface SinopeDevice {
  id: number;
  identifier: string;
  name: string;
  parentDevice$id?: number | null;
  sku: string;
  vendor: string;
}
export interface SinopeDeviceState {
  roomTemperature?: { value: number };
  roomSetpoint?: number;
  outputPercentDisplay?: number | { percent: number };
  setpointMode?: string;
  systemMode?: string;
  onOff?: string;
  intensity?: number;
}
export interface SinopeDeviceStateRequest {
  roomSetpoint?: number;
  setpointMode?: string;
  systemMode?: string;
  onOff?: string;
  intensity?: number;
}
export type DeviceKind = 'thermostat' | 'switch' | 'outlet' | 'dimmer';
export function deviceKind(device: SinopeDevice): DeviceKind | undefined {
  if (device.parentDevice$id === null || typeof device.sku !== 'string') { return undefined; }
  if (/^(TH|OTH)/.test(device.sku)) { return 'thermostat'; }
  if (/^(SW|RM)/.test(device.sku)) { return 'switch'; }
  if (/^SP/.test(device.sku)) { return 'outlet'; }
  if (/^DM/.test(device.sku)) { return 'dimmer'; }
  return undefined;
}
