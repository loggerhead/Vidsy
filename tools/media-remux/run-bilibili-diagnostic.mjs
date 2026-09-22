import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
// WXT's authoritative unpacked output. Keep the override for testing an
// explicitly supplied artifact; never silently fall back to the frozen
// pre-migration `dist/` tree.
const extensionDirectory = path.resolve(
  process.env.VIDSY_EXTENSION_DIR ?? path.join(repositoryRoot, '.output/chrome-mv3'),
);
const bilibiliUrl =
  process.env.VIDSY_BILIBILI_URL ??
  'https://www.bilibili.com/video/BV1HnM269EV7/?spm_id_from=333.1007.tianma.1-3-3.click&vd_source=94e84eeb9c84c0082db21db3c32160ff';
const chromeBinary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keepArtifacts = process.env.VIDSY_BILIBILI_KEEP_ARTIFACTS === '1';
const autoDownload = process.env.VIDSY_BILIBILI_AUTO_DOWNLOAD !== '0';
const suppliedProfile = process.env.VIDSY_BILIBILI_PROFILE;
const runId = `bilibili-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
const artifactDirectory = path.resolve(
  process.env.VIDSY_BILIBILI_ARTIFACT_DIR ?? path.join(repositoryRoot, '.e2e-artifacts', runId),
);
const reportPath = path.join(artifactDirectory, 'events.jsonl');
const profileDirectory = suppliedProfile ?? path.join(artifactDirectory, 'profile');
const downloadDirectory = path.join(artifactDirectory, 'downloads');
const minimumBytes = 1024 * 1024;

await mkdir(downloadDirectory, { recursive: true });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const safeUrl = value => {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
};

const safeValue = value => {
  if (typeof value === 'string') {
    if (/^(https?|chrome-extension):\/\//.test(value)) return safeUrl(value);
    return value.replaceAll(/(cookie|authorization|token|signature|secret|key)=?[^\s&]*/gi, '$1=<REDACTED>');
  }
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safeValue(child)]));
  }
  return value;
};

const logFile = await import('node:fs/promises').then(({ open }) => open(reportPath, 'a'));
const report = async (target, event, data = {}) => {
  const entry = { ts: new Date().toISOString(), runId, target, event, data: safeValue(data) };
  await logFile.write(`${JSON.stringify(entry)}\n`);
  console.log(JSON.stringify(entry));
};

class Cdp {
  constructor(url, target) {
    this.url = url;
    this.target = target;
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  on(handler) {
    this.handlers.add(handler);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async sendAndForget(method, params = {}) {
    await this.ready;
    this.socket.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  async close() {
    await this.ready.catch(() => undefined);
    this.socket.close();
  }
}

const evaluate = async (client, expression) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

const json = async (port, route) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!response.ok) throw new Error(`CDP endpoint ${route} failed: ${response.status}`);
  return response.json();
};

const chrome = spawn(
  chromeBinary,
  [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let chromeErrors = '';
let chromeSpawnError;
chrome.on('error', error => {
  chromeSpawnError = error;
});
chrome.stderr.on('data', chunk => {
  chromeErrors += chunk.toString();
});

const portFile = path.join(profileDirectory, 'DevToolsActivePort');
let debuggerPort;
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    debuggerPort = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
    break;
  } catch {
    await sleep(100);
  }
}
if (!debuggerPort) {
  throw new Error(
    `Chrome did not expose DevToolsActivePort${chromeSpawnError ? `: ${chromeSpawnError.message}` : ''}\n${chromeErrors}`,
  );
}

const browserInfo = await json(debuggerPort, '/json/version');
const browser = new Cdp(browserInfo.webSocketDebuggerUrl, { type: 'browser' });
const clients = new Map();
let pageClient;
let workerClient;
let extensionOrigin;

const mediaRequest = url =>
  typeof url === 'string' &&
  (/\.mpd(?:$|\?)/i.test(url) ||
    /\.m3u8(?:$|\?)/i.test(url) ||
    /\.(?:m4s|mp4)(?:$|\?)/i.test(url) ||
    /playurl|x\/player\/playurl/i.test(url));

const attachTarget = async target => {
  // Chrome exposes internal UI/background targets that either do not
  // implement Runtime.enable or never answer it. They are irrelevant to this
  // diagnostic and previously prevented us from reaching the Vidsy worker.
  if (!['page', 'service_worker', 'worker'].includes(target.type)) return undefined;
  if (!target.webSocketDebuggerUrl || clients.has(target.id)) return clients.get(target.id);
  const client = new Cdp(target.webSocketDebuggerUrl, target);
  clients.set(target.id, client);
  client.on(message => {
    if (message.method === 'Runtime.consoleAPICalled') {
      const args = (message.params.args ?? []).map(arg => arg.value ?? arg.description);
      void report(target.type, 'console', { url: target.url, level: message.params.type, args });
    }
    if (message.method === 'Runtime.exceptionThrown') {
      void report(target.type, 'exception', { url: target.url, details: message.params.exceptionDetails });
    }
    if (
      message.method === 'Network.requestWillBeSent' &&
      (mediaRequest(message.params.request.url) || target.type === 'page')
    ) {
      void report(target.type, 'network.request', {
        requestId: message.params.requestId,
        url: message.params.request.url,
        method: message.params.request.method,
        hasCookie: Boolean(message.params.request.headers?.Cookie || message.params.request.headers?.cookie),
        hasReferer: Boolean(message.params.request.headers?.Referer || message.params.request.headers?.referer),
      });
    }
    if (
      message.method === 'Network.responseReceived' &&
      (mediaRequest(message.params.response.url) || target.type === 'page')
    ) {
      void report(target.type, 'network.response', {
        requestId: message.params.requestId,
        url: message.params.response.url,
        status: message.params.response.status,
        mimeType: message.params.response.mimeType,
        contentLength: message.params.response.headers?.['content-length'],
        contentRange: message.params.response.headers?.['content-range'],
      });
    }
    if (message.method === 'Network.loadingFailed' && target.type === 'page') {
      void report(target.type, 'network.loadingFailed', {
        requestId: message.params.requestId,
        errorText: message.params.errorText,
        canceled: message.params.canceled,
      });
    }
  });
  await client.send('Runtime.enable');
  await client.send('Log.enable').catch(() => undefined);
  if (target.type === 'page' || target.type === 'service_worker' || target.type === 'worker') {
    await client.send('Network.enable').catch(() => undefined);
  }
  await report(target.type, 'target.attached', { id: target.id, url: target.url });
  if (target.type === 'page' && !target.url.startsWith('chrome-extension://')) pageClient = client;
  if (target.type === 'service_worker' && target.url.startsWith('chrome-extension://')) {
    const isVidsy = await evaluate(
      client,
      `(() => {
        try {
          const manifest = chrome.runtime.getManifest();
          return manifest.permissions?.includes('offscreen') && manifest.permissions?.includes('unlimitedStorage');
        } catch {
          return false;
        }
      })()`,
    ).catch(() => false);
    await report(target.type, 'target.classified', { id: target.id, isVidsy });
    if (isVidsy) {
      workerClient = client;
      extensionOrigin = new URL(target.url).origin;
    }
  }
  return client;
};

const refreshTargets = async () => {
  const targets = await json(debuggerPort, '/json/list');
  for (const target of targets) await attachTarget(target);
  return targets;
};

const waitFor = async (predicate, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await refreshTargets();
    const target = targets.find(predicate);
    if (target) return target;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const storageSnapshot = async () => {
  if (!workerClient) return undefined;
  return evaluate(
    workerClient,
    `(() => chrome.storage.session.get(['media-detections', 'media-downloads', 'vidsy-download-runtime']))()`,
  );
};

const pageSnapshot = async () => {
  if (!pageClient) return undefined;
  return evaluate(
    pageClient,
    `(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500),
      contentUi: Boolean(document.querySelector('#CEB-extension-all')),
      performanceEntries: performance.getEntriesByType('resource').length,
    }))()`,
  ).catch(error => ({ error: error.message }));
};

const waitForDetection = async () => {
  const deadline = Date.now() + 180_000;
  let last;
  let snapshotNumber = 0;
  while (Date.now() < deadline) {
    await refreshTargets();
    last = await storageSnapshot();
    await report('service_worker', 'storage.snapshot', last ?? {});
    if (snapshotNumber++ % 5 === 0) await report('page', 'state.snapshot', await pageSnapshot());
    const items = Object.values(last?.['media-detections'] ?? {}).flat();
    const candidate = items.find(
      item =>
        item.pageUrl &&
        safeUrl(item.pageUrl) === safeUrl(bilibiliUrl) &&
        item.kind === 'video' &&
        item.url?.startsWith('http') &&
        item.audioUrl?.startsWith('http') &&
        item.variants?.length > 0,
    );
    if (candidate) return candidate;
    await sleep(1000);
  }
  throw new Error(`No detection for Bilibili page: ${JSON.stringify(last)}`);
};

const waitForProgress = async key => {
  const deadline = Date.now() + 15 * 60_000;
  let last;
  while (Date.now() < deadline) {
    await refreshTargets();
    const snapshot = await storageSnapshot();
    last = Object.values(snapshot?.['media-downloads'] ?? {}).find(progress => progress.key === key);
    if (last) await report('service_worker', 'progress.snapshot', last);
    if (last?.stage === 'success' || last?.stage === 'failed' || last?.stage === 'cancelled') return last;
    await sleep(1000);
  }
  throw new Error(`Download did not reach a terminal state: ${JSON.stringify(last)}`);
};

let failure;
try {
  await report('runner', 'run.start', {
    url: bilibiliUrl,
    profile: suppliedProfile ? '[SUPPLIED_PROFILE]' : '[TEMP_PROFILE]',
    autoDownload,
    artifactDirectory,
  });
  const workerDeadline = Date.now() + 120_000;
  while (!workerClient && Date.now() < workerDeadline) {
    await refreshTargets();
    await sleep(250);
  }
  if (!workerClient) {
    throw new Error(
      `Vidsy service worker was not found. The selected browser may reject --load-extension; use Chromium or Chrome for Testing and set CHROME_BIN.\n${chromeErrors}`,
    );
  }
  await report('runner', 'worker.ready');
  const createdTarget = await browser.send('Target.createTarget', { url: bilibiliUrl });
  await report('browser', 'target.created', { targetId: createdTarget.targetId, url: bilibiliUrl });
  const pageTarget = await waitFor(target => target.id === createdTarget.targetId, 'Bilibili page');
  await report('runner', 'page.ready', { id: pageTarget.id, url: pageTarget.url });
  pageClient = clients.get(pageTarget.id) ?? (await attachTarget(pageTarget));
  await pageClient.sendAndForget('Page.navigate', { url: bilibiliUrl });
  await report('page', 'navigate', { url: bilibiliUrl });

  const detection = await waitForDetection();
  await report('runner', 'detection.ready', {
    id: detection.id,
    kind: detection.kind,
    source: detection.source,
    url: detection.url,
    variantCount: detection.variants?.length ?? 0,
    variants: detection.variants?.map(variant => ({
      url: variant.url,
      resolution: variant.resolution,
      bandwidth: variant.bandwidth,
      hasAudio: Boolean(variant.audioUrl),
    })),
  });
  // Availability depends on account and Bilibili's current quality selection.
  // The detection contract is a fetchable video+audio presentation, not an
  // arbitrary minimum number of quality variants.

  if (autoDownload) {
    const clicked = await evaluate(
      pageClient,
      `(() => {
        const host = document.querySelector('#CEB-extension-all');
        const button = [...(host?.shadowRoot?.querySelectorAll('button') ?? [])]
          .find(element => element.textContent?.includes('Download'));
        if (!button) return false;
        button.click();
        return true;
      })()`,
    );
    await report('page', 'download.click', { clicked, itemId: detection.id });
    if (!clicked) throw new Error('Download button was not found in content UI shadow root');
    const progress = await waitForProgress(detection.id);
    if (progress.stage !== 'success') throw new Error(`Download failed: ${JSON.stringify(progress)}`);
    if (progress.downloadId === undefined) throw new Error('Successful progress has no downloadId');
    const download = await evaluate(
      workerClient,
      `(async () => (await chrome.downloads.search({ id: ${progress.downloadId} }))[0])()`,
    );
    await report('service_worker', 'download.completed', {
      downloadId: progress.downloadId,
      filename: download?.filename,
      state: download?.state,
      fileSize: download?.fileSize,
    });
    if (!download?.filename) throw new Error('Chrome download has no filename');
    const info = await stat(download.filename);
    if (info.size <= minimumBytes) throw new Error(`Downloaded file is too small: ${info.size}`);
  }
  await report('runner', 'run.success', { detectionId: detection.id });
} catch (error) {
  failure = error;
  await report('runner', 'run.failure', { name: error?.name, message: error?.message, stack: error?.stack });
} finally {
  for (const client of clients.values()) await client.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  chrome.kill('SIGTERM');
  await logFile.close();
  if (!suppliedProfile && !keepArtifacts) await rm(profileDirectory, { recursive: true, force: true });
  if (!keepArtifacts && !suppliedProfile) {
    // Keep the report and downloaded file by default; only the temporary Chrome profile is disposable.
  }
  console.error(`Bilibili diagnostic report: ${reportPath}`);
}

if (failure) throw failure;
