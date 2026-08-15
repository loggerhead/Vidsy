import { removeOpfs } from './worker-client';

// Tracks blob URLs whose underlying File is backed by an OPFS entry that must
// be removed once the browser-level chrome.downloads.download has completed
// or was interrupted. Startup OPFS GC recovers if that message is lost.
const pending = new Map<string, { opfsName: string }>();

const registerOutputForCleanup = (blobUrl: string, opfsName: string): void => {
  pending.set(blobUrl, { opfsName });
};

type CleanupDependencies = {
  revokeObjectUrl?: (url: string) => void;
  removeOutput?: (opfsName: string) => Promise<void>;
};

const cleanupBlob = async (blobUrl: string, dependencies: CleanupDependencies = {}): Promise<void> => {
  const entry = pending.get(blobUrl);
  if (!entry) return;
  pending.delete(blobUrl);
  try {
    (dependencies.revokeObjectUrl ?? URL.revokeObjectURL)(blobUrl);
  } catch {
    /* ignore */
  }
  try {
    await (dependencies.removeOutput ?? removeOpfs)(entry.opfsName);
  } catch {
    /* ignore */
  }
};

export { cleanupBlob, registerOutputForCleanup };
