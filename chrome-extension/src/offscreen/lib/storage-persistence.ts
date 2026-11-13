export const requestPersistentCacheStorage = async (storage: Pick<StorageManager, 'persist' | 'persisted'>) => {
  try {
    if (typeof storage.persist !== 'function') return { supported: false, persisted: false };
    const persisted =
      (typeof storage.persisted === 'function' && (await storage.persisted())) || (await storage.persist());
    return { supported: true, persisted };
  } catch {
    return { supported: true, persisted: false };
  }
};
