/** Share one refresh across simultaneous HomeKit reads, without lock waiters. */
export class StateCache<T> {
  private value?: T;
  private validUntil = 0;
  private generation = 0;
  private pending?: Promise<T>;
  private pendingGeneration = 0;
  private retryAfter = 0;
  constructor(private readonly load: () => Promise<T>, private readonly ttlMs = 10000) {}
  invalidate(): void { this.generation++; this.validUntil = 0; this.retryAfter = 0; }
  async get(): Promise<T> {
    if (this.pending) {
      if (this.pendingGeneration !== this.generation) {
        await this.pending.catch(() => undefined);
        return this.get();
      }
      return this.pending;
    }
    if (this.value !== undefined && Date.now() < this.validUntil) { return this.value; }
    if (Date.now() < this.retryAfter) { throw new Error('Device temporarily unavailable'); }
    const generation = this.generation;
    this.pendingGeneration = generation;
    const pending = Promise.resolve().then(this.load).then(value => {
      if (generation === this.generation) { this.value = value; this.validUntil = Date.now() + this.ttlMs; }
      return value;
    }).catch(error => {
      if (generation === this.generation) { this.retryAfter = Date.now() + 5000; }
      throw error;
    });
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) { this.pending = undefined; } }
  }
}
/** Serialize writes per device; expired queued commands must never reach the API. */
export class CommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private size = 0;
  async run<T>(operation: () => Promise<T>, maxWaitMs = 1000): Promise<T> {
    if (this.size >= 8) { throw new Error('Too many pending device commands'); }
    this.size++;
    const deadline = Date.now() + maxWaitMs;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = this.tail.then(() => {
      if (expired || Date.now() > deadline) { throw new Error('Device command expired before execution'); }
      if (timer) { clearTimeout(timer); }
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined).finally(() => { this.size--; });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Device command expired before execution')); }, maxWaitMs);
    });
    try { return await Promise.race([result, timeout]); }
    finally { if (timer) { clearTimeout(timer); } }
  }
}
