/* eslint-disable import-x/exports-last */
import { nextAutomaticRecovery } from './download-recovery';
import type { AutomaticRecovery } from './download-recovery';
import type { SegmentedSource } from '../../offscreen/lib/segmented-resume';
import type { MediaItem, MediaKind } from '@extension/shared';

/**
 * Durable lifecycle authority for media downloads.
 *
 * This module deliberately knows nothing about Chrome APIs or media execution.
 * Adapters supply persistence, executor inventory/commands, and browser
 * delivery events. Recreating the runtime object must therefore be safe: the
 * store is the authority, while all indexes in this module are disposable.
 */

export const DOWNLOAD_RUNTIME_SCHEMA_VERSION = 2 as const;

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
  allowMetered?: boolean;
  revalidateCompleted?: boolean;
  reuseSegmentedSnapshot?: boolean;
  kind: MediaKind;
  outputFormat: 'mp4' | 'mp3';
  fileName?: string;
  audioUrl?: string;
  audioMimeType?: string;
  headers?: Record<string, string>;
  audioHeaders?: Record<string, string>;
  title?: string;
  item?: MediaItem;
};

export type DownloadDisplay = {
  title?: string;
  itemId?: string;
  pageUrl?: string;
  tabId?: number;
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
    fetchBytes?: number;
    estimatedBytes?: number;
    percent?: number;
  };
  terminal?: { reason?: string; downloadId?: number; kind?: 'transport' | 'processing' | 'integrity' };
  downloadId?: number;
  artifactReady?: boolean;
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  createdAt: number;
  updatedAt: number;
  cacheExpiresAt?: number;
  recovery?: AutomaticRecovery;
  segmentedSource?: SegmentedSource;
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
  display: DownloadDisplay;
  resumeDelivery?: boolean;
};

export type ExecutorAdapter = {
  start?: (command: ExecutorCommand) => Promise<void>;
  cancel?: (identity: ExecutionIdentity & { requestId: string; intent: 'pause' | 'cancel' }) => Promise<void>;
  inventory?: () => Promise<ExecutorInventory>;
  resumeDelivery?: (jobId: string) => Promise<void>;
};

type ExecutionIdentity = {
  jobId: string;
  attempt: number;
  executionId: string;
};

export type ExecutorEvent = ExecutionIdentity &
  (
    | { type: 'acknowledged' }
    | { type: 'ready' }
    | { type: 'progress'; downloadedBytes: number; estimatedBytes?: number; percent?: number; phase?: DownloadPhase }
    | { type: 'artifact'; downloadId: number }
    | { type: 'cancelled' }
    | { type: 'failed'; reason: string; recoverable?: boolean; failureKind?: 'transport' | 'processing' | 'integrity' }
  );

export type BrowserDeliveryEvent = {
  jobId: string;
  downloadId: number;
  state: 'complete' | 'interrupted';
  reason?: string;
};

export type DownloadCommand =
  | { type: 'source-renewed'; executionId: string; execution: DownloadExecutionSpec; tabId?: number }
  | { type: 'input-restarted'; reason: string; retainedBytes: number }
  | { type: 'segmented-source'; source: SegmentedSource; restartReason?: string }
  | { type: 'cache-lease'; expiresAt: number }
  | { type: 'cache-invalidated'; reason: string }
  | { type: 'cancel'; reason?: string }
  | { type: 'pause'; automatic?: boolean; metered?: boolean; reason?: string }
  | { type: 'recovery-check'; online: boolean; immediate?: boolean }
  | { type: 'resume'; revalidateCompleted?: boolean }
  | { type: 'retry'; revalidateCompleted?: boolean }
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
  schedule: () => Promise<RuntimeSnapshot>;
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
  canStart?: (job: DownloadJob, active: DownloadJob[]) => boolean | Promise<boolean>;
  recoverCheckpoint?: (
    job: DownloadJob,
  ) => Promise<{ downloadedBytes: number; estimatedBytes?: number; artifactAvailable?: boolean } | undefined>;
};

const terminalStates = new Set<DownloadState>(['succeeded', 'failed', 'cancelled', 'paused']);
const activeStates = new Set<DownloadState>(['starting', 'running', 'finalizing']);

const defaultState = (): PersistedRuntime => ({
  schemaVersion: DOWNLOAD_RUNTIME_SCHEMA_VERSION,
  nextJobNumber: 1,
  nextQueueOrder: 1,
  jobs: {},
});

