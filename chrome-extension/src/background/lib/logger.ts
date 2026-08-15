const REDACTED = '[REDACTED]';
const REDACTED_BLOB_URL = '[REDACTED_BLOB_URL]';
const URL_PATTERN = /\b(?:https?|ftp|blob):[^\s"'<>]+/gi;

const normalizedKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return (
    normalized === 'authorization' ||
    normalized === 'proxyauthorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized === 'referer' ||
    normalized === 'referrer' ||
    normalized === 'origin' ||
    normalized === 'token' ||
    normalized === 'password' ||
    normalized === 'secret' ||
    normalized.endsWith('headers')
  );
};

const sanitizeUrl = (value: string): string => {
  if (value.toLowerCase().startsWith('blob:')) return REDACTED_BLOB_URL;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};

const sanitizeString = (value: string): string => value.replace(URL_PATTERN, match => sanitizeUrl(match));

const sanitizeValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
    };
  }
  if (value instanceof URL) return sanitizeUrl(value.toString());
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, seen));

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(child, seen);
  }
  return sanitized;
};

export const sanitizeLogData = (data: unknown): unknown => sanitizeValue(data, new WeakSet<object>());

export const dlLog = (stage: string, data?: unknown): void => {
  console.log(`[DL_FLOW] ${new Date().toISOString()} | ${stage}`, data === undefined ? '' : sanitizeLogData(data));
};
