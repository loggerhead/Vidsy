/* eslint-disable import-x/exports-last */
import type { Env } from './env.js';

export type CreemCheckoutResponse = {
  checkout_url?: string;
  checkoutUrl?: string;
  id?: string;
};

export type CreemPortalResponse = {
  customer_portal_link?: string;
  customerPortalLink?: string;
};

export type CreemLicenseResponse = {
  license?: { id?: string; status?: string };
  instance?: { id?: string };
};

export type CreemClient = {
  createCheckout: (input: Record<string, unknown>) => Promise<CreemCheckoutResponse>;
  createPortalLink: (customerId: string) => Promise<CreemPortalResponse>;
  activateLicense: (key: string, instanceName: string) => Promise<CreemLicenseResponse>;
  validateLicense: (key: string, instanceId?: string) => Promise<CreemLicenseResponse>;
  deactivateLicense: (key: string, instanceId: string) => Promise<unknown>;
};

export class CreemError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CreemError';
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.creem.io';

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200);
  }
  return null;
};

/**
 * Thin fetch wrapper around the Creem REST API. No SDK: the Worker only needs
 * five endpoints and must keep the API key server-side.
 */
export const createCreemClient = (options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): CreemClient => {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': options.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new CreemError(extractErrorMessage(payload) ?? `creem_request_failed:${response.status}`, response.status);
    }
    return (payload ?? {}) as T;
  };

  return {
    createCheckout: input => post<CreemCheckoutResponse>('/v1/checkouts', input),
    createPortalLink: customerId => post<CreemPortalResponse>('/v1/customers/billing', { customer_id: customerId }),
    activateLicense: (key, instanceName) =>
      post<CreemLicenseResponse>('/v1/licenses/activate', { key, instance_name: instanceName }),
    validateLicense: (key, instanceId) =>
      post<CreemLicenseResponse>('/v1/licenses/validate', {
        key,
        ...(instanceId ? { instance_id: instanceId } : {}),
      }),
    deactivateLicense: (key, instanceId) => post<unknown>('/v1/licenses/deactivate', { key, instance_id: instanceId }),
  };
};

export const creemClientFromEnv = (env: Env): CreemClient | null => {
  if (!env.CREEM_API_KEY) return null;
  return createCreemClient({
    apiKey: env.CREEM_API_KEY,
    baseUrl: env.CREEM_API_BASE,
    // Test-only injection hook; never set in production bindings.
    fetchImpl: env.CREEM_FETCH ?? fetch,
  });
};
