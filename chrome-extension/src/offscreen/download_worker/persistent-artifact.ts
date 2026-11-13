import { CompletedInputRegistry } from './completed-inputs';
import { ARTIFACT_TTL_MS, cacheFingerprint } from '../lib/cache-protocol';
import { DownloadFailure } from '../lib/download-failure';
import type { CacheCommand, CacheResponse } from '../lib/cache-protocol';
import type { OutputArtifact } from '../lib/output-artifact';

type Dependencies = {
  read: (name: string) => Promise<File>;
  cache: (command: CacheCommand) => Promise<CacheResponse>;
  now?: () => number;
};

// An output may share a passthrough input file. Keep its delivery proof separate
// from the input's source identity and immutable processing snapshot.
export const persistArtifact = async (
  jobKey: string,
  metadata: OutputArtifact,
  deps: Dependencies,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  const file = await deps.read(metadata.opfsName);
  if (file.size !== metadata.size || file.size <= 0)
    throw new DownloadFailure('integrity', 'Output size changed before delivery');
  const registry = new CompletedInputRegistry();
  await registry.remember(metadata.opfsName, await cacheFingerprint(metadata), file, signal);
  signal?.throwIfAborted();
  const response = await deps.cache({
    operation: 'write',
    name: metadata.opfsName,
    jobKey,
    patch: {
      size: file.size,
      artifact: {
        metadata,
        checksums: registry.snapshot(metadata.opfsName)!,
        expiresAt: (deps.now ?? Date.now)() + ARTIFACT_TTL_MS,
      },
    },
  });
  if (!response.ok) throw new Error(response.error ?? 'Output persistence failed');
  signal?.throwIfAborted();
};

export const restoreArtifact = async (
  jobKey: string,
  name: string,
  deps: Dependencies,
  signal?: AbortSignal,
): Promise<File> => {
  signal?.throwIfAborted();
  const response = await deps.cache({ operation: 'read', name });
  if (!response.ok) throw new Error(response.error ?? 'Output cache unavailable');
  const record = response.record;
  const snapshot = record?.artifact;
  if (
    !snapshot ||
    record?.jobKey !== jobKey ||
    snapshot.metadata.opfsName !== name ||
    !Number.isFinite(snapshot.expiresAt) ||
    snapshot.expiresAt <= (deps.now ?? Date.now)()
  )
    throw new DownloadFailure('processing', 'Saved output is unavailable or expired. Retry processing.');
  const registry = new CompletedInputRegistry();
  registry.restore(name, snapshot.checksums);
  if (snapshot.metadata.size !== snapshot.checksums.size)
    throw new DownloadFailure('integrity', 'Saved output metadata size changed');
  let file: File | undefined;
  await registry.reuse(
    name,
    await cacheFingerprint(snapshot.metadata),
    async () => {
      file = await deps.read(name);
      return file;
    },
    signal,
  );
  signal?.throwIfAborted();
  return file!;
};
