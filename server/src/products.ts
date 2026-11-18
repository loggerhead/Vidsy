import type { Env } from './env.js';

/**
 * Prices and grants live in the shared catalog so the extension paywall and the
 * Worker cannot drift. Creem only needs the matching product id from
 * PRODUCTS_JSON; the extension only sends a key.
 */
export { PRODUCTS, productFromKey } from '../../packages/shared/lib/license/products.js';
export type { Product, ProductKind } from '../../packages/shared/lib/license/products.js';

/** PRODUCTS_JSON maps productKey -> Creem product id for the current mode. */
export const parseProductIds = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

export const resolveCreemProductId = (env: Env, productKey: string): string | undefined =>
  parseProductIds(env.PRODUCTS_JSON)[productKey];

export const productKeyFromId = (env: Env, productId: string | null | undefined): string | undefined => {
  if (!productId) return undefined;
  const entry = Object.entries(parseProductIds(env.PRODUCTS_JSON)).find(([, id]) => id === productId);
  return entry?.[0];
};
