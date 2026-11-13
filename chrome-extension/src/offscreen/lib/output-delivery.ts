import { registerOutputForCleanup } from './blob-cleanup';
import { cacheCommand } from './cache-client';
import { DownloadFailure } from './download-failure';
import { validateOutputArtifact } from './output-artifact';
import { updateProgress } from './progress';
import { persistOutputArtifact, restoreOutputArtifactFile } from './worker-client';
import type { ConcatenateFmp4Plan, ExecutableMuxPlan, PassthroughPlan } from './media-processing';
import type { OutputArtifact } from './output-artifact';

type DeliverablePlan = ExecutableMuxPlan | PassthroughPlan | ConcatenateFmp4Plan;

export const prepareOutputDelivery = async (args: {
  file: File;
  opfsName: string;
  plan: DeliverablePlan;
  expectedDurationSeconds?: number;
  jobKey?: string;
  signal?: AbortSignal;
}): Promise<{ blobUrl: string; artifact: OutputArtifact }> => {
  args.signal?.throwIfAborted();
  if (args.jobKey)
    await updateProgress(args.jobKey, { stage: 'mux', activity: 'verifying', downloadedBytes: args.file.size });
  const artifact = await validateOutputArtifact(args).catch(cause => {
    args.signal?.throwIfAborted();
    throw new DownloadFailure(
      args.plan.type === 'passthrough' ? 'integrity' : 'processing',
      `Output integrity validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  });
  args.signal?.throwIfAborted();
  if (args.jobKey) await persistOutputArtifact(args.jobKey, artifact);
  args.signal?.throwIfAborted();
  const blobUrl = URL.createObjectURL(args.file);
  registerOutputForCleanup(blobUrl, args.opfsName);
  return { blobUrl, artifact };
};

// Restoration always runs in the download worker and verifies every saved byte
// before a fresh browser blob URL can be published.
export const restoreSavedOutput = async (
  jobKey: string,
  signal?: AbortSignal,
): Promise<{ blobUrl: string; artifact: OutputArtifact }> => {
  signal?.throwIfAborted();
  await updateProgress(jobKey, { stage: 'mux', activity: 'verifying' });
  const { records = [] } = await cacheCommand({ operation: 'list' });
  const candidates = records.filter(
    record => record.jobKey === jobKey && record.artifact && record.artifact.expiresAt > Date.now(),
  );
  if (candidates.length !== 1)
    throw new DownloadFailure('processing', 'Saved output is unavailable or expired. Retry processing.');
  const record = candidates[0];
  signal?.throwIfAborted();
  const file = await restoreOutputArtifactFile(jobKey, record.name);
  signal?.throwIfAborted();
  const artifact = record.artifact!.metadata;
  const blobUrl = URL.createObjectURL(file);
  registerOutputForCleanup(blobUrl, record.name);
  return { blobUrl, artifact };
};
