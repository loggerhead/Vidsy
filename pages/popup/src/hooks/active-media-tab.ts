type TabCandidate = {
  id?: number;
  url?: string;
  active?: boolean;
  lastAccessed?: number;
};

const isMediaPageTab = (tab: TabCandidate | undefined): tab is TabCandidate & { id: number } =>
  typeof tab?.id === 'number' && /^(?:https?|file):/i.test(tab.url ?? '');

export const selectMediaPageTab = (
  currentWindowTabs: TabCandidate[],
  activeTabs: TabCandidate[],
  allTabs: TabCandidate[],
): (TabCandidate & { id: number }) | undefined =>
  currentWindowTabs.find(isMediaPageTab) ??
  activeTabs.find(isMediaPageTab) ??
  allTabs.filter(isMediaPageTab).sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
