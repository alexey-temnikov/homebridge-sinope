import * as dgram from "dgram";

export interface SinopeDevice {
  id: number;
  identifier: string;
  name: string;
  parentDevice$id?: number;
  sku: string;
  vendor: string;
}

export interface SinopeDeviceState {
  roomTemperature?: RootTemperature;
  roomSetpoint?: number;
  outputPercentDisplay?: number;
  setpointMode?: string;
  onOff?: string;
  wattageInstant?: number;
  errorCodeSet1?: any;
  drStatus?: any;
}

export interface SinopeDeviceStateRequest {
  roomSetpoint?: number;
  setpointMode?: string;
  onOff?: string;
}

export interface RootTemperature {
  value: number;
}