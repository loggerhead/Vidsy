import { headersForFetch } from './hls-request';
import type { HlsKeyInfo } from './m3u8-parser';

const hlsKeyCache = new WeakMap<Record<string, string>, Map<string, CryptoKey>>();

const getHlsDecryptionKey = async (
  keyUri: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<CryptoKey> => {
  const cached = headers && hlsKeyCache.get(headers)?.get(keyUri);
  if (cached) return cached;

  const res = await fetch(keyUri, {
    headers: headersForFetch(headers, keyUri),
    credentials: 'include',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch HLS key: ${res.status}`);
  const keyData = await res.arrayBuffer();
  if (keyData.byteLength !== 16) throw new Error(`Invalid AES-128 key length: ${keyData.byteLength}`);

  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, ['decrypt']);
  if (headers) {
    const cache = hlsKeyCache.get(headers) ?? new Map<string, CryptoKey>();
    cache.set(keyUri, cryptoKey);
    hlsKeyCache.set(headers, cache);
  }
  return cryptoKey;
};

const defaultIvForSequence = (seq: number): Uint8Array => {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
};

export const decryptSegment = async (
  data: ArrayBuffer,
  keyInfo: HlsKeyInfo,
  seq: number,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ArrayBuffer> => {
  if (keyInfo.method !== 'AES-128' || !keyInfo.uri) return data;
  const cryptoKey = await getHlsDecryptionKey(keyInfo.uri, headers, signal);
  const iv = keyInfo.iv ?? defaultIvForSequence(seq);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(iv) }, cryptoKey, data);
};
