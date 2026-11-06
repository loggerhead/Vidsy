type Waiter = {
  key: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

// One queue shared by all jobs. Rotate between job keys, including jobs that
// queued after a large file filled its per-file connection window.
export class ResourceBudget {
  private active = 0;
  private lastKey = '';
  private waiting: Waiter[] = [];
  constructor(readonly limit: number) {}

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        key,
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiting = this.waiting.filter(entry => entry !== waiter);
          reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length) {
      const other = this.waiting.findIndex(entry => entry.key !== this.lastKey);
      const [entry] = this.waiting.splice(other < 0 ? 0 : other, 1);
      entry.signal?.removeEventListener('abort', entry.abort);
      this.lastKey = entry.key;
      this.active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}

export const downloadConnections = new ResourceBudget(8);
export const mergeSlots = new ResourceBudget(1);
