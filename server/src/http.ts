/* eslint-disable import-x/exports-last */
import type { UpgradeOptions } from './contract.js';
import type { Env } from './env.js';

export const intFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getClientIp = (request: Request): string => {
  const forwarded = request.headers.get('X-Forwarded-For');
  return (
    request.headers.get('CF-Connecting-IP') ??
    forwarded?.split(',')[0]?.trim() ??
    request.headers.get('X-Real-IP') ??
    'unknown'
  );
};

const DEFAULT_OPTIONS_URL = 'chrome-extension://<store-id>/options.html#license';
const DEFAULT_PRICING_URL = 'https://uu0uu.com/pricing';

export const upgradeOptions = (env: Env): UpgradeOptions => ({
  optionsUrl: env.EXTENSION_OPTIONS_URL || DEFAULT_OPTIONS_URL,
  pricingUrl: env.PRICING_URL || DEFAULT_PRICING_URL,
});

/**
 * Extension origins are chrome-extension://<id>; any id is accepted because the
 * Bearer token, not CORS, is the security boundary. Additional web origins come
 * from CORS_ORIGINS (comma separated, `*` allows everything).
 */
export const isAllowedOrigin = (origin: string, configured: string | undefined): boolean => {
  if (origin.startsWith('chrome-extension://')) return true;
  const entries = (configured ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return true;
  return entries.includes(origin);
};

export const corsHeaders = (origin: string | null, env: Env): Record<string, string> | null => {
  if (!origin || !isAllowedOrigin(origin, env.CORS_ORIGINS)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
};
