import { sanitizeLogData } from '@extension/shared';

type Entry = { at: number; event: string; data: unknown };
const STORAGE_KEY = 'vidsy-download-diagnostics';
const entries: Entry[] = [];
let initialized: Promise<void> | undefined;
let tail = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let revision = 0;

const flush = (): void => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  tail = tail
    .then(async () => {
      initialized ??= chrome.storage.local.get(STORAGE_KEY).then(result => {
        const previous = result[STORAGE_KEY];
        if (Array.isArray(previous)) entries.unshift(...previous.slice(-200));
      });
      await initialized;
      if (!dirty) return;
      entries.splice(0, Math.max(0, entries.length - 200));
      const savedRevision = revision;
      await chrome.storage.local.set({ [STORAGE_KEY]: entries.slice() });
      dirty = revision !== savedRevision;
      if (dirty) timer ??= setTimeout(flush, 5000);
    })
    .catch(error => console.warn('[Vidsy:diagnostics] persist failed', String(error)));
};

export const recordDownloadDiagnostic = (event: string, data?: unknown): void => {
  const sanitized = sanitizeLogData(data);
  // Limit individual records as well as the ring so errors cannot grow storage.
  const encoded = JSON.stringify(sanitized);
  entries.push({
    at: Date.now(),
    event: event.slice(0, 160),
    data: encoded && encoded.length > 2048 ? encoded.slice(0, 2048) : sanitized,
  });
  entries.splice(0, Math.max(0, entries.length - 200));
  dirty = true;
  revision++;
  if (/failed|error|output|cancelled/.test(event)) flush();
  else timer ??= setTimeout(flush, 5000);
};
