export type BrowserDownloadTerminal = { stage: 'success' } | { stage: 'failed'; error: string };

export const browserDownloadTerminal = (
  state: chrome.downloads.DownloadItem['state'],
  error?: string,
): BrowserDownloadTerminal | undefined => {
  if (state === 'complete') return { stage: 'success' };
  if (state === 'interrupted') {
    return {
      stage: 'failed',
      error: error ? `Browser download interrupted: ${error}` : 'Browser download interrupted',
    };
  }
  return undefined;
};
