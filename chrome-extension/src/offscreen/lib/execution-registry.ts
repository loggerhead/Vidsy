import type { OutputArtifact } from './output-artifact';
import type { ExecutorCommand, ExecutorEvent } from '../../background/lib/download-runtime';
import type { MediaDownloadProgress } from '@extension/shared';

export type ExecutionOutput = { blobUrl: string; artifact: OutputArtifact };
export type ExecutionReport = { command: ExecutorCommand } & (
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
  const publish = (record: ExecutionRecord, report: ExecutionReport) => {
    record.report = report;
    void dependencies.publish(report).catch(() => undefined);
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
      publish(record, { command: record.command, type: 'progress', progress });
      return true;
    },
    inventory: () => [...records.values()],
    forget: (executionId: string) => records.delete(executionId),
  };
};

export const executorIdentity = (
  command: ExecutorCommand,
): Pick<ExecutorEvent, 'jobId' | 'attempt' | 'executionId'> => ({
  jobId: command.jobId,
  attempt: command.attempt,
  executionId: command.executionId,
});
