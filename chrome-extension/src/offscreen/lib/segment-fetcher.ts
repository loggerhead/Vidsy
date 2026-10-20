// Offscreen I/O controls only. Durable task state lives in DownloadRuntime;
// media fetching is implemented exclusively by the download worker.
export const activeAbortControllers = new Map<string, AbortController>();
export const downloadStopIntents = new Map<string, 'pause' | 'cancel'>();
