import { DOWNLOAD_RUNTIME_SCHEMA_VERSION } from './download-runtime';
import type { PersistedRuntime } from './download-runtime';

const migrateDownloadRuntime = (value: unknown): PersistedRuntime | undefined => {
  if (value === undefined) return undefined;
  const state = value as PersistedRuntime;
  if (
    ![1, DOWNLOAD_RUNTIME_SCHEMA_VERSION].includes(state.schemaVersion) ||
    !state.jobs ||
    !Number.isSafeInteger(state.nextJobNumber) ||
    !Number.isSafeInteger(state.nextQueueOrder)
  )
    throw new Error('Unsupported or corrupt download task schema');
  const migrated = structuredClone(state);
  migrated.schemaVersion = DOWNLOAD_RUNTIME_SCHEMA_VERSION;
  for (const job of Object.values(migrated.jobs))
    if (!job.jobId || !job.requestId || !job.execution || !Number.isFinite(job.updatedAt))
      throw new Error('Corrupt persisted download task');
  return migrated;
};

type StorageArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (value: Record<string, unknown>) => Promise<void>;
  remove: (key: string | string[]) => Promise<void>;
};
const createLocalDownloadStore = (local: StorageArea, session: StorageArea) => {
  const key = 'vidsy-download-runtime';
  let migration: Promise<void> | undefined;
  const initialize = () =>
    (migration ??= (async () => {
      const current = (await local.get(key))[key];
      const legacy = current === undefined ? (await session.get(key))[key] : undefined;
      const migrated = migrateDownloadRuntime(current ?? legacy);
      if (migrated) await local.set({ [key]: migrated });
      const progressKey = 'media-downloads';
      if ((await local.get(progressKey))[progressKey] === undefined) {
        const old = (await session.get(progressKey))[progressKey];
        if (old) await local.set({ [progressKey]: old });
      }
      await session.remove([key, progressKey]);
    })().catch(error => {
      migration = undefined;
      throw error;
    }));
  return {
    read: async (): Promise<PersistedRuntime | undefined> => {
      await initialize();
      return migrateDownloadRuntime((await local.get(key))[key]);
    },
    write: async (state: PersistedRuntime): Promise<void> => {
      await initialize();
      await local.set({ [key]: state });
    },
  };
};

export { migrateDownloadRuntime, createLocalDownloadStore };
