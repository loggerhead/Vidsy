import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const libavDirectory = path.join(repositoryRoot, 'chrome-extension/public/libav');
const variant = 'web-media-remux-cli';

const fixturePath = path.resolve(process.argv[2] ?? '');
const outputPath = path.resolve(process.argv[3] ?? '');
const secondFixturePath = process.env.LIBAV_SMOKE_SECOND_INPUT
  ? path.resolve(process.env.LIBAV_SMOKE_SECOND_INPUT)
  : undefined;
const inputMode = process.env.LIBAV_SMOKE_INPUT ?? 'jsfetch';
const outputMode = process.env.LIBAV_SMOKE_OUTPUT ?? 'writer';
const plan = process.env.LIBAV_SMOKE_PLAN ?? 'copy-mp4';
if (!process.argv[2] || !process.argv[3]) {
  console.error('Usage: node run-libav-device-smoke.mjs <input> <output>');
  process.exit(2);
}

const fixture = await readFile(fixturePath);
const fixtureDirectory = path.dirname(fixturePath);
const secondFixture = secondFixturePath ? await readFile(secondFixturePath) : undefined;
const requests = [];
const server = createServer(async (request, response) => {
  requests.push({ method: request.method, range: request.headers.range });
  const requestedName = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
  const requestedPath = path.resolve(fixtureDirectory, requestedName || path.basename(fixturePath));
  if (path.dirname(requestedPath) !== fixtureDirectory) {
    response.writeHead(403);
    response.end();
    return;
  }
  let body;
  try {
    body = await readFile(requestedPath);
  } catch {
    response.writeHead(404);
    response.end();
    return;
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-length': body.byteLength,
    });
    response.end(body);
    return;
  }

  const start = Number(range[1]);
  const requestedEnd = range[2] ? Number(range[2]) : body.byteLength - 1;
  if (start >= body.byteLength) {
    response.writeHead(416, { 'content-range': `bytes */${body.byteLength}` });
    response.end();
    return;
  }
  const end = Math.min(requestedEnd, body.byteLength - 1);
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${body.byteLength}`,
  });
  response.end(body.subarray(start, end + 1));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to start fixture server');
const inputUrl = `http://127.0.0.1:${address.port}/${encodeURIComponent(path.basename(fixturePath))}`;

globalThis.MutateUrl = url => url;
globalThis.MAX_FETCH_ATTEMPTS = 2;
globalThis.MAX_READ_ATTEMPTS = 2;
globalThis.DoAbortableSleep = async () => ({ timed_out: true });
globalThis.FindPngSliceIndex = () => -1;
globalThis.FetchWithRetry = async (url, headers, maxAttempts, fetchTimeoutMs, _retryDelay, bypassCache, signal) => {
  let lastError = new Error('No fetch attempt');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        headers,
        cache: bypassCache ? 'reload' : 'default',
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (response.ok) return response;
      if (response.status === 404 || response.status === 416) return { err_status: response.status };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  return lastError;
};

const wrapperPath = path.join(libavDirectory, `libav-6.8.8.0-${variant}.mjs`);
const wrapper = (await import(pathToFileURL(wrapperPath).href)).default;
const outputName = path.basename(outputPath);
let output = new Uint8Array();
const writes = [];

try {
  const libav = await wrapper.LibAV({
    noworker: true,
    nothreads: true,
    base: pathToFileURL(libavDirectory).href,
    variant,
  });
  if (outputMode === 'writer') {
    libav.onwrite = (name, position, bytes) => {
      if (name !== outputName) return;
      writes.push({ position, bytes: bytes.byteLength });
      const requiredLength = position + bytes.byteLength;
      if (requiredLength > output.byteLength) {
        const expanded = new Uint8Array(requiredLength);
        expanded.set(output);
        output = expanded;
      }
      output.set(bytes, position);
    };
    await libav.mkwriterdev(outputName);
  }
  const inputName = path.basename(fixturePath);
  if (inputMode === 'memfs') await libav.writeFile(inputName, fixture);

  const input = inputMode === 'jsfetch' ? `jsfetch:${inputUrl}` : inputName;
  const commonArgs = ['-hide_banner', '-loglevel', process.env.LIBAV_SMOKE_LOGLEVEL ?? 'error', '-i', input];
  if (secondFixturePath && secondFixture) {
    const secondName = path.basename(secondFixturePath);
    if (path.dirname(secondFixturePath) !== fixtureDirectory) {
      throw new Error('Second smoke input must be in the same fixture directory');
    }
    if (inputMode === 'memfs') await libav.writeFile(secondName, secondFixture);
    const secondInput =
      inputMode === 'jsfetch'
        ? `jsfetch:http://127.0.0.1:${address.port}/${encodeURIComponent(secondName)}`
        : secondName;
    commonArgs.push('-i', secondInput);
  }
  let processingArgs;
  if (plan === 'transcode-mp3') {
    processingArgs = ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
  } else if (plan === 'copy-webm') {
    processingArgs = ['-map', '0:v:0', '-map', '0:a:0', '-c', 'copy'];
  } else if (plan === 'copy-merged') {
    processingArgs = ['-map', '0:v:0?', '-map', '1:v:0?', '-map', '0:a:0?', '-map', '1:a:0?', '-c', 'copy'];
  } else {
    processingArgs = [
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      ...(path.basename(fixturePath).includes('hevc') ? ['-tag:v', 'hvc1'] : []),
    ];
  }
  const exitCode = await libav.ffmpeg(...commonArgs, ...processingArgs, '-y', outputName);
  if (exitCode !== 0) throw new Error(`libav exited with ${exitCode}`);
  if (outputMode === 'memfs') output = await libav.readFile(outputName);
  if (output.byteLength === 0) throw new Error('writer device produced an empty output');
  await writeFile(outputPath, output);
  console.log(
    JSON.stringify(
      {
        variant,
        plan,
        inputMode,
        outputMode,
        exitCode,
        inputBytes: fixture.byteLength + (secondFixture?.byteLength ?? 0),
        outputBytes: output.byteLength,
        requests,
        writes,
      },
      null,
      2,
    ),
  );
  libav.terminate();
} finally {
  await new Promise(resolve => server.close(resolve));
}
