import { DownloadFailure } from '../lib/download-failure';

const BLOCK_BYTES = 1024 * 1024;
type CompletedInputRecord = { source: string; size: number; hashes: string[] };
const hashes = async (file: Blob, signal?: AbortSignal): Promise<string[]> => {
  const result: string[] = [];
  for (let offset = 0; offset < file.size; offset += BLOCK_BYTES) {
    signal?.throwIfAborted();
    const bytes = await file.slice(offset, offset + BLOCK_BYTES).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    result.push(Array.from(digest, value => value.toString(16).padStart(2, '0')).join(''));
  }
  signal?.throwIfAborted();
  return result;
};

// Completed inputs are immutable snapshots for processing retries, including
// sources without Range. Never append remote bytes to one of these snapshots.
// Block hashes cover every byte while bounding the temporary hashing buffer.
export class CompletedInputRegistry {
  private records = new Map<string, CompletedInputRecord>();
  restore(name: string, record?: CompletedInputRecord): void {
    if (!record) return;
    if (
      typeof record.source !== 'string' ||
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      !Array.isArray(record.hashes) ||
      record.hashes.length !== Math.ceil(record.size / BLOCK_BYTES) ||
      record.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))
    )
      throw new DownloadFailure('integrity', 'Persisted input checksums are invalid');
    this.records.set(name, structuredClone(record));
  }
  snapshot(name: string): CompletedInputRecord | undefined {
    const record = this.records.get(name);
    return record ? structuredClone(record) : undefined;
  }

  async remember(name: string, source: string, file: Blob, signal?: AbortSignal): Promise<void> {
    const digests = await hashes(file, signal);
    this.records.set(name, { source, size: file.size, hashes: digests });
  }

  async reuse(
    name: string,
    source: string,
    read: () => Promise<Blob>,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const previous = this.records.get(name);
    if (!previous) return undefined;
    if (previous.source !== source) {
      this.remove(name);
      throw new DownloadFailure('integrity', 'Completed input identity changed');
    }
    let file: Blob;
    try {
      file = await read();
    } catch (cause) {
      this.remove(name);
      throw new DownloadFailure('integrity', 'Completed input file is unavailable', { cause });
    }
    if (file.size !== previous.size || JSON.stringify(await hashes(file, signal)) !== JSON.stringify(previous.hashes)) {
      this.remove(name);
      throw new DownloadFailure('integrity', 'Completed input bytes changed');
    }
    return file.size;
  }

  async removeRelated(name: string, remove: (name: string) => Promise<void>): Promise<void> {
    for (const key of this.records.keys()) {
      if (key.startsWith(`${name}.part-`) || key === `${name}.init`) {
        this.records.delete(key);
        await remove(key);
      }
    }
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  remove(name: string): void {
    this.records.delete(name);
  }
}

export type { CompletedInputRecord };
