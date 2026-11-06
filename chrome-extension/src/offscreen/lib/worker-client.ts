// Typed RPC client around WXT's unlisted download worker (`download-worker.js`).
// The worker owns OPFS. This module is the only place that speaks the worker protocol.

import { rejectPendingWorkerJobs } from './pending-worker-jobs';
import { updateProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import type { ExecutableMuxPlan, PlanInput } from './media-processing';
import type {
  FetchRangesRequest,
  FetchUrlRequest,
  MuxRequest,
  ProgressUpdate,
  SegmentSpec,
  WorkerRequest,
  WorkerResponse,
} from '../download_worker/messages';

// Storage is dynamically imported so its module-level createStorage calls
// (which can throw in some offscreen contexts when chrome.storage is being
// looked up by bracket access against a session storage area) can't break
// the entire offscreen module's load. The actual resume / connection-count
// reads run on first download, well after module init.

let worker: Worker | null = null;
let jobCounter = 0;

const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('download-worker.js'), { type: 'module' });
  }
  return worker;
};

const nextJobId = (): string => `j${++jobCounter}_${Date.now().toString(36)}`;

type PendingJob = {
  resolve: (totalBytes: number) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: ProgressUpdate) => void;
  reportProgress: boolean;
};
type PendingFile = {
  resolve: (file: File) => void;
  reject: (err: Error) => void;
};
type PendingAck = {
  resolve: () => void;
  reject: (err: Error) => void;
};
type PendingMux = {
  resolve: (result: { outputOpfsName: string; totalBytes: number }) => void;
  reject: (err: Error) => void;
};

const pendingFetch = new Map<string, PendingJob>();
const pendingFile = new Map<string, PendingFile>();
const pendingAck = new Map<string, PendingAck>();
const pendingMux = new Map<string, PendingMux>();

const rejectAllPending = (error: Error): void => {
  worker?.terminate();
  rejectPendingWorkerJobs(error, [pendingFetch, pendingFile, pendingAck, pendingMux]);
  worker = null;
};

let listenerWorker: Worker | null = null;
const ensureListener = (): void => {
  const activeWorker = getWorker();
  if (listenerWorker === activeWorker) return;
  listenerWorker = activeWorker;
  activeWorker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'diagnostic':
        void chrome.runtime.sendMessage({ type: 'offscreen/download-diagnostic', payload: msg }).catch(() => undefined);
        return;
      case 'authorize-url':
        void chrome.runtime
          .sendMessage({
            type: 'offscreen/authorize-download-url',
            payload: { key: msg.jobKey, url: msg.url, transient: true },
          })
          .then(
            response => {
              activeWorker.postMessage({
                type: 'url-authorized',
                authorizationId: msg.authorizationId,
                downloadKey: response.downloadKey,
                url: response.url,
                error: response.ok ? undefined : response.error,
              });
            },
            error =>
              activeWorker.postMessage({
                type: 'url-authorized',
                authorizationId: msg.authorizationId,
                error: String(error),
              }),
          );
        return;
      case 'release-url':
        void chrome.runtime
          .sendMessage({ type: 'offscreen/release-download-url', payload: msg })
          .catch(() => undefined);
        return;
      case 'progress': {
        const {
          jobKey,
          stage,
          downloadedBytes,
          estimatedBytes,
          muxPercent,
          chunks,
          activity,
          completedParts,
          totalParts,
        } = msg as ProgressUpdate;
        const pending = pendingFetch.get(msg.jobId);
        if (!pending && !pendingMux.has(msg.jobId)) return;
        pending?.onProgress?.(msg);
        if (pending?.reportProgress !== false) {
          void updateProgress(jobKey, {
            stage,
            downloadedBytes,
            estimatedBytes,
            muxPercent,
            chunks,
            activity,
            completedParts,
            totalParts,
          });
        }
        return;
      }
      case 'fetch-done': {
        const p = pendingFetch.get(msg.jobId);
        if (p) {
          pendingFetch.delete(msg.jobId);
          p.resolve(msg.totalBytes);
        }
        return;
      }
      case 'mux-done': {
        const p = pendingMux.get(msg.jobId);
        if (p) {
          pendingMux.delete(msg.jobId);
          p.resolve({ outputOpfsName: msg.outputOpfsName, totalBytes: msg.totalBytes });
        }
        return;
      }
      case 'get-file-done': {
        const p = pendingFile.get(msg.jobId);
        if (p) {
          pendingFile.delete(msg.jobId);
          p.resolve(msg.file);
        }
        return;
      }
      case 'remove-done': {
        const p = pendingAck.get(msg.jobId);
        if (p) {
          pendingAck.delete(msg.jobId);
          p.resolve();
        }
        return;
      }
      case 'error': {
        const err = new Error(msg.error);
        const f = pendingFetch.get(msg.jobId);
        if (f) {
          pendingFetch.delete(msg.jobId);
          f.reject(err);
          return;
        }
        const g = pendingFile.get(msg.jobId);
        if (g) {
          pendingFile.delete(msg.jobId);
          g.reject(err);
          return;
        }
        const a = pendingAck.get(msg.jobId);
        if (a) {
          pendingAck.delete(msg.jobId);
          a.reject(err);
          return;
        }
        const m = pendingMux.get(msg.jobId);
        if (m) {
          pendingMux.delete(msg.jobId);
          m.reject(err);
        }
        return;
      }
      case 'pong':
        return;
    }
  });
  activeWorker.addEventListener('error', event => {
    if (worker !== activeWorker) return;
    listenerWorker = null;
    rejectAllPending(new Error(event.message || 'Download worker terminated unexpectedly'));
  });
  activeWorker.addEventListener('messageerror', () => {
    if (worker !== activeWorker) return;
    listenerWorker = null;
    rejectAllPending(new Error('Download worker returned an unreadable message'));
  });
};

