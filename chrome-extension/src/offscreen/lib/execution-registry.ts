import type { OutputArtifact } from './output-artifact';
import type { ExecutorCommand, ExecutorEvent } from '../../background/lib/download-runtime';
import type { MediaDownloadProgress } from '@extension/shared';

export type ExecutionOutput = { blobUrl: string; artifact: OutputArtifact };
export type ExecutionReport = { command: ExecutorCommand; sequence?: number } & (
  | { type: 'acknowledged' }
  | { type: 'progress'; progress: Partial<MediaDownloadProgress> }
  | { type: 'output'; output: ExecutionOutput }
  | { type: 'failed'; reason: string }
  | { type: 'cancelled' }
);
export type ExecutionRecord = {
  command: ExecutorCommand;
  report: ExecutionReport;
  stop?: 'pause' | 'cancel';
};

// Offscreen survives background suspension. Retain the last report until the
// background has persisted its result, so a missed message can be replayed.
export const createExecutionRegistry = (dependencies: {
  execute: (command: ExecutorCommand) => Promise<ExecutionOutput>;
  stop: (command: ExecutorCommand, intent: 'pause' | 'cancel') => Promise<void>;
  publish: (report: ExecutionReport) => Promise<unknown>;
}) => {
  const records = new Map<string, ExecutionRecord>();
  type Delivery = {
    sequence: number;
    inFlight: boolean;
    attempts: number;
    lastSentAt: number;
    timer?: ReturnType<typeof setTimeout>;
    acknowledged: number;
  };
  const deliveries = new Map<string, Delivery>();
  const schedule = (record: ExecutionRecord, delivery: Delivery, delay: number): void => {
    if (delivery.timer) clearTimeout(delivery.timer);
    delivery.timer = setTimeout(() => {
      delivery.timer = undefined;
      send(record, delivery);
    }, delay);
    (delivery.timer as unknown as { unref?: () => void }).unref?.();
  };
  const send = (record: ExecutionRecord, delivery: Delivery): void => {
    if (!records.has(record.command.executionId) || delivery.inFlight || delivery.acknowledged === delivery.sequence)
      return;
    const report = record.report;
    const sequence = delivery.sequence;
    delivery.inFlight = true;
    delivery.lastSentAt = Date.now();
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Execution report acknowledgement timed out')), 10_000);
    });
    void Promise.race([Promise.resolve().then(() => dependencies.publish({ ...report, sequence })), deadline])
      .then(
        () => {
          delivery.acknowledged = sequence;
          delivery.attempts = 0;
        },
        () => {
          delivery.attempts++;
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        delivery.inFlight = false;
        if (!records.has(record.command.executionId)) return;
        if (delivery.sequence !== sequence) {
          const delay = record.report.type === 'progress' ? Math.max(0, 350 - (Date.now() - delivery.lastSentAt)) : 0;
          schedule(record, delivery, delay);
        } else if (delivery.acknowledged !== sequence) {
          // Bounded exponential retries, followed by slow reconciliation. The
          // last report stays in inventory until the background forgets it.
          schedule(record, delivery, delivery.attempts <= 5 ? Math.min(500 * 2 ** delivery.attempts, 10_000) : 30_000);
        }
      });
  };
  const publish = (record: ExecutionRecord, report: ExecutionReport) => {
    const key = record.command.executionId;
    const delivery = deliveries.get(key) ?? {
      sequence: 0,
      inFlight: false,
      attempts: 0,
      lastSentAt: 0,
      acknowledged: -1,
    };
    deliveries.set(key, delivery);
    delivery.sequence++;
    // Preserve the public report shape; the wire sequence only fences retries.
    const previous = record.report;
    record.report = report;
    const priorStage = previous.type === 'progress' ? previous.progress.stage : undefined;
    const immediate = report.type !== 'progress' || priorStage !== report.progress.stage;
    if (delivery.timer) {
      clearTimeout(delivery.timer);
      delivery.timer = undefined;
    }
    if (!delivery.inFlight) {
      if (immediate || Date.now() - delivery.lastSentAt >= 350) send(record, delivery);
      else schedule(record, delivery, 350 - (Date.now() - delivery.lastSentAt));
    }
  };
  return {
    start(command: ExecutorCommand) {
      if (records.has(command.executionId)) return;
      // Fence an old attempt even if the background accidentally replays a
      // different execution identity for the same live request.
      if ([...records.values()].some(record => record.command.requestId === command.requestId)) {
        throw new Error('An execution for this request already exists');
      }
      const record: ExecutionRecord = { command, report: { command, type: 'acknowledged' } };
      records.set(command.executionId, record);
      publish(record, record.report);
      void Promise.resolve()
        .then(async () => {
          if (record.stop) throw new Error('Download cancelled');
          return dependencies.execute(command);
        })
        .then(
          output => {
            publish(record, { command, type: 'output', output });
          },
          error => {
            publish(
              record,
              record.stop
                ? { command, type: 'cancelled' }
                : {
                    command,
                    type: 'failed',
                    reason: error instanceof Error ? error.message : String(error),
                  },
            );
          },
        );
    },
    async stop(executionId: string, intent: 'pause' | 'cancel') {
      const record = records.get(executionId);
      if (!record) return;
      record.stop = intent;
      await dependencies.stop(record.command, intent);
    },
    progress(key: string, progress: Partial<MediaDownloadProgress>): boolean {
      const record = [...records.values()].find(record => record.command.requestId === key);
      if (!record) return false;
      if (record.stop || ['output', 'failed', 'cancelled'].includes(record.report.type)) return true;
      const previous = record.report.type === 'progress' ? record.report.progress : {};
      publish(record, {
        command: record.command,
        type: 'progress',
        progress: {
          ...previous,
          ...progress,
          muxPercent: progress.muxPercent,
          activity: progress.activity,
        },
      });
      return true;
    },
    inventory: () => [...records.values()],
    forget: (executionId: string) => {
      const delivery = deliveries.get(executionId);
      if (delivery?.timer) clearTimeout(delivery.timer);
      deliveries.delete(executionId);
      return records.delete(executionId);
    },
  };
};

export const executorIdentity = (
  command: ExecutorCommand,
): Pick<ExecutorEvent, 'jobId' | 'attempt' | 'executionId'> => ({
  jobId: command.jobId,
  attempt: command.attempt,
  executionId: command.executionId,
});
