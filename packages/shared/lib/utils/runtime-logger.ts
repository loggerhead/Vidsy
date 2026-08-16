/**
 * Runtime logging boundary for every extension context (service worker,
 * content script, offscreen document, worker, and React pages).
 *
 * WXT owns build-time diagnostics via `wxt.logger`; this helper deliberately
 * owns browser-runtime diagnostics, where WXT modules do not execute.
 */
const REDACTED = '[REDACTED]';
const REDACTED_BLOB_URL = '[REDACTED_BLOB_URL]';
const URL_PATTERN = /\b(?:https?|ftp|blob):[^\s"'<>]+/gi;

type RuntimeEnv = ImportMeta & { env?: { MODE?: string } };

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

const sanitizeValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return value.replace(URL_PATTERN, match => sanitizeUrl(match));
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: sanitizeValue(value.message, seen) };
  if (value instanceof URL) return sanitizeUrl(value.toString());
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, isSensitiveKey(key) ? REDACTED : sanitizeValue(child, seen)]),
  );
};

export const sanitizeLogData = (data: unknown): unknown => sanitizeValue(data, new WeakSet<object>());

const isDevelopment = (): boolean => (import.meta as RuntimeEnv).env?.MODE !== 'production';
type LogMethod = (event: string, data?: unknown) => void;

export type RuntimeLogger = { debug: LogMethod; info: LogMethod; warn: LogMethod; error: LogMethod };

export const createLogger = (scope: string): RuntimeLogger => {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown): void => {
    if ((level === 'debug' || level === 'info') && !isDevelopment()) return;
    const message = `[Vidsy:${scope}] ${event}`;
    const value = data === undefined ? undefined : sanitizeLogData(data);
    if (level === 'warn') console.warn(message, value ?? '');
    else if (level === 'error') console.error(message, value ?? '');
    else console.debug(message, value ?? '');
  };
  return {
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
};
