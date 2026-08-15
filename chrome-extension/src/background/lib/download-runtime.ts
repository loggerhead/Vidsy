/* eslint-disable import-x/exports-last */

/**
 * Durable lifecycle authority for media downloads.
 *
 * This module deliberately knows nothing about Chrome APIs or media execution.
 * Adapters supply persistence, executor inventory/commands, and browser
 * delivery events. Recreating the runtime object must therefore be safe: the
 * store is the authority, while all indexes in this module are disposable.
 */

export const DOWNLOAD_RUNTIME_SCHEMA_VERSION = 1 as const;

export type DownloadState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type DownloadPhase = 'idle' | 'fetching' | 'processing' | 'delivering';

export type DownloadExecutionSpec = {
  url: string;
  kind: string;
  outputFormat: 'mp4' | 'mp3';
  fileName?: string;
  audioUrl?: string;
  audioMimeType?: string;
  headers?: Record<string, string>;
};

export type DownloadDisplay = {
  title?: string;
  itemId?: string;
  pageUrl?: string;
};

export type DownloadSubmission = {
  requestId: string;
  execution: DownloadExecutionSpec;
  display?: DownloadDisplay;
};

export type DownloadDiagnostic = {
  at: number;
  event: string;
  previousState?: DownloadState;
  nextState?: DownloadState;
  attempt?: number;
  executionId?: string;
  reason?: string;
};

export type DownloadJob = {
  jobId: string;
  requestId: string;
  execution: DownloadExecutionSpec;
  display: DownloadDisplay;
  state: DownloadState;
  phase: DownloadPhase;
  queueOrder: number;
  attempt: number;
  executionId?: string;
  progress: {
    downloadedBytes: number;
    estimatedBytes?: number;
    percent?: number;
  };
  terminal?: { reason?: string; downloadId?: number };
  downloadId?: number;
  pauseRequested?: boolean;
  createdAt: number;
  updatedAt: number;
  diagnostics: DownloadDiagnostic[];
};

type PersistedRuntime = {
  schemaVersion: typeof DOWNLOAD_RUNTIME_SCHEMA_VERSION;
  nextJobNumber: number;
  nextQueueOrder: number;
  jobs: Record<string, DownloadJob>;
};

export type DownloadRuntimeStore = {
  read: () => Promise<PersistedRuntime | undefined>;
  write: (state: PersistedRuntime) => Promise<void>;
};

export type ExecutorInventory = {
  executions: Array<{
    jobId: string;
    requestId: string;
    attempt: number;
    executionId: string;
    acknowledged: boolean;
  }>;
};

export type ExecutorCommand = {
  jobId: string;
  requestId: string;
  attempt: number;
  executionId: string;
  execution: DownloadExecutionSpec;
};

export type ExecutorAdapter = {
  start?: (command: ExecutorCommand) => Promise<void>;
  cancel?: (identity: ExecutionIdentity & { requestId: string }) => Promise<void>;
  inventory?: () => Promise<ExecutorInventory>;
};

type ExecutionIdentity = {
  jobId: string;
  attempt: number;
  executionId: string;
};

export type ExecutorEvent = ExecutionIdentity &
  (
    | { type: 'acknowledged' }
    | { type: 'progress'; downloadedBytes: number; estimatedBytes?: number; percent?: number; phase?: DownloadPhase }
    | { type: 'artifact'; downloadId: number }
    | { type: 'cancelled' }
    | { type: 'failed'; reason: string }
  );

export type BrowserDeliveryEvent = {
  jobId: string;
  downloadId: number;
  state: 'complete' | 'interrupted';
  reason?: string;
};

export type DownloadCommand =
  | { type: 'cancel' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'retry' }
  | { type: 'clear-terminal' }
  | { type: 'reorder'; direction: 'up' | 'down' };

export type RuntimeSnapshot = {
  jobs: Array<DownloadJob & { queuePosition?: number }>;
  executorCommands: ExecutorCommand[];
};

export type DownloadRuntime = {
  submit: (submission: DownloadSubmission) => Promise<{ jobId: string; duplicate: boolean }>;
  command: (jobId: string, command: DownloadCommand) => Promise<boolean>;
  bootstrap: (inventory?: ExecutorInventory) => Promise<RuntimeSnapshot>;
  executorEvent: (event: ExecutorEvent) => Promise<boolean>;
  browserDelivery: (event: BrowserDeliveryEvent) => Promise<boolean>;
  snapshot: () => Promise<RuntimeSnapshot>;
};

type RuntimeOptions = {
  store: DownloadRuntimeStore;
  concurrency: number | (() => number | Promise<number>);
  executor?: ExecutorAdapter;
  now?: () => number;
  createExecutionId?: (job: DownloadJob) => string;
};

const terminalStates = new Set<DownloadState>(['succeeded', 'failed', 'cancelled', 'paused']);
const activeStates = new Set<DownloadState>(['starting', 'running', 'finalizing']);

