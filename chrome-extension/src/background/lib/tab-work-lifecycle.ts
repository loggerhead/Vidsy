type TabWork = {
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
  documentUrl?: string;
  initialNavigationPending: boolean;
  navigationInProgress: boolean;
  restartWhenReady: boolean;
  controller?: AbortController;
  captureReady: Promise<void>;
};

/** Owns page-bound work so a tab never runs two document generations at once. */
export const createTabWorkLifecycle = ({ start, stop }: TabWorkLifecycleOptions) => {
  const records = new Map<number, TabRecord>();

  const recordFor = (tabId: number) => {
    let record = records.get(tabId);
    if (!record) {
      record = {
        generation: 0,
        active: false,
        initialNavigationPending: false,
        navigationInProgress: false,
        restartWhenReady: false,
        captureReady: Promise.resolve(),
      };
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

  const beginNavigation = async (tabId: number, pageUrl?: string) => {
    const record = recordFor(tabId);
    if (record.navigationInProgress) return;
    if (pageUrl && record.documentUrl === pageUrl && record.restartWhenReady) return;
    // Chrome may report one navigation first as `loading` and then as a URL
    // change. The first event already owns the replacement generation.
    if (record.restartWhenReady) return;
    // A newly opened tab can become active while its first document is still
    // loading. Network responses admitted for that tab already belong to
    // generation 0; the first navigation notification confirms that same
    // document and must not invalidate those in-flight detections.
    if (record.initialNavigationPending) {
      record.initialNavigationPending = false;
      record.navigationInProgress = true;
      record.restartWhenReady = true;
      if (pageUrl) record.documentUrl = pageUrl;
      return;
    }
    const mustRestart = Boolean(record.controller) || record.active;
    record.navigationInProgress = true;
    record.generation += 1;
    record.restartWhenReady = mustRestart;
    if (pageUrl) record.documentUrl = pageUrl;
    // The new document owns network capture as soon as navigation starts.
    // Its requests may arrive long before `tabs.onUpdated(status=complete)`.
    // Hold their processing behind old-generation cleanup so the cleanup
    // cannot erase a newly detected item, while still retaining the early
    // webRequest event and its response headers.
    const cleanup = stopCurrent(tabId, record);
    record.captureReady = cleanup;
    await cleanup;
  };

  return {
    async activate(tabId: number, pageReady: boolean, pageUrl?: string) {
      const record = recordFor(tabId);
      record.active = true;
      if (pageUrl) record.documentUrl = pageUrl;
      if (!pageReady && !record.controller) record.initialNavigationPending = true;
      if (pageReady) await startCurrent(tabId, record);
    },

    async navigationStarted(tabId: number, pageUrl?: string) {
      await beginNavigation(tabId, pageUrl);
    },

    /**
     * webRequest can outrun tabs.onUpdated for a replacement document. Align
     * the lifecycle from the tab's loading state before detection reads a
     * generation, while keeping repeated response admission idempotent.
     */
    async prepareCapture(tabId: number, pageLoading: boolean, pageUrl?: string, pageActive = false) {
      const record = recordFor(tabId);
      // Admission may inspect responses from any tab. Only Chrome's current
      // active-tab fact may establish capture; seeing a response is not proof
      // that the tab belongs to this lifecycle.
      if (!record.active) {
        if (!pageActive) return;
        record.active = true;
        record.initialNavigationPending = pageLoading;
        if (pageUrl) record.documentUrl = pageUrl;
        // A fast document can reach `complete` before either activation or the
        // response is admitted. Restore its page work here because the earlier
        // tabs.onUpdated(complete) notification cannot be replayed.
        if (!pageLoading) await startCurrent(tabId, record);
      }
      const replacementUrl = Boolean(pageUrl && record.documentUrl && pageUrl !== record.documentUrl);
      if (!pageLoading && !replacementUrl) return;
      await beginNavigation(tabId, pageUrl);
    },

    async pageReady(tabId: number) {
      const record = recordFor(tabId);
      if (!record.active && !record.restartWhenReady) return;
      await record.captureReady;
      record.navigationInProgress = false;
      record.restartWhenReady = false;
      record.initialNavigationPending = false;
      await startCurrent(tabId, record);
    },

    async close(tabId: number) {
      const record = records.get(tabId);
      if (!record) return;
      record.active = false;
      record.generation += 1;
      await stopCurrent(tabId, record);
      records.delete(tabId);
    },

    isRunning(tabId: number) {
      return records.get(tabId)?.controller !== undefined;
    },

    // Network capture and DOM-backed content work deliberately have distinct
    // readiness. A navigation's initial media request is valid immediately;
    // content scripts still wait until the replacement document is ready.
    isCapturing(tabId: number) {
      return records.get(tabId)?.active === true;
    },

    generationForCapture(tabId: number): number | undefined {
      const record = records.get(tabId);
      return record?.active ? record.generation : undefined;
    },

    async waitForCapture(tabId: number, generation: number): Promise<boolean> {
      const record = records.get(tabId);
      if (!record || !record.active || record.generation !== generation) return false;
      await record.captureReady;
      const current = records.get(tabId);
      return current?.active === true && current.generation === generation;
    },

    generationForRunning(tabId: number): number | undefined {
      const record = records.get(tabId);
      return record?.controller ? record.generation : undefined;
    },

    isCurrent(tabId: number, generation: number) {
      const record = records.get(tabId);
      return record?.generation === generation && record.active;
    },
  };
};

export type { TabWork };
export type TabWorkLifecycle = ReturnType<typeof createTabWorkLifecycle>;
