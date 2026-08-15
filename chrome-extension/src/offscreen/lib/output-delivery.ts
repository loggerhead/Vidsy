import { registerOutputForCleanup } from './blob-cleanup';
import { validateOutputArtifact } from './output-artifact';
import type { ConcatenateFmp4Plan, ExecutableMuxPlan, PassthroughPlan } from './media-processing';
import type { OutputArtifact } from './output-artifact';

type DeliverablePlan = ExecutableMuxPlan | PassthroughPlan | ConcatenateFmp4Plan;

export const prepareOutputDelivery = async (args: {
  file: File;
  opfsName: string;
  plan: DeliverablePlan;
  expectedDurationSeconds?: number;
}): Promise<{ blobUrl: string; artifact: OutputArtifact }> => {
  const artifact = await validateOutputArtifact(args);
  const blobUrl = URL.createObjectURL(args.file);
  registerOutputForCleanup(blobUrl, args.opfsName);
  return { blobUrl, artifact };
};
