import { persistArtifact, restoreArtifact } from './persistent-artifact';
import { createDownloadCache } from '../../background/lib/download-cache';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutputArtifact } from '../lib/output-artifact';

const fixture = () => {
  let ledger: unknown;
  let clock = 1_000;
  let bytes = new Uint8Array(2 * 1024 * 1024 + 7).fill(23);
  const cache = createDownloadCache(
    {
      read: async () => ledger,
      write: async value => {
        ledger = value;
      },
    },
    () => clock,
  );
  const metadata: OutputArtifact = {
    opfsName: 'output',
    size: bytes.length,
    container: 'mp4',
    extension: '.mp4',
    mime: 'video/mp4',
    tracks: [{ type: 'video', codec: 'h264' }],
    planType: 'passthrough',
  };
  return {
    metadata,
    deps: { cache: cache.command, read: async (name: string) => new File([bytes], name), now: () => clock },
    changeBytes: () => {
      bytes[1024 * 1024 + 17] = 99;
    },
    truncate: () => {
      bytes = bytes.slice(0, -1);
    },
    expire: () => {
      clock += 24 * 60 * 60 * 1000;
    },
  };
};

test('output proof survives a fresh worker and preserves the passthrough input identity', async () => {
  const f = fixture();
  await f.deps.cache({
    operation: 'write',
    name: 'output',
    jobKey: 'job',
    patch: {
      size: f.metadata.size,
      complete: { source: 'original-source', size: 1, hashes: ['a'.repeat(64)] },
      fingerprint: 'b'.repeat(64),
    },
  });
  await persistArtifact('job', f.metadata, f.deps);
  const record = (await f.deps.cache({ operation: 'read', name: 'output' })).record!;
  assert.equal(record.complete?.source, 'original-source');
  assert.equal(record.fingerprint, 'b'.repeat(64));
  assert.equal(record.artifact?.checksums.hashes.length, 3);
  assert.equal((await restoreArtifact('job', 'output', f.deps)).size, f.metadata.size);
});

test('output restore rejects mutation, truncation, wrong owner, expiry and metadata changes', async () => {
  for (const scenario of ['bytes', 'length', 'owner', 'expiry', 'metadata']) {
    const f = fixture();
    await persistArtifact('job', f.metadata, f.deps);
    if (scenario === 'bytes') f.changeBytes();
    if (scenario === 'length') f.truncate();
    if (scenario === 'expiry') f.expire();
    if (scenario === 'metadata') {
      const record = (await f.deps.cache({ operation: 'read', name: 'output' })).record!;
      record.artifact!.metadata.mime = 'video/webm';
      await f.deps.cache({ operation: 'write', name: 'output', jobKey: 'job', patch: { artifact: record.artifact } });
    }
    await assert.rejects(restoreArtifact(scenario === 'owner' ? 'other' : 'job', 'output', f.deps));
  }
});

test('failed acknowledgement or cancellation cannot publish an output', async () => {
  const f = fixture();
  await assert.rejects(
    persistArtifact('job', f.metadata, { ...f.deps, cache: async () => ({ ok: false, error: 'disk unavailable' }) }),
    /disk unavailable/,
  );
  const controller = new AbortController();
  const pending = persistArtifact(
    'job',
    f.metadata,
    {
      ...f.deps,
      read: async name => {
        controller.abort();
        return f.deps.read(name);
      },
    },
    controller.signal,
  );
  await assert.rejects(pending);
  assert.equal((await f.deps.cache({ operation: 'read', name: 'output' })).record, undefined);
});