const send = (req: WorkerRequest): void => {
  if ('jobKey' in req && req.type !== 'cancel') activeAbortControllers.get(req.jobKey)?.signal.throwIfAborted();
  ensureListener();
  getWorker().postMessage(req);
};

const fetchSegmentsToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  segments: SegmentSpec[];
  initUrl?: string;
  initRange?: { start: number; end: number };
  keyHeaders?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
      reportProgress: true,
    });
    void readMaxConnections()
      .then(maxConnections => {
        send({ type: 'fetch-segments', jobId, ...args, maxConnections });
      })
      .catch(error => {
        pendingFetch.delete(jobId);
        reject(error);
      });
  });

const readMaxConnections = async (): Promise<number> => {
  try {
    const { mediaSettingsStorage } = await import('@extension/storage');
    const s = await mediaSettingsStorage.get();
    return Math.max(1, Math.min(16, Math.floor(s.downloadConnectionsPerFile ?? 8)));
  } catch {
    return 8;
  }
};

const fetchRangesToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  url: string;
  keyHeaders?: Record<string, string>;
  ranges: { start: number; end: number }[];
  totalBytes: number;
  resourceVersion?: string;
  stage: 'download-video' | 'download-audio';
  maxConnections?: number;
  onProgress?: (progress: ProgressUpdate) => void;
  reportProgress?: boolean;
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
      onProgress: args.onProgress,
      reportProgress: args.reportProgress !== false,
    });
    void readMaxConnections()
      .then(configuredMaxConnections => {
        const maxConnections = Math.max(1, Math.min(16, Math.floor(args.maxConnections ?? configuredMaxConnections)));
        const req: FetchRangesRequest = {
          type: 'fetch-ranges',
          jobId,
          jobKey: args.jobKey,
          opfsName: args.opfsName,
          url: args.url,
          keyHeaders: args.keyHeaders,
          ranges: args.ranges,
          totalBytes: args.totalBytes,
          stage: args.stage,
          resourceVersion: args.resourceVersion,
          maxConnections,
        };
        send(req);
      })
      .catch(error => {
        pendingFetch.delete(jobId);
        reject(error);
      });
  });

const fetchUrlToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  url: string;
  keyHeaders?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
  onProgress?: (progress: ProgressUpdate) => void;
  reportProgress?: boolean;
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
      onProgress: args.onProgress,
      reportProgress: args.reportProgress !== false,
    });
    const req: FetchUrlRequest = {
      type: 'fetch-url',
      jobId,
      jobKey: args.jobKey,
      opfsName: args.opfsName,
      url: args.url,
      keyHeaders: args.keyHeaders,
      stage: args.stage,
    };
    send(req);
  });

const getOpfsFile = (opfsName: string): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    send({ type: 'get-file', jobId, opfsName });
  });

const writeBytesToOpfs = (opfsName: string, bytes: ArrayBuffer): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    ensureListener();
    getWorker().postMessage({ type: 'write-bytes', jobId, opfsName, bytes }, [bytes]);
  });

const removeOpfs = (opfsName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingAck.set(jobId, { resolve, reject });
    send({ type: 'remove', jobId, opfsName });
  });

const cancelWorkerJob = (jobKey: string): void => {
  send({ type: 'cancel', jobKey });
};

// A small runtime probe used by the production-extension smoke check. It
// verifies that the URL emitted by WXT creates a module worker and that the
// worker's message channel is usable before a download needs it.
const pingDownloadWorker = (timeoutMs = 5_000): Promise<void> =>
  new Promise((resolve, reject) => {
    ensureListener();
    const activeWorker = getWorker();

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type !== 'pong') return;
      cleanup();
      resolve();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'Download worker failed during startup'));
    };

    activeWorker.addEventListener('message', onMessage);
    activeWorker.addEventListener('error', onError, { once: true });
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Download worker did not respond within ${timeoutMs}ms`));
    }, timeoutMs);
    activeWorker.postMessage({ type: 'ping' });
  });

const muxInWorker = (args: {
  jobKey: string;
  outputOpfsName: string;
  plan: ExecutableMuxPlan;
  input: PlanInput;
  durationSeconds?: number;
  estimatedBytes?: number;
}): Promise<{ outputOpfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingMux.set(jobId, { resolve, reject });
    const req: MuxRequest = {
      type: 'mux',
      jobId,
      jobKey: args.jobKey,
      outputOpfsName: args.outputOpfsName,
      plan: args.plan,
      input: args.input,
      stage: 'mux',
      durationSeconds: args.durationSeconds,
      estimatedBytes: args.estimatedBytes,
    };
    send(req);
  });

export {
  fetchSegmentsToOpfs,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  writeBytesToOpfs,
  removeOpfs,
  cancelWorkerJob,
  pingDownloadWorker,
  muxInWorker,
  readMaxConnections,
};
