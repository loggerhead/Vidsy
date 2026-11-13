import { LiveSnapshotFailure } from '../../offscreen/lib/download-failure';
import { canonicalHttpSource } from '../../offscreen/lib/http-validator';

export const selectSourceTab = (
  tabId: number | undefined,
  pageUrl: string | undefined,
  tabs: { id?: number; url?: string }[],
): number | undefined => {
  const original = tabs.find(tab => tab.id === tabId);
  if (original && original.id !== undefined && (!pageUrl || original.url === pageUrl)) return original.id;
  if (!pageUrl) return undefined;
  const matches = tabs.filter(tab => tab.id !== undefined && tab.url === pageUrl);
  return matches.length === 1 ? matches[0].id : undefined;
};

// A fresh player URL is only a locator candidate. HTTP checkpoints still need
// matching validators, local hashes and remote samples before that alias is used.
export const selectRenewedUrl = (original: string, candidates: string[]): string | undefined => {
  const old = new URL(original);
  const matches = [...new Set(candidates)].filter(candidate => {
    try {
      const url = new URL(candidate);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === old.origin && url.pathname === old.pathname;
    } catch {
      return false;
    }
  });
  const changed = matches.filter(candidate => candidate !== original);
  if (changed.length === 1) return changed[0];
  if (changed.length > 1) return undefined;
  return matches.includes(original) ? original : undefined;
};

export const renewalChanged = (
  oldUrl: string,
  oldHeaders: Record<string, string> | undefined,
  url: string,
  headers: Record<string, string> | undefined,
): boolean => canonicalHttpSource(oldUrl, oldHeaders) !== canonicalHttpSource(url, headers);

export const isExpiredSourceFailure = (error: unknown): boolean =>
  !(error instanceof LiveSnapshotFailure) &&
  /\b(?:HTTP |Failed to fetch HLS playlist:\s*)(403|410)\b/.test(
    error instanceof Error ? error.message : String(error),
  );
