import { registerOutputForCleanup } from './blob-cleanup';
import { validateOutputArtifact } from './output-artifact';
import { updateProgress } from './progress';
import type { ConcatenateFmp4Plan, ExecutableMuxPlan, PassthroughPlan } from './media-processing';
import type { OutputArtifact } from './output-artifact';

type DeliverablePlan = ExecutableMuxPlan | PassthroughPlan | ConcatenateFmp4Plan;

export const prepareOutputDelivery = async (args: {
  file: File;
  opfsName: string;
  plan: DeliverablePlan;
  expectedDurationSeconds?: number;
  jobKey?: string;
}): Promise<{ blobUrl: string; artifact: OutputArtifact }> => {
  if (args.jobKey)
    await updateProgress(args.jobKey, { stage: 'mux', activity: 'verifying', downloadedBytes: args.file.size });
  const artifact = await validateOutputArtifact(args);
  const blobUrl = URL.createObjectURL(args.file);
  registerOutputForCleanup(blobUrl, args.opfsName);
  return { blobUrl, artifact };
};
