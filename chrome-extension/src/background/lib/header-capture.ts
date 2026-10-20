import { dlLog } from './logger';

type CapturedRequestHeaders = {
  url: string;
  timestamp: number;
  tabId: number;
  headers: Record<string, string>;
};

const capturedRequestHeaders = new Map<string, CapturedRequestHeaders>();
const captureHeaders = (url: string, tabId: number, headers: Record<string, string>) => {
  capturedRequestHeaders.set(`${tabId}:${url}`, { url, timestamp: Date.now(), tabId, headers });
};
let shouldCaptureTab: (tabId: number) => boolean = () => true;

const configureHeaderCaptureTabFilter = (filter: (tabId: number) => boolean) => {
  shouldCaptureTab = filter;
};

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
      if (
        !details.requestHeaders ||
        details.initiator?.startsWith('chrome-extension://') ||
        !shouldCaptureTab(details.tabId)
      )
        return;
      const headers = filterCapturedHeaders(details.requestHeaders);
      if (Object.keys(headers).length > 0) {
        captureHeaders(details.url, details.tabId, headers);
      }
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['requestHeaders', 'extraHeaders'],
  );
};

const findCapturedHeaders = (url: string, fallbackKey?: string, tabId?: number): Record<string, string> | undefined => {
  const exact =
    tabId === undefined
      ? [...capturedRequestHeaders.values()]
          .filter(value => value.url === url || value.url === fallbackKey)
          .sort((a, b) => b.timestamp - a.timestamp)[0]
      : (capturedRequestHeaders.get(`${tabId}:${url}`) ??
        (fallbackKey ? capturedRequestHeaders.get(`${tabId}:${fallbackKey}`) : undefined));
  if (exact && (tabId === undefined || exact.tabId === tabId)) return exact.headers;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }

  let latest: CapturedRequestHeaders | undefined;
  for (const captured of capturedRequestHeaders.values()) {
    if (tabId !== undefined && captured.tabId !== tabId) continue;
    try {
      const candidate = new URL(captured.url);
      if (candidate.origin !== target.origin || candidate.pathname !== target.pathname) continue;
      if (!latest || captured.timestamp > latest.timestamp) latest = captured;
    } catch {
      continue;
    }
  }
  return latest?.headers;
};

const clearCapturedHeadersForTab = (tabId: number) => {
  for (const [url, captured] of capturedRequestHeaders) {
    if (captured.tabId === tabId) capturedRequestHeaders.delete(url);
  }
};

// ─── Session-scoped header injection via declarativeNetRequest ───
// fetch() cannot set forbidden headers (Origin, Referer). We use declarativeNetRequest
// to inject them at the network level for CDN requests made by the offscreen document.

let nextDnrRuleId = 1000;
const activeDnrRules = new Map<string, Map<string, number>>();
const activeDownloadHeaders = new Map<string, Record<string, string>>();
const downloadSources = new Map<string, { origin: string; tabId?: number }>();
const persistentUrls = new Map<string, Set<string>>();
const transientUrls = new Map<string, Map<string, number>>();
let ruleTail = Promise.resolve();
const mutateRules = <T>(operation: () => Promise<T>): Promise<T> => {
  const pending = ruleTail.then(operation);
  ruleTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};
const DNR_STATE_KEY = 'vidsy-header-rules';
let dnrReady: Promise<void> | undefined;
const restoreDnrState = () =>
  (dnrReady ??= (async () => {
    if (!chrome.storage?.session) return;
    const data = (await chrome.storage.session.get(DNR_STATE_KEY))[DNR_STATE_KEY];
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    nextDnrRuleId = Math.max(1000, ...rules.map(rule => rule.id + 1));
    if (!data) return;
    const existing = new Set(rules.map(rule => rule.id));
    for (const [key, record] of Object.entries(data) as Array<
      [
        string,
        {
          rules: [string, number][];
          headers: Record<string, string>;
          source: { origin: string; tabId?: number };
          persistent?: string[];
          transient?: [string, number][];
        },
      ]
    >) {
      activeDnrRules.set(key, new Map(record.rules.filter(([, id]) => existing.has(id))));
      activeDownloadHeaders.set(key, record.headers);
      downloadSources.set(key, record.source);
      persistentUrls.set(key, new Set(record.persistent ?? record.rules.map(([url]) => url)));
      transientUrls.set(key, new Map(record.transient ?? []));
    }
  })());
const persistDnrState = async () => {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({
    [DNR_STATE_KEY]: Object.fromEntries(
      [...activeDnrRules].map(([key, rules]) => [
        key,
        {
          rules: [...rules],
          headers: activeDownloadHeaders.get(key),
          source: downloadSources.get(key),
          persistent: [...(persistentUrls.get(key) ?? [])],
          transient: [...(transientUrls.get(key) ?? [])],
        },
      ]),
    ),
  });
};

const headersForDnr = (headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] =>
  Object.entries(headers)
    .filter(([name]) => !name.toLowerCase().startsWith('sec-fetch-'))
    .map(([name, value]) => ({
      header: name,
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value,
    }));

