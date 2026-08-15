import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const libavDirectory = path.join(repositoryRoot, 'chrome-extension/public/libav');
const fixturePath = path.resolve(
  process.env.VIDSY_BENCHMARK_FIXTURE ?? '/tmp/vidsy-web-media-remux/fixtures-full/hls-ts-h264.ts',
);
const chromeBinary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const rounds = Number(process.env.VIDSY_BENCHMARK_ROUNDS ?? 5);
const benchmarkRoot = await mkdtemp(path.join(os.tmpdir(), 'vidsy-remux-benchmark-'));
const oldVariantDirectory = path.join(benchmarkRoot, 'old-libav');
await mkdir(oldVariantDirectory);

const variants = {
  old: 'h264-aac-mp3-cli',
  new: 'web-media-remux-cli',
};

for (const suffix of ['mjs', 'wasm.mjs', 'wasm.wasm']) {
  const fileName = `libav-6.8.8.0-${variants.old}.${suffix}`;
  const extracted = spawnSync('git', ['show', `HEAD:chrome-extension/public/libav/${fileName}`], {
    cwd: repositoryRoot,
    encoding: suffix === 'wasm.wasm' ? null : 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error(`Failed to extract baseline ${fileName}: ${extracted.stderr}`);
  await writeFile(path.join(oldVariantDirectory, fileName), extracted.stdout);
}

const fixture = await readFile(fixturePath);
const pageHtml = `<!doctype html><meta charset="utf-8"><title>Vidsy remux benchmark</title>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(pageHtml) });
    response.end(pageHtml);
    return;
  }
  if (url.pathname === '/fixture.ts') {
    response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': fixture.byteLength });
    response.end(fixture);
    return;
  }

  const fileName = path.basename(url.pathname);
  const isOld = fileName.includes(variants.old);
  const sourceDirectory = isOld ? oldVariantDirectory : libavDirectory;
  const sourcePath = path.join(sourceDirectory, fileName);
  if (path.dirname(sourcePath) !== sourceDirectory) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const body = await readFile(sourcePath);
    const contentType = fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    response.writeHead(200, { 'content-type': contentType, 'content-length': body.byteLength });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to start benchmark server');
const origin = `http://127.0.0.1:${address.port}`;

const profileDirectory = path.join(benchmarkRoot, 'profile');
const chrome = spawn(
  chromeBinary,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--enable-precise-memory-info',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let chromeErrors = '';
chrome.stderr.on('data', chunk => {
  chromeErrors += chunk.toString();
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
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

const waitForPage = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await json('/json/list');
    const page = targets.find(target => target.type === 'page');
    if (page) return page;
    await sleep(50);
  }
  throw new Error('Timed out waiting for benchmark page');
};

const evaluate = async (client, expression) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

const benchmarkExpression = (variant, temperature) => `(
  async () => {
    const variant = ${JSON.stringify(variant)};
    const temperature = ${JSON.stringify(temperature)};
    const fixture = new Uint8Array(await (await fetch('/fixture.ts')).arrayBuffer());
    const beforeJsHeapBytes = performance.memory?.usedJSHeapSize;
    const importStarted = performance.now();
    const wrapper = (await import('/libav-6.8.8.0-' + variant + '.mjs')).default;
    const initializationStarted = performance.now();
    const libav = await wrapper.LibAV({
      noworker: true,
      nothreads: true,
      base: location.origin,
      variant,
    });
    const initializationMilliseconds = performance.now() - initializationStarted;
    const moduleLoadAndInitializationMilliseconds = performance.now() - importStarted;
    const inputName = 'input.ts';
    const outputName = 'output.mp4';
    await libav.writeFile(inputName, fixture);

    let outputBytes = 0;
    let firstByteMilliseconds;
    let peakJsHeapBytes = performance.memory?.usedJSHeapSize ?? 0;
    let peakWasmHeapBytes = libav.HEAPU8?.buffer.byteLength ?? 0;
    const processingStarted = performance.now();
    libav.onwrite = (name, position, bytes) => {
      if (name !== outputName) return;
      if (firstByteMilliseconds === undefined) firstByteMilliseconds = performance.now() - processingStarted;
      outputBytes = Math.max(outputBytes, position + bytes.byteLength);
      peakJsHeapBytes = Math.max(peakJsHeapBytes, performance.memory?.usedJSHeapSize ?? 0);
      peakWasmHeapBytes = Math.max(peakWasmHeapBytes, libav.HEAPU8?.buffer.byteLength ?? 0);
    };
    await libav.mkwriterdev(outputName);
    const sampler = setInterval(() => {
      peakJsHeapBytes = Math.max(peakJsHeapBytes, performance.memory?.usedJSHeapSize ?? 0);
      peakWasmHeapBytes = Math.max(peakWasmHeapBytes, libav.HEAPU8?.buffer.byteLength ?? 0);
    }, 5);
    const exitCode = await libav.ffmpeg(
      '-hide_banner', '-loglevel', 'error',
      '-i', inputName,
      '-map', '0:v:0', '-map', '0:a:0',
      '-c', 'copy',
      '-y', outputName,
    );
    clearInterval(sampler);
    peakJsHeapBytes = Math.max(peakJsHeapBytes, performance.memory?.usedJSHeapSize ?? 0);
    peakWasmHeapBytes = Math.max(peakWasmHeapBytes, libav.HEAPU8?.buffer.byteLength ?? 0);
    const processingMilliseconds = performance.now() - processingStarted;
    libav.terminate();
    return {
      variant,
      temperature,
      inputBytes: fixture.byteLength,
      outputBytes,
      exitCode,
      initializationMilliseconds,
      moduleLoadAndInitializationMilliseconds,
      firstByteMilliseconds,
      processingMilliseconds,
      beforeJsHeapBytes,
      peakJsHeapBytes,
      peakJsHeapDeltaBytes: Math.max(0, peakJsHeapBytes - (beforeJsHeapBytes ?? 0)),
      peakWasmHeapBytes,
    };
  }
)()`;

const percentileSummary = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    worst: sorted.at(-1),
  };
};

const measurements = [];
let page;
try {
  const target = await waitForPage();
  page = new Cdp(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: origin });
  await sleep(100);

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
    for (const label of order) {
      await page.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.send('Page.reload', { ignoreCache: true });
      await sleep(50);
      measurements.push({
        round: round + 1,
        label,
        ...(await evaluate(page, benchmarkExpression(variants[label], 'cold'))),
      });

      await page.send('Network.setCacheDisabled', { cacheDisabled: false });
      measurements.push({
        round: round + 1,
        label,
        ...(await evaluate(page, benchmarkExpression(variants[label], 'hot'))),
      });
    }
  }

  const summary = {};
  for (const label of ['old', 'new']) {
    summary[label] = {};
    for (const temperature of ['cold', 'hot']) {
      const rows = measurements.filter(row => row.label === label && row.temperature === temperature);
      summary[label][temperature] = {
        initializationMilliseconds: percentileSummary(rows.map(row => row.initializationMilliseconds)),
        moduleLoadAndInitializationMilliseconds: percentileSummary(
          rows.map(row => row.moduleLoadAndInitializationMilliseconds),
        ),
        firstByteMilliseconds: percentileSummary(rows.map(row => row.firstByteMilliseconds)),
        processingMilliseconds: percentileSummary(rows.map(row => row.processingMilliseconds)),
        peakJsHeapDeltaBytes: percentileSummary(rows.map(row => row.peakJsHeapDeltaBytes)),
        peakWasmHeapBytes: percentileSummary(rows.map(row => row.peakWasmHeapBytes)),
      };
    }
  }
  const oldProcessing = summary.old.hot.processingMilliseconds.median;
  const newProcessing = summary.new.hot.processingMilliseconds.median;
  const newMeasurement = measurements.find(row => row.label === 'new');
  if (!newMeasurement) throw new Error('Benchmark did not produce a new-variant measurement');
  const report = {
    environment: {
      chromeBinary,
      chromeVersion: (await json('/json/version')).Browser,
      fixturePath,
      rounds,
      order: 'AB/BA alternating by round',
    },
    measurements,
    summary,
    h264HotProcessingRegressionPercent: ((newProcessing - oldProcessing) / oldProcessing) * 100,
    temporarySpaceAmplification: {
      directJsfetchOutputOnly: newMeasurement.outputBytes / newMeasurement.inputBytes,
      authPrefetchInputPlusOutput: (newMeasurement.inputBytes + newMeasurement.outputBytes) / newMeasurement.inputBytes,
    },
  };
  const outputPath = process.env.VIDSY_BENCHMARK_OUTPUT;
  if (outputPath) await writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page?.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await rm(benchmarkRoot, { recursive: true, force: true });
}
