import type { MediaDownloadProgress } from '@extension/shared';

type Downloads = Record<string, MediaDownloadProgress>;
type Store = { getSnapshot: () => Downloads | null; subscribe: (notify: () => void) => () => void };

export const createDownloadSubscription = (store: Store, tabId: number | null) => {
  let snapshot: Downloads = {};
  const select = (): boolean => {
    const next = Object.fromEntries(
      Object.entries(store.getSnapshot() ?? {}).filter(([, entry]) => tabId !== null && entry.item?.tabId === tabId),
    );
    const keys = Object.keys(next);
    if (
      keys.length === Object.keys(snapshot).length &&
      keys.every(key => {
        const a = snapshot[key],
          b = next[key];
        return (
          a &&
          a.revision === b.revision &&
          a.updatedAt === b.updatedAt &&
          a.stage === b.stage &&
          a.downloadedBytes === b.downloadedBytes &&
          a.activity === b.activity &&
          a.error === b.error
        );
      })
    )
      return false;
    snapshot = next;
    return true;
  };
  select();
  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (select()) notify();
      };
      const unsubscribe = store.subscribe(() => {
        if (typeof document !== 'undefined' && document.hidden)
          timer ??= setTimeout(() => {
            timer = undefined;
            refresh();
          }, 1500);
        else refresh();
      });
      const visible = () => {
        if (!document.hidden) {
          clearTimeout(timer);
          timer = undefined;
          refresh();
        }
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
      refresh();
      return () => {
        unsubscribe();
        clearTimeout(timer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible);
      };
    },
  };
};
