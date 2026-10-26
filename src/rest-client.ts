import type { Logger } from 'homebridge';
import { SinopePlatformConfig } from './config';
export class NeviwebError extends Error {
  constructor(public readonly code: string) { super(`Neviweb request failed (${code})`); }
}
export class NeviwebRestClient {
  private access = '';
  private refresh = '';
  private expiresAt = 0;
  private retryAfter = 0;
  private authentication?: Promise<void>;
  private stopped = false;
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(private readonly config: SinopePlatformConfig, private readonly log: Logger) {
    const url = new URL(config.url || 'https://neviweb.com/api');
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('Neviweb API URL must use HTTPS without embedded credentials, query, or fragment');
    }
    this.url = url.href.replace(/\/$/, '');
    const timeout = config.requestTimeoutMs ?? 3500;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3500) { throw new Error('requestTimeoutMs must be between 100 and 3500'); }
    this.timeoutMs = timeout;
  }
  private async send(path: string, method: string, data?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    try {
      const response = await fetch(this.url + path, {
        method, headers: { 'content-type': 'application/json', ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      if (!response.ok) { throw new NeviwebError(`HTTP_${response.status}`); }
      const body = await response.json();
      if (!body || typeof body !== 'object') { throw new NeviwebError('INVALID_RESPONSE'); }
      if (body.error) {
        const code = typeof body.error === 'object' ? body.error.code : body.error;
        const known = ['ACCSESSEXC', 'USRLOCKED', 'USRMAXLOGRETRY', 'USRSESSEXP', 'ACCDENIED'];
        throw new NeviwebError(known.includes(code) ? code : 'API_ERROR');
      }
      return body;
    } catch (error) {
      // Transport errors can contain credentials/headers; expose only safe codes.
      if (error instanceof NeviwebError) { throw error; }
      throw new NeviwebError(error instanceof Error && /Timeout|Abort/.test(error.name) ? 'TIMEOUT' : 'TRANSPORT_OR_RESPONSE');
    }
  }
  private setSession(value: unknown): void {
    const data = value as Record<string, unknown>;
    if (typeof data.session !== 'string' || !data.session) { throw new NeviwebError('INVALID_SESSION'); }
    this.access = data.session;
    this.refresh = typeof data.refreshToken === 'string' ? data.refreshToken : '';
    // API iat may use seconds, milliseconds or a string; use receipt time instead.
    this.expiresAt = Date.now() + 9.5 * 60 * 1000;
    this.retryAfter = 0;
  }
  private async ensureSession(): Promise<void> {
    if (this.stopped) { throw new NeviwebError('SHUTDOWN'); }
    if (this.access && Date.now() < this.expiresAt) { return; }
    if (this.authentication) { return this.authentication; }
    if (Date.now() < this.retryAfter) { throw new NeviwebError('AUTH_BACKOFF'); }
    const pending = (async () => {
      try {
        if (this.refresh) {
          try {
            this.setSession(await this.send('/connect', 'POST', undefined, { refreshToken: this.refresh }));
            return;
          } catch (error) {
            if (error instanceof NeviwebError && ['USRSESSEXP', 'HTTP_401', 'HTTP_403'].includes(error.code)) { this.refresh = ''; this.access = ''; }
            throw error; // Back off before falling back to a fresh credential login.
          }
        }
        if (!this.config.username || !this.config.password) { throw new NeviwebError('MISSING_CREDENTIALS'); }
        this.setSession(await this.send('/login', 'POST', {
          username: this.config.username, password: this.config.password, interface: 'neviweb', stayConnected: 1,
        }));
      } catch (error) {
        const lockout = error instanceof NeviwebError && ['ACCSESSEXC', 'USRLOCKED', 'USRMAXLOGRETRY'].includes(error.code);
        this.retryAfter = Date.now() + (lockout ? 10 * 60 * 1000 : 60 * 1000);
        throw error;
      }
    })();
    this.authentication = pending;
    try { await pending; }
    finally { if (this.authentication === pending) { this.authentication = undefined; } }
  }
  async login(): Promise<boolean> {
    try { await this.ensureSession(); return true; }
    catch (error) {
      this.log.error('Could not authenticate to Neviweb (%s); retries are backed off.',
        error instanceof NeviwebError ? error.code : 'AUTH_ERROR');
      return false;
    }
  }
  async request<T>(options: { path: string; method?: 'GET' | 'PUT'; data?: unknown }): Promise<T> {
    if (!options.path.startsWith('/') || options.path.startsWith('//')) { throw new NeviwebError('INVALID_PATH'); }
    await this.ensureSession();
    if (this.stopped) { throw new NeviwebError('SHUTDOWN'); }
    try {
      return await this.send(options.path, options.method || 'GET', options.data, { 'session-id': this.access }) as T;
    } catch (error) {
      if (error instanceof NeviwebError && ['USRSESSEXP', 'HTTP_401', 'HTTP_403'].includes(error.code)) { this.expiresAt = 0; }
      // Never replay a failed PUT: it may already have reached the device.
      throw error;
    }
  }
  async logout(): Promise<boolean> {
    this.stopped = true;
    await this.authentication?.catch(() => undefined);
    if (!this.access) { return true; }
    try {
      const response = await this.send('/logout', 'GET', undefined, { 'session-id': this.access, refreshToken: this.refresh });
      return (response as { success?: boolean }).success === true;
    } catch { return false; }
    finally { this.access = ''; this.refresh = ''; this.expiresAt = 0; }
  }
}
