import { muxInWorker } from './worker-client';
import type { ExecutableMuxPlan, MediaProcessingPlan, PlanInput, UnsupportedPlan } from './media-processing';

export class UnsupportedMediaError extends Error {
  readonly reason: UnsupportedPlan['reason'];

  constructor(plan: UnsupportedPlan) {
    super(plan.message);
    this.name = 'UnsupportedMediaError';
    this.reason = plan.reason;
  }
}

export const requireExecutablePlan = (plan: MediaProcessingPlan): Exclude<MediaProcessingPlan, UnsupportedPlan> => {
  if (plan.type === 'unsupported') throw new UnsupportedMediaError(plan);
  return plan;
};

export const executeMuxPlan = async (args: {
  jobKey: string;
  outputOpfsName: string;
  plan: ExecutableMuxPlan;
  input: PlanInput;
  durationSeconds?: number;
  estimatedBytes?: number;
}): Promise<{ outputOpfsName: string; totalBytes: number }> =>
  muxInWorker({
    jobKey: args.jobKey,
    outputOpfsName: args.outputOpfsName,
    plan: args.plan,
    input: args.input,
    durationSeconds: args.durationSeconds,
    estimatedBytes: args.estimatedBytes,
  });
