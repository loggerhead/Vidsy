import { canonicalCacheSource } from './cache-protocol';

export type HttpValidationMethod = 'etag' | 'last-modified' | 'boundary-sample';
export const canonicalHttpSource = (url: string, headers?: Record<string, string>): string =>
  canonicalCacheSource({
    url,
    headers: Object.entries(headers ?? {})
      .map(([name, value]) => [name.toLowerCase(), value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });

export const httpDate = (value: string | null | undefined): string | undefined => {
  if (!value || !value.includes(':')) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toUTCString() : undefined;
};
export const responseValidator = (
  headers: Headers,
): { resourceVersion?: string; weakEtag?: string; validationMethod: HttpValidationMethod } => {
  const etag = headers.get('etag');
  if (etag && /^"[^\r\n]*"$/.test(etag)) return { resourceVersion: etag, validationMethod: 'etag' };
  const modified = httpDate(headers.get('last-modified'));
  const weakEtag = etag && /^W\/"[^\r\n]*"$/.test(etag) ? etag : undefined;
  return modified
    ? { resourceVersion: modified, weakEtag, validationMethod: 'last-modified' }
    : { weakEtag, validationMethod: 'boundary-sample' };
};
