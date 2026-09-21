import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const extensionDirectory = process.env.VIDSY_EXTENSION_DIR ?? path.join(repositoryRoot, '.output/chrome-mv3');
const extensionManifest = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
const popupPath = extensionManifest.action?.default_popup ?? 'popup.html';
const fixtureDirectory = process.env.VIDSY_MEDIA_FIXTURES ?? '/tmp/vidsy-web-media-remux/fixtures-full';
const chromeBinary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const e2eRoot = await mkdtemp(path.join(os.tmpdir(), 'vidsy-extension-e2e-'));
const profileDirectory = path.join(e2eRoot, 'profile');
const downloadDirectory = path.join(e2eRoot, 'downloads');
await mkdir(downloadDirectory, { recursive: true });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    const playlistUrl = '/hevc/playlist.m3u8';
    const html = `<!doctype html><meta charset="utf-8"><title>Vidsy HEVC Fixture</title>
      <button id="load">Load media</button>
      <script>document.querySelector('#load').onclick = () => fetch(${JSON.stringify(playlistUrl)});</script>`;
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) });
    response.end(html);
    return;
  }

  let sourcePath;
  let contentType;
  if (url.pathname === '/hevc/playlist.m3u8') {
    const playlist =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.026667,\nsegment.ts\n#EXT-X-ENDLIST\n';
    response.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'content-length': Buffer.byteLength(playlist),
    });
    response.end(playlist);
    return;
  }
  if (url.pathname === '/hevc/segment.ts') {
    sourcePath = path.join(fixtureDirectory, 'hls-ts-hevc.ts');
    contentType = 'video/mp2t';
  } else {
    response.writeHead(404);
    response.end();
    return;
  }

  const body = await readFile(sourcePath);
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-type': contentType,
      'content-length': body.byteLength,
    });
    response.end(body);
    return;
  }
  const start = Number(match[1]);
  if (start >= body.byteLength) {
    response.writeHead(416, { 'content-range': `bytes */${body.byteLength}` });
    response.end();
    return;
  }
  const end = Math.min(match[2] ? Number(match[2]) : body.byteLength - 1, body.byteLength - 1);
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-type': contentType,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${body.byteLength}`,
  });
  response.end(body.subarray(start, end + 1));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === 'string') throw new Error('Failed to start E2E fixture server');
const fixturePageUrl = `http://127.0.0.1:${serverAddress.port}/`;

const chrome = spawn(
  chromeBinary,
  [
    ...(process.env.VIDSY_E2E_HEADLESS === '1' ? ['--headless=new'] : []),
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
chrome.stderr.on('data', chunk => {
  chromeErrors += chunk.toString();
});

const portFile = path.join(profileDirectory, 'DevToolsActivePort');
let debuggerPort;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    debuggerPort = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
    break;
  } catch {
    await sleep(100);
  }
}
if (!debuggerPort) throw new Error(`Chrome did not expose DevToolsActivePort\n${chromeErrors}`);

const json = async route => {
  const response = await fetch(`http://127.0.0.1:${debuggerPort}${route}`);
  if (!response.ok) throw new Error(`CDP endpoint ${route} failed: ${response.status}`);
  return response.json();
};

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

const evaluate = async (client, expression, awaitPromise = true) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

const waitForTarget = async (predicate, label) => {
  let targets = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    targets = await json('/json/list');
    const target = targets.find(predicate);
    if (target) return target;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(targets.map(({ type, url }) => ({ type, url })))}`);
};

const waitForVidsyWorker = async () => {
  let targets = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    targets = await json('/json/list');
    for (const target of targets.filter(
      item => item.type === 'service_worker' && item.url.startsWith('chrome-extension://'),
    )) {
      const candidate = new Cdp(target.webSocketDebuggerUrl);
      try {
        await candidate.send('Runtime.enable');
        const isVidsy = await evaluate(
          candidate,
          `(() => {
            const manifest = chrome.runtime.getManifest();
            return manifest.permissions?.includes('offscreen') && manifest.permissions?.includes('unlimitedStorage');
          })()`,
        );
        if (isVidsy) return { target, client: candidate };
      } catch {
        // The target may close while the extension service worker is starting.
      }
      candidate.close();
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for Vidsy service worker: ${JSON.stringify(targets.map(({ type, url }) => ({ type, url })))}`,
  );
};

const browserInfo = await json('/json/version');
const browser = new Cdp(browserInfo.webSocketDebuggerUrl);
let page;
let worker;
let popup;