const injectHeaders = async (
  cdnUrl: string,
  headers: Record<string, string>,
  downloadKey: string,
  tabId?: number,
  transient = false,
) => {
  try {
    await restoreDnrState();
    const target = new URL(cdnUrl);
    const hostname = target.hostname;
    const rulesByHost = activeDnrRules.get(downloadKey) ?? new Map<string, number>();
    if (transient) {
      const counts = transientUrls.get(downloadKey) ?? new Map<string, number>();
      counts.set(cdnUrl, (counts.get(cdnUrl) ?? 0) + 1);
      transientUrls.set(downloadKey, counts);
    } else {
      const urls = persistentUrls.get(downloadKey) ?? new Set<string>();
      urls.add(cdnUrl);
      persistentUrls.set(downloadKey, urls);
    }
    if (rulesByHost.has(cdnUrl)) {
      await persistDnrState();
      return;
    }
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
            regexFilter: `^${cdnUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
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

    rulesByHost.set(cdnUrl, ruleId);
    activeDnrRules.set(downloadKey, rulesByHost);
    if (!activeDownloadHeaders.has(downloadKey)) {
      activeDownloadHeaders.set(downloadKey, headers);
      downloadSources.set(downloadKey, { origin: target.origin, tabId });
    }
    await persistDnrState();
    dlLog('injectHeadersForDownload: added DNR rule', { ruleId, hostname, headers });
  } catch (err) {
    dlLog('injectHeadersForDownload: failed', err);
    throw err;
  }
};

const injectHeadersForDownload = (url: string, headers: Record<string, string>, key: string, tabId?: number) =>
  mutateRules(() => injectHeaders(url, headers, key, tabId));

const authorizeUrlForDownload = (downloadKey: string, url: string, transient = false) =>
  mutateRules(async () => {
    await restoreDnrState();
    const headers = activeDownloadHeaders.get(downloadKey);
    if (!headers) return;
    const source = downloadSources.get(downloadKey);
    const targetHeaders =
      new URL(url).origin === source?.origin
        ? headers
        : source?.tabId === undefined
          ? undefined
          : findCapturedHeaders(url, undefined, source.tabId);
    // A manifest naming a third party is not authority to forward source cookies
    // or bearer tokens there. Only a captured request for that target can grant it.
    if (targetHeaders) await injectHeaders(url, targetHeaders, downloadKey, source?.tabId, transient);
  });

const releaseUrlForDownload = (downloadKey: string, url: string) =>
  mutateRules(async () => {
    await restoreDnrState();
    const counts = transientUrls.get(downloadKey);
    const count = counts?.get(url) ?? 0;
    if (count > 1) counts!.set(url, count - 1);
    else {
      counts?.delete(url);
      const rules = activeDnrRules.get(downloadKey);
      const id = rules?.get(url);
      if (id !== undefined && !persistentUrls.get(downloadKey)?.has(url)) {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: [id] });
        rules!.delete(url);
      }
    }
    await persistDnrState();
  });

const removeHeadersForDownload = (downloadKey: string) =>
  mutateRules(async () => {
    await restoreDnrState();
    const rulesByHost = activeDnrRules.get(downloadKey);
    const ruleIds = rulesByHost ? [...rulesByHost.values()] : [];
    if (ruleIds.length === 0) {
      activeDnrRules.delete(downloadKey);
      activeDownloadHeaders.delete(downloadKey);
      downloadSources.delete(downloadKey);
      persistentUrls.delete(downloadKey);
      transientUrls.delete(downloadKey);
      await persistDnrState();
      return;
    }
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [],
        removeRuleIds: ruleIds,
      });
      dlLog('removeHeadersForDownload: removed DNR rules', { ruleIds });
    } catch (err) {
      dlLog('removeHeadersForDownload: failed', err);
      throw err;
    }
    activeDnrRules.delete(downloadKey);
    activeDownloadHeaders.delete(downloadKey);
    downloadSources.delete(downloadKey);
    persistentUrls.delete(downloadKey);
    transientUrls.delete(downloadKey);
    await persistDnrState();
  });

const cleanupStaleDnrRules = async () => {
  await chrome.declarativeNetRequest.getSessionRules().then(async rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
  await chrome.declarativeNetRequest.getDynamicRules().then(async rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
  activeDnrRules.clear();
  activeDownloadHeaders.clear();
  downloadSources.clear();
  persistentUrls.clear();
  transientUrls.clear();
  dnrReady = undefined;
  await chrome.storage.session.remove(DNR_STATE_KEY);
};

export {
  capturedRequestHeaders,
  captureHeaders,
  configureHeaderCaptureTabFilter,
  findCapturedHeaders,
  clearCapturedHeadersForTab,
  headersForDnr,
  setupHeaderCapture,
  injectHeadersForDownload,
  authorizeUrlForDownload,
  releaseUrlForDownload,
  removeHeadersForDownload,
  cleanupStaleDnrRules,
};
