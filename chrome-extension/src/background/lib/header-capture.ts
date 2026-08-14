import { dlLog } from './logger';

type CapturedRequestHeaders = {
  timestamp: number;
  tabId: number;
  headers: Record<string, string>;
};

const capturedRequestHeaders = new Map<string, CapturedRequestHeaders>();

const filterCapturedHeaders = (headers: chrome.webRequest.HttpHeader[]) => {
  // Capture all critical anti-bot / CDN validation headers
  const allowed = [
    /^Referer$/i,
    /^Cookie$/i,
    /^Origin$/i,
    /^Authorization$/i,
    /^Sec-Fetch-/i,
    /^User-Agent$/i,
    /^Accept$/i,
    /^Accept-Language$/i,
  ];
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name && h.value && allowed.some(regex => regex.test(h.name))) {
      out[h.name] = h.value;
    }
  }
  return out;
};

const setupHeaderCapture = () => {
  chrome.webRequest.onSendHeaders.addListener(
    details => {
      if (!details.requestHeaders || details.initiator?.startsWith('chrome-extension://')) return;
      const headers = filterCapturedHeaders(details.requestHeaders);
      if (Object.keys(headers).length > 0) {
        capturedRequestHeaders.set(details.url, { timestamp: Date.now(), tabId: details.tabId, headers });
      }
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['requestHeaders', 'extraHeaders'],
  );
};

const findCapturedHeaders = (url: string, fallbackKey?: string, tabId?: number): Record<string, string> | undefined => {
  const exact = capturedRequestHeaders.get(url) ?? (fallbackKey ? capturedRequestHeaders.get(fallbackKey) : undefined);
  if (exact && (tabId === undefined || exact.tabId === tabId)) return exact.headers;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }

  let latest: CapturedRequestHeaders | undefined;
  for (const [capturedUrl, captured] of capturedRequestHeaders) {
    if (tabId !== undefined && captured.tabId !== tabId) continue;
    try {
      const candidate = new URL(capturedUrl);
      if (candidate.origin !== target.origin || candidate.pathname !== target.pathname) continue;
      if (!latest || captured.timestamp > latest.timestamp) latest = captured;
    } catch {
      continue;
    }
  }
  return latest?.headers;
};

// ─── Session-scoped header injection via declarativeNetRequest ───
// fetch() cannot set forbidden headers (Origin, Referer). We use declarativeNetRequest
// to inject them at the network level for CDN requests made by the offscreen document.

let nextDnrRuleId = 1000;
const activeDnrRules = new Map<string, Map<string, number>>();
const activeDownloadHeaders = new Map<string, Record<string, string>>();

const headersForDnr = (headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] =>
  Object.entries(headers)
    .filter(([name]) => !name.toLowerCase().startsWith('sec-fetch-'))
    .map(([name, value]) => ({
      header: name,
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value,
    }));

const injectHeadersForDownload = async (cdnUrl: string, headers: Record<string, string>, downloadKey: string) => {
  try {
    const hostname = new URL(cdnUrl).hostname;
    const rulesByHost = activeDnrRules.get(downloadKey) ?? new Map<string, number>();
    if (rulesByHost.has(hostname)) return;
    const requestHeaders = headersForDnr(headers);

    if (requestHeaders.length === 0) return;

    const ruleId = nextDnrRuleId++;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders,
          },
          condition: {
            requestDomains: [hostname],
            // tabIds: [-1] scopes the rewrite to extension-originated requests
            // (offscreen doc, service worker). Without this, the Referer/Origin
            // rewrite leaks into normal browsing on any open tab that hits the
            // same CDN hostname.
            tabIds: [-1],
            // Omit resourceTypes so it catches sub_frame, media, xmlhttprequest, etc.
          },
        },
      ],
      removeRuleIds: [ruleId],
    });

    rulesByHost.set(hostname, ruleId);
    activeDnrRules.set(downloadKey, rulesByHost);
    activeDownloadHeaders.set(downloadKey, headers);
    dlLog('injectHeadersForDownload: added DNR rule', { ruleId, hostname, headers });
  } catch (err) {
    dlLog('injectHeadersForDownload: failed', err);
    throw err;
  }
};

const authorizeUrlForDownload = async (downloadKey: string, url: string) => {
  const headers = activeDownloadHeaders.get(downloadKey);
  if (!headers) return;
  await injectHeadersForDownload(url, headers, downloadKey);
};

const removeHeadersForDownload = async (downloadKey: string) => {
  const rulesByHost = activeDnrRules.get(downloadKey);
  const ruleIds = rulesByHost ? [...rulesByHost.values()] : [];
  activeDownloadHeaders.delete(downloadKey);
  if (ruleIds.length === 0) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: ruleIds,
    });
    dlLog('removeHeadersForDownload: removed DNR rules', { ruleIds });
  } catch (err) {
    dlLog('removeHeadersForDownload: failed', err);
  }
  activeDnrRules.delete(downloadKey);
};

const cleanupStaleDnrRules = () => {
  chrome.declarativeNetRequest.getSessionRules().then(rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
  chrome.declarativeNetRequest.getDynamicRules().then(rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
};

export {
  capturedRequestHeaders,
  findCapturedHeaders,
  headersForDnr,
  setupHeaderCapture,
  injectHeadersForDownload,
  authorizeUrlForDownload,
  removeHeadersForDownload,
  cleanupStaleDnrRules,
};