const defaultState = (): PersistedRuntime => ({
  schemaVersion: DOWNLOAD_RUNTIME_SCHEMA_VERSION,
  nextJobNumber: 1,
  nextQueueOrder: 1,
  jobs: {},
});

const cloneState = (state: PersistedRuntime): PersistedRuntime => ({
  ...state,
  jobs: Object.fromEntries(
    Object.entries(state.jobs).map(([id, job]) => [id, { ...job, diagnostics: [...job.diagnostics] }]),
  ),
});

const normalizeConcurrency = (value: number): number => Math.max(1, Math.floor(value));

export const createDownloadRuntime = (options: RuntimeOptions): DownloadRuntime => {
  let operation = Promise.resolve();
  const commands: ExecutorCommand[] = [];
  const dispatchedExecutions = new Set<string>();
  const now = options.now ?? Date.now;
  const nextExecutionId = options.createExecutionId ?? (job => `${job.jobId}-a${job.attempt}-${now().toString(36)}`);

  const transact = async <T>(fn: (state: PersistedRuntime) => Promise<T> | T): Promise<T> => {
    const run = operation.then(async () => {
      const stored = (await options.store.read()) ?? defaultState();
      if (stored.schemaVersion !== DOWNLOAD_RUNTIME_SCHEMA_VERSION) throw new Error('incompatible persisted schema');
      const state = cloneState(stored);
      const result = await fn(state);
      await options.store.write(state);
      return result;
    });
    operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readSnapshot = async (): Promise<RuntimeSnapshot> => {
    const state = (await options.store.read()) ?? defaultState();
    const queued = Object.values(state.jobs)
      .filter(job => job.state === 'queued')
      .sort((a, b) => a.queueOrder - b.queueOrder);
    const positions = new Map(queued.map((job, index) => [job.jobId, index + 1]));
    return {
      jobs: Object.values(state.jobs)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(job => ({ ...job, queuePosition: positions.get(job.jobId) })),
      executorCommands: [...commands],
    };
  };

  const addDiagnostic = (job: DownloadJob, event: string, nextState?: DownloadState, reason?: string) => {
    job.diagnostics.push({
      at: now(),
      event,
      previousState: job.state,
      nextState,
      attempt: job.attempt,
      executionId: job.executionId,
      reason,
    });
    job.diagnostics = job.diagnostics.slice(-40);
  };

  const setState = (job: DownloadJob, state: DownloadState, event: string, reason?: string) => {
    const previous = job.state;
    job.state = state;
    job.updatedAt = now();
    addDiagnostic({ ...job, state: previous }, event, state, reason);
  };

  const identityMatches = (job: DownloadJob, identity: ExecutionIdentity): boolean =>
    job.jobId === identity.jobId &&
    job.state !== 'queued' &&
    job.executionId === identity.executionId &&
    job.attempt === identity.attempt;

  const schedule = async (state: PersistedRuntime) => {
    const configured = typeof options.concurrency === 'function' ? await options.concurrency() : options.concurrency;
    const capacity = normalizeConcurrency(configured);
    const claimed = Object.values(state.jobs).filter(job => activeStates.has(job.state)).length;
    const eligible = Object.values(state.jobs)
      .filter(job => job.state === 'queued')
      .sort((a, b) => a.queueOrder - b.queueOrder);
    for (const job of eligible.slice(0, Math.max(0, capacity - claimed))) {
      job.attempt += 1;
      job.executionId = nextExecutionId(job);
      job.phase = 'idle';
      setState(job, 'starting', 'claim');
      const command: ExecutorCommand = {
        jobId: job.jobId,
        requestId: job.requestId,
        attempt: job.attempt,
        executionId: job.executionId,
        execution: job.execution,
      };
      commands.push(command);
    }
  };

  const runtime: DownloadRuntime = {
    submit: submission =>
      transact(state => {
        const existing = Object.values(state.jobs).find(job => job.requestId === submission.requestId);
        if (existing) return { jobId: existing.jobId, duplicate: true };
        const timestamp = now();
        const jobId = `download-${state.nextJobNumber++}`;
        state.jobs[jobId] = {
          jobId,
          requestId: submission.requestId,
          execution: {
            ...submission.execution,
            headers: submission.execution.headers && { ...submission.execution.headers },
          },
          display: { ...submission.display },
          state: 'queued',
          phase: 'idle',
          queueOrder: state.nextQueueOrder++,
          attempt: 0,
          progress: { downloadedBytes: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
          diagnostics: [],
        };
        addDiagnostic(state.jobs[jobId], 'submitted', 'queued');
        return { jobId, duplicate: false };
      }),

    command: (jobId, command) =>
      transact(async state => {
        const job = state.jobs[jobId];
        if (!job) return false;
        if (command.type === 'clear-terminal') {
          if (!terminalStates.has(job.state) || job.state === 'paused') return false;
          delete state.jobs[jobId];
          return true;
        }
        if (command.type === 'cancel') {
          if (terminalStates.has(job.state)) return job.state === 'cancelled';
          job.pauseRequested = false;
          if (job.executionId && options.executor?.cancel)
            await options.executor.cancel({
              jobId: job.jobId,
              requestId: job.requestId,
              attempt: job.attempt,
              executionId: job.executionId,
            });
          setState(job, 'cancelled', 'cancel');
          return true;
        }
        if (command.type === 'pause') {
          if (!activeStates.has(job.state)) return job.state === 'paused';
          job.pauseRequested = true;
          if (job.executionId && options.executor?.cancel)
            await options.executor.cancel({
              jobId: job.jobId,
              requestId: job.requestId,
              attempt: job.attempt,
              executionId: job.executionId,
            });
          addDiagnostic(job, 'pause-requested');
          return true;
        }
        if (command.type === 'resume' || command.type === 'retry') {
          const allowed = command.type === 'resume' ? job.state === 'paused' : job.state === 'failed';
          if (!allowed) return false;
          job.pauseRequested = false;
          job.executionId = undefined;
          job.downloadId = undefined;
          job.terminal = undefined;
          job.queueOrder = state.nextQueueOrder++;
          setState(job, 'queued', command.type);
          return true;
        }
        if (command.type === 'reorder') {
          if (job.state !== 'queued') return false;
          const queued = Object.values(state.jobs)
            .filter(item => item.state === 'queued')
            .sort((a, b) => a.queueOrder - b.queueOrder);
          const index = queued.findIndex(item => item.jobId === jobId);
          const target = command.direction === 'up' ? index - 1 : index + 1;
          if (index < 0 || target < 0 || target >= queued.length) return false;
          const other = queued[target];
          [job.queueOrder, other.queueOrder] = [other.queueOrder, job.queueOrder];
          job.updatedAt = now();
          addDiagnostic(job, 'reorder');
          return true;
        }
        return false;
      }),

    bootstrap: async inventory => {
      const commandOffset = commands.length;
      await transact(async state => {
        const currentInventory =
          inventory ?? (options.executor?.inventory ? await options.executor.inventory() : { executions: [] });
        const present = new Map(currentInventory.executions.map(item => [item.executionId, item]));
        for (const job of Object.values(state.jobs)) {
          if (!activeStates.has(job.state) || !job.executionId) continue;
          const execution = present.get(job.executionId);
          if (execution) {
            if (execution.acknowledged && job.state === 'starting') setState(job, 'running', 'bootstrap-reattach');
          } else if (job.state === 'starting' || job.state === 'running') {
            job.executionId = undefined;
            job.pauseRequested = false;
            setState(job, 'queued', 'executor-absent', 'executor_unavailable');
          }
        }
        await schedule(state);
        return undefined;
      });
      if (options.executor?.start) {
        for (const command of commands.slice(commandOffset)) {
          if (dispatchedExecutions.has(command.executionId)) continue;
          dispatchedExecutions.add(command.executionId);
          await options.executor.start(command);
        }
      }
      return readSnapshot();
    },

    executorEvent: event =>
      transact(state => {
        const job = state.jobs[event.jobId];
        if (!job || !identityMatches(job, event)) {
          if (job) addDiagnostic(job, 'executor-event-rejected', undefined, 'execution_superseded');
          return false;
        }
        if (event.type === 'acknowledged') {
          if (job.state !== 'starting') return false;
          setState(job, 'running', 'executor-acknowledged');
        } else if (event.type === 'progress') {
          if (job.state !== 'running') return false;
          job.progress = {
            downloadedBytes: event.downloadedBytes,
            estimatedBytes: event.estimatedBytes,
            percent: event.percent,
          };
          if (event.phase) job.phase = event.phase;
          job.updatedAt = now();
          addDiagnostic(job, 'executor-progress');
        } else if (event.type === 'artifact') {
          if (job.state !== 'running') return false;
          job.downloadId = event.downloadId;
          job.phase = 'delivering';
          setState(job, 'finalizing', 'artifact');
        } else if (event.type === 'cancelled') {
          if (!activeStates.has(job.state)) return false;
          const next = job.pauseRequested ? 'paused' : 'cancelled';
          job.pauseRequested = false;
          if (next === 'cancelled') job.progress = { downloadedBytes: 0 };
          setState(job, next, 'executor-cancelled');
        } else if (event.type === 'failed') {
          if (!activeStates.has(job.state)) return false;
          job.terminal = { reason: event.reason };
          setState(job, 'failed', 'executor-failed', event.reason);
        }
        return true;
      }),

    browserDelivery: event =>
      transact(state => {
        const job = state.jobs[event.jobId];
        if (!job || job.state !== 'finalizing' || job.downloadId !== event.downloadId) return false;
        if (event.state === 'complete') {
          job.terminal = { downloadId: event.downloadId };
          setState(job, 'succeeded', 'browser-delivery-complete');
        } else {
          job.terminal = { downloadId: event.downloadId, reason: event.reason ?? 'browser_delivery_interrupted' };
          setState(job, 'failed', 'browser-delivery-interrupted', event.reason ?? 'browser_delivery_interrupted');
        }
        return true;
      }),

    snapshot: readSnapshot,
  };
  return runtime;
};

export type { PersistedRuntime };
