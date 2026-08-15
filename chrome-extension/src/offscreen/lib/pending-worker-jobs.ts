export type RejectablePending = {
  reject: (error: Error) => void;
};

export const rejectPendingWorkerJobs = (error: Error, pendingMaps: Array<Map<string, RejectablePending>>): void => {
  for (const pendingMap of pendingMaps) {
    for (const pending of pendingMap.values()) pending.reject(error);
    pendingMap.clear();
  }
};