try {
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDirectory,
    eventsEnabled: true,
  });

  const blankTarget = await waitForTarget(
    target => target.type === 'page' && target.url === 'about:blank',
    'blank page',
  );
  page = new Cdp(blankTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: fixturePageUrl });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await evaluate(page, 'document.readyState')) === 'complete') break;
    await sleep(50);
  }
  const vidsyWorker = await waitForVidsyWorker();
  worker = vidsyWorker.client;
  await evaluate(page, "document.querySelector('#load').click()");

  let detection;
  for (let attempt = 0; attempt < 150; attempt++) {
    detection = await evaluate(
      worker,
      `(async () => {
        const state = (await chrome.storage.session.get('media-detections'))['media-detections'] || {};
        const items = Object.values(state).flat();
        return items.find(item => item.url.includes('/hevc/playlist.m3u8'));
      })()`,
    );
    if (detection) break;
    await sleep(100);
  }
  if (!detection) throw new Error('Generic network detection did not capture the HEVC HLS fixture');

  const extensionUrl = new URL(vidsyWorker.target.url);
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  await browser.send('Target.createTarget', { url: `${extensionOrigin}/${popupPath}` });
  const popupTarget = await waitForTarget(
    target => target.url === `${extensionOrigin}/${popupPath}` && target.type !== 'service_worker',
    'extension popup',
  );
  popup = new Cdp(popupTarget.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await popup.send('Page.enable');

  let mediaVisible = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    mediaVisible = await evaluate(
      popup,
      `Boolean(document.body?.innerText.includes('Download') && document.body.innerText.includes('HLS'))`,
    );
    if (mediaVisible) break;
    await sleep(100);
  }
  if (!mediaVisible) throw new Error('Popup did not display the generic HLS detection');

  // Regression: the popup media card must consume the same live progress
  // entry as the content overlay. Use a fixed snapshot so this assertion is
  // deterministic and does not depend on fixture download speed.
  await evaluate(
    worker,
    `(async () => {
      const key = ${JSON.stringify(detection.id)};
      await chrome.storage.session.set({
        'media-downloads': {
          [key]: {
            key,
            stage: 'download-video',
            downloadedBytes: 23,
            estimatedBytes: 100,
            item: ${JSON.stringify(detection)},
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
    })()`,
  );
  let popupShowsProgress = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    popupShowsProgress = await evaluate(
      popup,
      `document.body?.innerText.includes('23%') &&
       ![...document.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Download')`,
    );
    if (popupShowsProgress) break;
    await sleep(100);
  }
  if (!popupShowsProgress) {
    const popupText = await evaluate(popup, `document.body?.innerText`);
    throw new Error(`Popup media card did not render live 23% progress: ${popupText}`);
  }
  await evaluate(worker, `chrome.storage.session.set({ 'media-downloads': {} })`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const hasDownloadButton = await evaluate(
      popup,
      `[...document.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Download')`,
    );
    if (hasDownloadButton) break;
    await sleep(100);
  }

  const clicked = await evaluate(
    popup,
    `(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Download');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error('Popup Download button was not found');

  let completedProgress;
  for (let attempt = 0; attempt < 600; attempt++) {
    completedProgress = await evaluate(
      worker,
      `(async () => {
        const state = (await chrome.storage.session.get('media-downloads'))['media-downloads'] || {};
        return Object.values(state).find(item => item.item?.url?.includes('/hevc/playlist.m3u8'));
      })()`,
    );
    if (completedProgress?.stage === 'failed') {
      throw new Error(`Extension download failed: ${completedProgress.error}`);
    }
    if (completedProgress?.stage === 'success') break;
    await sleep(100);
  }
  if (completedProgress?.stage !== 'success') {
    throw new Error(`Extension download did not reach success: ${JSON.stringify(completedProgress)}`);
  }

  const downloadItem = await evaluate(
    worker,
    `(async () => (await chrome.downloads.search({ id: ${completedProgress.downloadId} }))[0])()`,
  );
  const downloadedPath = downloadItem.filename;
  let downloadedSize = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      downloadedSize = (await stat(downloadedPath)).size;
      if (downloadedSize > 0) break;
    } catch {
      await sleep(100);
    }
  }
  if (downloadedSize <= 0) throw new Error('Chrome complete state did not produce a non-empty disk file');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', downloadedPath], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) throw new Error(`ffprobe rejected E2E output: ${probe.stderr}`);
  const probeResult = JSON.parse(probe.stdout);
  const hasHevc = probeResult.streams?.some(stream => stream.codec_type === 'video' && stream.codec_name === 'hevc');
  const hasAac = probeResult.streams?.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac');
  if (!hasHevc || !hasAac) throw new Error(`E2E output tracks do not match HEVC + AAC: ${probe.stdout}`);

  const report = {
    fixturePageUrl,
    detected: {
      kind: detection.kind,
      source: detection.source,
      url: detection.url,
    },
    progress: {
      stage: completedProgress.stage,
      downloadId: completedProgress.downloadId,
    },
    downloadedPath,
    downloadedSize,
    probe: {
      format: probeResult.format?.format_name,
      durationSeconds: Number(probeResult.format?.duration),
      tracks: probeResult.streams?.map(stream => ({ type: stream.codec_type, codec: stream.codec_name })),
    },
  };
  await writeFile(path.join(e2eRoot, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  popup?.close();
  worker?.close();
  page?.close();
  browser.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => chrome.once('exit', resolve));
  await new Promise(resolve => server.close(resolve));
  if (process.env.VIDSY_KEEP_E2E_ARTIFACTS !== '1') {
    const outputPath = process.env.VIDSY_EXTENSION_E2E_OUTPUT;
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      const downloadedFiles = await import('node:fs/promises').then(module => module.readdir(downloadDirectory));
      if (downloadedFiles.length !== 1) throw new Error(`Expected one E2E download, found ${downloadedFiles.length}`);
      await writeFile(outputPath, await readFile(path.join(downloadDirectory, downloadedFiles[0])));
    }
    await rm(e2eRoot, { recursive: true, force: true });
  } else {
    console.error(`E2E artifacts retained at ${e2eRoot}`);
  }
}
