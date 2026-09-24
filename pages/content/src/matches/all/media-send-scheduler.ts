class DeferredMediaSendScheduler<T extends object> {
  private readonly timers = new Map<T, ReturnType<typeof setTimeout>>();
  private readonly identities = new WeakMap<T, number>();
  private nextIdentity = 1;

  constructor(private readonly delayMs: number) {}

  identity(owner: T): number {
    const existing = this.identities.get(owner);
    if (existing !== undefined) return existing;
    const identity = this.nextIdentity++;
    this.identities.set(owner, identity);
    return identity;
  }

  schedule(owner: T, send: () => void): void {
    this.cancel(owner);
    const timer = setTimeout(() => {
      this.timers.delete(owner);
      send();
    }, this.delayMs);
    this.timers.set(owner, timer);
  }

  cancel(owner: T): void {
    const timer = this.timers.get(owner);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(owner);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export { DeferredMediaSendScheduler };
