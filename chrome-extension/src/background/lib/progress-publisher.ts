// Ordinary byte reports share a bounded cadence. Stage changes and terminal
// reports flush older progress first, preserving lifecycle order.
export const createProgressPublisher = <T>(apply: (message: T) => Promise<void>, interval = 500) => {
  type Pending = {
    message: T;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: unknown) => void;
    promise: Promise<void>;
  };
  const pending = new Map<string, Pending>();
  const last = new Map<string, { at: number; stage: string }>();
  const flush = async (key: string): Promise<void> => {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    try {
      await apply(entry.message);
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    }
    return entry.promise;
  };
  return {
    async publish(key: string, stage: string, message: T, terminal = false): Promise<void> {
      const prior = last.get(key);
      if (terminal || !prior || prior.stage !== stage || Date.now() - prior.at >= interval) {
        await flush(key);
        await apply(message);
        if (terminal) last.delete(key);
        else last.set(key, { at: Date.now(), stage });
        return;
      }
      const existing = pending.get(key);
      if (existing) {
        existing.message = message;
        return existing.promise;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(
        () => {
          last.set(key, { at: Date.now(), stage });
          void flush(key).catch(() => undefined);
        },
        interval - (Date.now() - prior.at),
      );
      pending.set(key, { message, timer, resolve, reject, promise });
      return promise;
    },
  };
};
