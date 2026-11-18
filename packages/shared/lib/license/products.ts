/**
 * Billing product catalog shared by the Worker (authoritative grants) and the
 * extension (paywall labels). Prices are integers in cents; the Creem product
 * id mapping lives in the Worker's PRODUCTS_JSON secret, never here.
 */
export type ProductKind = 'credits' | 'subscription';

export type Product = {
  key: string;
  kind: ProductKind;
  credits: number;
  priceCents: number;
  currency: 'USD';
  interval: 'every-month' | 'every-year' | null;
  licenseActivationLimit: number;
};

export const PRODUCTS: Record<string, Product> = {
  credits_10: {
    key: 'credits_10',
    kind: 'credits',
    credits: 10,
    priceCents: 299,
    currency: 'USD',
    interval: null,
    licenseActivationLimit: 3,
  },
  credits_50: {
    key: 'credits_50',
    kind: 'credits',
    credits: 50,
    priceCents: 699,
    currency: 'USD',
    interval: null,
    licenseActivationLimit: 3,
  },
  credits_120: {
    key: 'credits_120',
    kind: 'credits',
    credits: 120,
    priceCents: 999,
    currency: 'USD',
    interval: null,
    licenseActivationLimit: 3,
  },
  credits_300: {
    key: 'credits_300',
    kind: 'credits',
    credits: 300,
    priceCents: 1999,
    currency: 'USD',
    interval: null,
    licenseActivationLimit: 3,
  },
  pro_monthly: {
    key: 'pro_monthly',
    kind: 'subscription',
    credits: 0,
    priceCents: 499,
    currency: 'USD',
    interval: 'every-month',
    licenseActivationLimit: 3,
  },
  pro_yearly: {
    key: 'pro_yearly',
    kind: 'subscription',
    credits: 0,
    priceCents: 3900,
    currency: 'USD',
    interval: 'every-year',
    licenseActivationLimit: 3,
  },
};

export const productFromKey = (key: string): Product | undefined =>
  Object.prototype.hasOwnProperty.call(PRODUCTS, key) ? PRODUCTS[key] : undefined;

export const formatPrice = (product: Pick<Product, 'priceCents' | 'currency'>): string =>
  `$${(product.priceCents / 100).toFixed(2)}`;
