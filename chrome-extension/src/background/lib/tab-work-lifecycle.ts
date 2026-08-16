export type TabWork = {
  tabId: number;
  generation: number;
  signal: AbortSignal;
};

type TabWorkLifecycleOptions = {
  start: (work: TabWork) => Promise<void>;
  stop: (work: TabWork) => Promise<void>;
};

type TabRecord = {
  generation: number;
  active: boolean;
  restartWhenReady: boolean;
  controller?: AbortController;
};

/** Owns page-bound work so a tab never runs two document generations at once. */
export const createTabWorkLifecycle = ({ start, stop }: TabWorkLifecycleOptions) => {
  const records = new Map<number, TabRecord>();

  const recordFor = (tabId: number) => {
    let record = records.get(tabId);
    if (!record) {
      record = { generation: 0, active: false, restartWhenReady: false };
      records.set(tabId, record);
    }
    return record;
  };

  const stopCurrent = async (tabId: number, record: TabRecord) => {
    const controller = record.controller;
    if (!controller) return;
    record.controller = undefined;
    controller.abort();
    await stop({ tabId, generation: record.generation, signal: controller.signal });
  };

  const startCurrent = async (tabId: number, record: TabRecord) => {
    if (record.controller) return;
    const controller = new AbortController();
    record.controller = controller;
    await start({ tabId, generation: record.generation, signal: controller.signal });
  };

  return {
    async activate(tabId: number, pageReady: boolean) {
      const record = recordFor(tabId);
      record.active = true;
      if (pageReady) await startCurrent(tabId, record);
    },

    async navigationStarted(tabId: number) {
      const record = recordFor(tabId);
      // Chrome may report one navigation first as `loading` and then as a URL
      // change. The first event already owns the replacement generation.
      if (record.restartWhenReady) return;
      const mustRestart = Boolean(record.controller) || record.active;
      record.generation += 1;
      record.restartWhenReady = mustRestart;
      await stopCurrent(tabId, record);
    },

    async pageReady(tabId: number) {
      const record = recordFor(tabId);
      if (!record.active && !record.restartWhenReady) return;
      record.restartWhenReady = false;
      await startCurrent(tabId, record);
    },

    async close(tabId: number) {
      const record = records.get(tabId);
      if (!record) return;
      record.generation += 1;
      await stopCurrent(tabId, record);
      records.delete(tabId);
    },

    isRunning(tabId: number) {
      return records.get(tabId)?.controller !== undefined;
    },

    generationForRunning(tabId: number): number | undefined {
      const record = records.get(tabId);
      return record?.controller ? record.generation : undefined;
    },

    isCurrent(tabId: number, generation: number) {
      const record = records.get(tabId);
      return record?.generation === generation && record.controller !== undefined;
    },
  };
};

export type TabWorkLifecycle = ReturnType<typeof createTabWorkLifecycle>;
