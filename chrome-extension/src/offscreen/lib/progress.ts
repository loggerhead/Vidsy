import type { MediaDownloadProgress } from '@extension/shared';

let reportExecutionProgress: ((key: string, progress: Partial<MediaDownloadProgress>) => boolean) | undefined;
export const setExecutionProgressReporter = (report: NonNullable<typeof reportExecutionProgress>) => {
  reportExecutionProgress = report;
};

export const updateProgress = async (key: string, prog: Partial<MediaDownloadProgress>) => {
  reportExecutionProgress?.(key, prog);
};
