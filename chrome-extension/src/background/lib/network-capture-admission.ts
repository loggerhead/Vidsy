type NetworkResponse = { tabId: number };

type NetworkCaptureAdmissionOptions<T extends NetworkResponse> = {
  /** Resolves after the service worker has restored the initial active tab. */
  bootstrap: Promise<void>;
  /** Aligns navigation state before the response reads its capture generation. */
  prepareCapture: (tabId: number) => Promise<void>;
  isCapturing: (tabId: number) => boolean;
  handle: (details: T) => Promise<void>;
};

/**
 * Serializes the service worker's initial tab lookup with network admission.
 *
 * Chrome may wake the worker for an onResponseStarted event before the async
 * initial-tab lookup has populated TabWorkLifecycle. Dropping synchronously in
 * that window loses one-shot authority requests such as an HLS master manifest.
 * Waiting here retains the event details, then applies the normal tab-scoped
 * capture policy once bootstrap has established the source of truth.
 */
export const createNetworkCaptureAdmission =
  <T extends NetworkResponse>({ bootstrap, prepareCapture, isCapturing, handle }: NetworkCaptureAdmissionOptions<T>) =>
  async (details: T): Promise<void> => {
    await bootstrap;
    await prepareCapture(details.tabId);
    if (!isCapturing(details.tabId)) return;
    await handle(details);
  };