const cloneState = (state: PersistedRuntime): PersistedRuntime => structuredClone(state);

const normalizeConcurrency = (value: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;

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
    await operation;
    const state = (await options.store.read()) ?? defaultState();
    const activeIds = new Set(
      Object.values(state.jobs)
        .filter(job => activeStates.has(job.state))
        .map(job => job.executionId),
    );
    for (let index = commands.length - 1; index >= 0; index--) {
      if (!activeIds.has(commands[index].executionId)) commands.splice(index, 1);
    }
    for (const id of dispatchedExecutions) if (!activeIds.has(id)) dispatchedExecutions.delete(id);
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
    job.updatedAt = Math.max(now(), job.updatedAt + 1);
    addDiagnostic(job, event, state, reason);
    job.diagnostics[job.diagnostics.length - 1].previousState = previous;
  };

  const identityMatches = (job: DownloadJob, identity: ExecutionIdentity): boolean =>
    job.jobId === identity.jobId &&
    job.state !== 'queued' &&
    job.executionId === identity.executionId &&
    job.attempt === identity.attempt;

  const schedule = async (state: PersistedRuntime): Promise<ExecutorCommand[]> => {
    const claimedCommands: ExecutorCommand[] = [];
    const configured = typeof options.concurrency === 'function' ? await options.concurrency() : options.concurrency;
    const capacity = normalizeConcurrency(configured);
    const active = Object.values(state.jobs).filter(job => activeStates.has(job.state));
    const eligible = Object.values(state.jobs)
      .filter(job => job.state === 'queued')
      .sort((a, b) => a.queueOrder - b.queueOrder);
    for (const job of eligible) {
      if (active.length >= capacity) break;
      if (options.canStart && !(await options.canStart(job, active))) continue;
      const resumeDelivery = Boolean(job.artifactReady && job.executionId);
      if (!resumeDelivery) {
        job.attempt += 1;
        job.executionId = nextExecutionId(job);
      }
      job.phase = resumeDelivery ? 'delivering' : 'idle';
      setState(job, resumeDelivery ? 'finalizing' : 'starting', resumeDelivery ? 'claim-delivery' : 'claim');
      const command: ExecutorCommand = {
        jobId: job.jobId,
        requestId: job.requestId,
        attempt: job.attempt,
        executionId: job.executionId!,
        execution: job.execution,
        display: job.display,
        ...(resumeDelivery ? { resumeDelivery: true } : {}),
      };
      commands.push(command);
      claimedCommands.push(command);
      active.push(job);
    }
    return claimedCommands;
  };

  // Dispatch after the claim is committed. A start callback may represent a
  // long-running executor; it must never hold the scheduler or caller open.
  const dispatch = (claimed: ExecutorCommand[]) => {
    for (const command of claimed) {
      if (
        command.resumeDelivery
          ? !options.executor?.resumeDelivery
          : !options.executor?.start || dispatchedExecutions.has(command.executionId)
      )
        continue;
      if (!command.resumeDelivery) dispatchedExecutions.add(command.executionId);
      void Promise.resolve()
        .then(() =>
          command.resumeDelivery ? options.executor!.resumeDelivery!(command.jobId) : options.executor!.start!(command),
        )
        .catch(async error => {
          await runtime.executorEvent({ ...command, type: 'failed', reason: String(error) });
          await runtime.schedule();
        });
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
            ...structuredClone(submission.execution),
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

    command: async (jobId, command) => {
      let stop: Parameters<NonNullable<ExecutorAdapter['cancel']>>[0] | undefined;
      const result = await transact(async state => {
        const job = state.jobs[jobId];
        if (!job) return false;
        if (command.type === 'input-restarted') {
          if (!['starting', 'running'].includes(job.state) || job.pauseRequested || job.cancelRequested) return false;
          job.progress = {
            downloadedBytes: command.retainedBytes,
            fetchBytes: command.retainedBytes,
            estimatedBytes: job.progress.estimatedBytes,
          };
          job.cacheExpiresAt = undefined;
          addDiagnostic(job, 'input-restarted', job.state, command.reason);
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          return true;
        }
        if (command.type === 'segmented-source') {
          if (!['starting', 'running'].includes(job.state) || job.cancelRequested || job.pauseRequested) return false;
          job.segmentedSource = structuredClone(command.source);
          if (command.restartReason) {
            job.progress = { downloadedBytes: 0 };
            job.cacheExpiresAt = undefined;
            addDiagnostic(job, 'source-restarted', job.state, command.restartReason);
          }
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          return true;
        }
        if (command.type === 'recovery-check') {
          if (job.state !== 'paused' || !job.recovery || (!command.immediate && now() < job.recovery.nextRetryAt))
            return false;
          if (job.recovery.exhausted) {
            job.recovery = undefined;
            job.terminal = { reason: 'Automatic recovery exhausted; cached progress is retained. Retry to continue.' };
            setState(job, 'failed', 'auto-recovery-exhausted');
            return true;
          }
          const attempts = job.recovery.attempts + 1;
          if (!command.online) {
            job.recovery = nextAutomaticRecovery(attempts, now(), job.recovery.reason);
            if (!job.recovery) {
              job.terminal = {
                reason: 'Automatic recovery exhausted while offline; cached progress is retained. Retry to continue.',
              };
              setState(job, 'failed', 'auto-recovery-exhausted');
            } else setState(job, 'paused', 'auto-recovery-offline');
            return true;
          }
          job.recovery.attempts = attempts;
          job.executionId = undefined;
          job.downloadId = undefined;
          job.pauseRequested = false;
          job.cancelRequested = false;
          job.queueOrder = state.nextQueueOrder++;
          setState(job, 'queued', 'auto-recovery-resume');
          return true;
        }
        if (command.type === 'source-renewed') {
          if (
            job.executionId !== command.executionId ||
            job.state !== 'running' ||
            job.pauseRequested ||
            job.cancelRequested
          )
            return false;
          job.execution = structuredClone(command.execution);
          if (command.tabId !== undefined) job.display.tabId = command.tabId;
          addDiagnostic(
            job,
            'source-renewed',
            job.state,
            'Expired source reparsed once; cached bytes require validation',
          );
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          return true;
        }
        if (command.type === 'cache-lease') {
          if (['succeeded', 'cancelled'].includes(job.state)) return false;
          job.cacheExpiresAt = command.expiresAt;
          return true;
        }
        if (command.type === 'cache-invalidated') {
          job.artifactReady = false;
          job.cacheExpiresAt = undefined;
          job.execution.reuseSegmentedSnapshot = false;
          job.terminal = { ...job.terminal, kind: undefined, reason: command.reason };
          if (job.segmentedSource?.live && job.state === 'paused')
            setState(job, 'failed', 'live-cache-invalidated', command.reason);
          addDiagnostic(job, 'cache-invalidated', job.state, command.reason);
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          return true;
        }
        if (command.type === 'clear-terminal') {
          if (!terminalStates.has(job.state) || job.state === 'paused') return false;
          if (job.state === 'failed' && job.executionId)
            stop = {
              jobId: job.jobId,
              requestId: job.requestId,
              attempt: job.attempt,
              executionId: job.executionId,
              intent: 'cancel',
            };
          delete state.jobs[jobId];
          return true;
        }
        if (
          command.type === 'cancel' ||
          (command.type === 'pause' &&
            job.segmentedSource?.live &&
            !job.execution.reuseSegmentedSnapshot &&
            !job.artifactReady)
        ) {
          job.recovery = undefined;
          job.cacheExpiresAt = undefined;
          if (command.reason) job.terminal = { reason: command.reason };
          if (terminalStates.has(job.state) && job.state !== 'paused' && job.state !== 'failed')
            return job.state === 'cancelled';
          job.pauseRequested = false;
          job.cancelRequested = true;
          if (job.executionId)
            stop = {
              jobId: job.jobId,
              requestId: job.requestId,
              attempt: job.attempt,
              executionId: job.executionId,
              intent: 'cancel',
            };
          // Keep the slot until the executor confirms it has stopped.
          if (job.state === 'queued' || job.state === 'paused' || job.state === 'failed') {
            job.progress = { downloadedBytes: 0 };
            setState(job, 'cancelled', 'cancel');
          } else addDiagnostic(job, 'cancel-requested');
          return true;
        }
        if (command.type === 'pause') {
          if (command.metered) job.execution.allowMetered = false;
          if (command.reason) job.terminal = { reason: command.reason };
          if (job.state === 'queued') {
            job.recovery = undefined;
            job.pauseRequested = false;
            setState(job, 'paused', 'queue-paused', command.reason);
            return true;
          }
          if (command.automatic) {
            if (job.segmentedSource?.live) return false;
            if (job.state !== 'running' && job.state !== 'starting') return false;
            job.recovery = nextAutomaticRecovery(job.recovery?.attempts ?? 0, now(), 'Network disconnected');
            job.terminal = { reason: 'Network disconnected; cached progress is retained. Waiting to reconnect.' };
            if (!job.recovery) {
              job.recovery = { attempts: 5, nextRetryAt: now(), reason: 'Network disconnected', exhausted: true };
              job.terminal.reason = 'Automatic recovery exhausted; cached progress is retained. Retry to continue.';
            }
          } else {
            job.recovery = undefined;
            if (job.state === 'paused') setState(job, 'paused', 'manual-pause');
          }
          if (!activeStates.has(job.state)) return job.state === 'paused';
          job.pauseRequested = true;
          job.cancelRequested = false;
          if (job.executionId)
            stop = {
              jobId: job.jobId,
              requestId: job.requestId,
              attempt: job.attempt,
              executionId: job.executionId,
              intent: command.type,
            };
          addDiagnostic(job, 'pause-requested');
          return true;
        }
        if (command.type === 'resume' || command.type === 'retry') {
          const allowed = command.type === 'resume' ? job.state === 'paused' : job.state === 'failed';
          if (!allowed) return false;
          job.execution.allowMetered = true;
          job.execution.reuseSegmentedSnapshot =
            (job.terminal?.kind === 'processing' ||
              (job.state === 'paused' && job.execution.reuseSegmentedSnapshot === true)) &&
            Boolean(job.segmentedSource?.snapshot) &&
            !command.revalidateCompleted;
          job.recovery = undefined;
          job.pauseRequested = false;
          job.cancelRequested = false;
          job.execution.revalidateCompleted = command.revalidateCompleted ?? false;
          if (job.artifactReady && !command.revalidateCompleted) {
            job.downloadId = undefined;
            job.queueOrder = state.nextQueueOrder++;
            setState(job, 'queued', 'resume-delivery');
            return true;
          }
          job.executionId = undefined;
          job.downloadId = undefined;
          job.artifactReady = false;
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
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          addDiagnostic(job, 'reorder');
          return true;
        }
        return false;
      });
      if (stop) await options.executor?.cancel?.(stop);
      return result;
    },

    schedule: async () => {
      const claimed = await transact(schedule);
      dispatch(claimed);
      return readSnapshot();
    },

    bootstrap: async inventory => {
      const claimed = await transact(async state => {
        const currentInventory =
          inventory ?? (options.executor?.inventory ? await options.executor.inventory() : undefined);
        // Unknown inventory is not evidence of a dead executor. Preserve claims
        // until a successful inventory query proves they are absent.
        const present = currentInventory && new Map(currentInventory.executions.map(item => [item.executionId, item]));
        for (const job of Object.values(state.jobs)) {
          if (present && !['succeeded', 'cancelled'].includes(job.state) && !present.has(job.executionId ?? '')) {
            if (
              job.segmentedSource?.live &&
              !job.execution.reuseSegmentedSnapshot &&
              !job.artifactReady &&
              ['starting', 'running', 'paused'].includes(job.state)
            ) {
              job.recovery = undefined;
              job.terminal = {
                reason:
                  'Live playlist snapshot was interrupted; restart downloads the current playlist. Live streams cannot resume.',
              };
              setState(job, 'failed', 'live-snapshot-interrupted');
              continue;
            }
            const checkpoint = await options.recoverCheckpoint?.(job);
            if (checkpoint) {
              if (checkpoint.artifactAvailable !== undefined) job.artifactReady = checkpoint.artifactAvailable;
              job.progress.downloadedBytes = Math.max(job.progress.downloadedBytes, checkpoint.downloadedBytes);
              job.progress.fetchBytes = Math.max(job.progress.fetchBytes ?? 0, checkpoint.downloadedBytes);
              job.progress.estimatedBytes ??= checkpoint.estimatedBytes;
              if (activeStates.has(job.state) && checkpoint.downloadedBytes > 0 && !job.cancelRequested)
                job.pauseRequested = true;
            }
          }
          if (!present || !activeStates.has(job.state) || !job.executionId) continue;
          const execution = present.get(job.executionId);
          if (execution) {
            if (execution.acknowledged && job.state === 'starting') setState(job, 'running', 'bootstrap-reattach');
          } else if (job.state === 'finalizing' && job.downloadId === undefined && job.artifactReady) {
            job.pauseRequested = false;
            job.terminal = { reason: 'Saved output retained after restart. Continue to deliver it again.' };
            setState(job, 'paused', 'artifact-retained');
          } else if (job.state === 'finalizing' && job.downloadId === undefined) {
            job.terminal = { reason: 'Output artifact unavailable after executor restart' };
            setState(job, 'failed', 'artifact-unavailable');
          } else if (job.state === 'starting' || job.state === 'running') {
            job.executionId = undefined;
            const next = job.cancelRequested ? 'cancelled' : job.pauseRequested ? 'paused' : 'queued';
            setState(job, next, 'executor-absent', 'executor_unavailable');
          }
        }
        return schedule(state);
      });
      dispatch(claimed);
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
            downloadedBytes:
              event.phase === 'fetching'
                ? Math.max(event.downloadedBytes, job.progress.fetchBytes ?? 0)
                : Math.max(event.downloadedBytes, job.progress.fetchBytes ?? 0),
            fetchBytes:
              event.phase === 'fetching'
                ? Math.max(event.downloadedBytes, job.progress.fetchBytes ?? 0)
                : job.progress.fetchBytes,
            estimatedBytes: event.estimatedBytes,
            percent: event.percent,
          };
          if (event.phase) job.phase = event.phase;
          job.updatedAt = Math.max(now(), job.updatedAt + 1);
          addDiagnostic(job, 'executor-progress');
        } else if (event.type === 'ready') {
          if (job.state !== 'running' && job.state !== 'finalizing') return false;
          job.artifactReady = true;
          job.phase = 'delivering';
          setState(job, 'finalizing', 'artifact-ready');
        } else if (event.type === 'artifact') {
          if (job.state !== 'running' && job.state !== 'finalizing') return false;
          job.downloadId = event.downloadId;
          job.artifactReady = true;
          job.phase = 'delivering';
          setState(job, 'finalizing', 'artifact');
        } else if (event.type === 'cancelled') {
          if (!activeStates.has(job.state)) return false;
          const next = job.pauseRequested ? (job.recovery?.exhausted ? 'failed' : 'paused') : 'cancelled';
          job.pauseRequested = false;
          if (job.recovery?.exhausted) job.recovery = undefined;
          if (next === 'cancelled') job.progress = { downloadedBytes: 0 };
          setState(job, next, 'executor-cancelled');
        } else if (event.type === 'failed') {
          if (!activeStates.has(job.state)) return false;
          if (job.phase === 'delivering' && (event.failureKind === 'integrity' || event.failureKind === 'processing'))
            job.artifactReady = false;
          if (job.progress.fetchBytes !== undefined)
            job.progress.downloadedBytes = Math.max(job.progress.downloadedBytes, job.progress.fetchBytes);
          job.terminal = { reason: event.reason, kind: event.failureKind };
          if (job.cancelRequested) {
            job.recovery = undefined;
            job.progress = { downloadedBytes: 0 };
            setState(job, 'cancelled', 'executor-failed-after-cancel');
          } else if (job.pauseRequested) {
            job.pauseRequested = false;
            const exhausted = job.recovery?.exhausted;
            if (exhausted) {
              job.recovery = undefined;
              job.terminal.reason = 'Automatic recovery exhausted; cached progress is retained. Retry to continue.';
            }
            setState(job, exhausted ? 'failed' : 'paused', 'executor-failed-after-pause', job.terminal.reason);
          } else if (event.recoverable && !job.segmentedSource?.live) {
            job.recovery = nextAutomaticRecovery(job.recovery?.attempts ?? 0, now(), event.reason);
            if (job.recovery) setState(job, 'paused', 'auto-recovery-wait', event.reason);
            else {
              job.terminal.reason = `Automatic recovery exhausted; cached progress is retained. Retry to continue. ${event.reason}`;
              setState(job, 'failed', 'auto-recovery-exhausted', job.terminal.reason);
            }
          } else {
            job.recovery = undefined;
            setState(job, 'failed', 'executor-failed', event.reason);
          }
        }
        return true;
      }),

    browserDelivery: event =>
      transact(state => {
        const job = state.jobs[event.jobId];
        if (!job || job.state !== 'finalizing' || job.downloadId !== event.downloadId) return false;
        if (event.state === 'complete') {
          job.recovery = undefined;
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
