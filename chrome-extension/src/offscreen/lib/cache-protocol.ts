import type { OutputArtifact } from './output-artifact';
import type { CompletedInputRecord } from '../download_worker/completed-inputs';
import type { RangeResumeRecord } from '../download_worker/range-resume';

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_BYTES = 5 * 1024 ** 3;

type ArtifactSnapshot = {
  metadata: OutputArtifact;
  checksums: CompletedInputRecord;
  expiresAt: number;
};
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

type CacheRecord = {
  schemaVersion: 1;
  name: string;
  jobKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  size: number;
  fingerprint?: string;
  manifestHash?: string;
  segmentIdentity?: string;
  ranges?: RangeResumeRecord;
  complete?: CompletedInputRecord;
  artifact?: ArtifactSnapshot;
  httpMetadata?: {
    contentType: string;
    transport: { mode: 'range' | 'stream'; connectionLimit: number; totalBytes?: number; fallbackReason?: string };
  };
};
type CachePatch = Pick<
  CacheRecord,
  'size' | 'fingerprint' | 'manifestHash' | 'segmentIdentity' | 'ranges' | 'complete' | 'httpMetadata' | 'artifact'
>;
type CacheCommand =
  | { operation: 'read'; name: string }
  | { operation: 'list' }
  | { operation: 'write'; name: string; jobKey: string; patch: Partial<CachePatch> }
  | { operation: 'remove'; name: string }
  | { operation: 'remove-artifact'; name: string }
  | { operation: 'set-retention'; ttlMs: number }
  | { operation: 'remove-job'; jobKey: string };
type CacheResponse = { ok: boolean; record?: CacheRecord; records?: CacheRecord[]; error?: string };

const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, field]) => [key, ordered(field)]),
    );
  return value;
};
const canonicalCacheSource = (source: unknown): string => JSON.stringify(ordered(source));

const cacheFingerprint = async (source: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalCacheSource(source)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
};

export {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_BYTES,
  ARTIFACT_TTL_MS,
  cacheFingerprint,
  canonicalCacheSource,
};
export type { CacheRecord, CachePatch, CacheCommand, CacheResponse, ArtifactSnapshot };
