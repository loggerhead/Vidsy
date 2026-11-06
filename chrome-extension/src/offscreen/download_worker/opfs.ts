// OPFS wrapper using FileSystemSyncAccessHandle (Worker-only API).
// The sync API is dramatically faster than the async one and avoids
// per-chunk promise overhead during segment streaming.

interface FileSystemSyncAccessHandleShim {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileSystemFileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandleShim>;
}

type Entry = {
  handle: FileSystemFileHandle;
  sync: FileSystemSyncAccessHandleShim;
  size: number;
  writeCalls: number;
  bytesWritten: number;
  lastWriteAt: number;
};

export class OpfsWritableMap {
  private entries = new Map<string, Entry>();
  private reservations = new Map<string, number>();
  private reservationTail = Promise.resolve();
  private root: FileSystemDirectoryHandle | null = null;

  async reserve(name: string, expectedBytes: number): Promise<void> {
    const pending = this.reservationTail.then(async () => {
      const remaining = Math.max(0, expectedBytes - this.size(name));
      if (navigator.storage?.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        const other = [...this.reservations].reduce((sum, [key, bytes]) => (key === name ? sum : sum + bytes), 0);
        if (quota !== undefined && usage !== undefined && quota - usage - other < remaining)
          throw new Error(
            `Insufficient temporary storage: need ${(remaining / 2 ** 30).toFixed(2)} GB plus other active reservations`,
          );
      }
      this.reservations.set(name, remaining);
    });
    this.reservationTail = pending.catch(() => undefined);
    return pending;
  }

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.root) this.root = await navigator.storage.getDirectory();
    return this.root;
  }

  async open(name: string, preserve = false): Promise<void> {
    if (this.entries.has(name)) {
      if (!preserve) this.truncate(name, 0);
      return;
    }
    const root = await this.getRoot();
    const handle = (await root.getFileHandle(name, { create: true })) as FileSystemFileHandleWithSync;
    const sync = await handle.createSyncAccessHandle();
    if (!preserve) sync.truncate(0);
    this.entries.set(name, {
      handle,
      sync,
      size: preserve ? sync.getSize() : 0,
      writeCalls: 0,
      bytesWritten: 0,
      lastWriteAt: 0,
    });
  }

  flush(name: string): void {
    this.entries.get(name)?.sync.flush();
  }

  writeAt(name: string, pos: number, chunk: Uint8Array | ArrayBuffer): number {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let written = 0;
    while (written < view.byteLength) {
      const n = entry.sync.write(view.subarray(written), { at: pos + written });
      if (n <= 0) throw new Error(`OPFS write stalled at ${pos + written} (sync.write returned ${n})`);
      written += n;
      entry.writeCalls++;
      entry.bytesWritten += n;
      entry.lastWriteAt = Date.now();
    }
    if (pos + written > entry.size) {
      const growth = pos + written - entry.size;
      this.reservations.set(name, Math.max(0, (this.reservations.get(name) ?? 0) - growth));
      entry.size = pos + written;
    }
    return written;
  }

  append(name: string, chunk: Uint8Array | ArrayBuffer): number {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    return this.writeAt(name, entry.size, chunk);
  }

  copyAppend(source: string, destination: string): void {
    const entry = this.entries.get(source);
    if (!entry) throw new Error(`OPFS entry not open: ${source}`);
    const buffer = new Uint8Array(Math.min(1024 * 1024, entry.size));
    let offset = 0;
    while (offset < entry.size) {
      const read = entry.sync.read(buffer.subarray(0, Math.min(buffer.length, entry.size - offset)), { at: offset });
      if (read <= 0) throw new Error('OPFS read stalled');
      this.append(destination, buffer.subarray(0, read));
      offset += read;
    }
  }

  truncate(name: string, newSize: number): void {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    entry.sync.truncate(newSize);
    entry.size = newSize;
  }

  stats(name: string) {
    const entry = this.entries.get(name);
    return entry
      ? { writeCalls: entry.writeCalls, bytesWritten: entry.bytesWritten, lastWriteAt: entry.lastWriteAt }
      : undefined;
  }

  size(name: string): number {
    return this.entries.get(name)?.size ?? 0;
  }

  async close(name: string): Promise<void> {
    this.reservations.delete(name);
    const entry = this.entries.get(name);
    if (!entry) return;
    try {
      entry.sync.flush();
    } finally {
      entry.sync.close();
      this.entries.delete(name);
    }
  }

  async getFile(name: string): Promise<File> {
    // Must close the sync handle before reading through FileHandle.getFile.
    await this.close(name);
    const root = await this.getRoot();
    const handle = await root.getFileHandle(name);
    return handle.getFile();
  }

  async remove(name: string): Promise<void> {
    await this.close(name);
    try {
      const root = await this.getRoot();
      await root.removeEntry(name);
    } catch {
      /* ignore — already gone */
    }
  }

  async cleanupAll(): Promise<void> {
    for (const name of Array.from(this.entries.keys())) {
      try {
        await this.remove(name);
      } catch {
        /* ignore */
      }
    }
  }
}

export const opfs = new OpfsWritableMap();
