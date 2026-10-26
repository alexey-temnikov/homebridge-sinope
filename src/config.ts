export interface SinopePlatformConfig {
  url?: string;
  username?: string;
  password?: string;
  locationid?: number | string;
  requestTimeoutMs?: number;
  pollInterval?: number;
}
