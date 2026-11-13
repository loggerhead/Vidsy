import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage } from '../helpers/browser.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DownloadJob } from '../../../chrome-extension/src/background/lib/download-runtime';
import type { CacheRecord } from '../../../chrome-extension/src/offscreen/lib/cache-protocol';
import type { Server } from 'node:http';

let server: Server, origin: string, profile: string, data: Buffer;
const priorProfile = process.env.VIDSY_E2E_PROFILE_DIR,
  priorNative = process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
const allowed = new Set<string>(),
  changed = new Set<string>();
const expired = new Set<string>();
const deniedRenewals = new Set<string>();
const expiredHeaders = new Set<string>();
const requests: { path: string; start: number; end: number; method: string; ifRange?: string }[] = [];
const date = 'Tue, 10 Nov 2026 08:00:00 GMT';
const blockBytes = 1024 * 1024;

beforeAll(async () => {
  const media = await readFile(resolve(import.meta.dirname, '../../../.media-test/fixtures/direct.mp4'));
  const free = Buffer.alloc(6 * blockBytes);
  free.writeUInt32BE(free.length, 0);
  free.write('free', 4);
  data = Buffer.concat([media, free]);
  server = createServer((request, response) => {
    const address = new URL(request.url!, 'http://fixture');
    const path = address.pathname;
    if (path === '/player') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Signed URL fixture</title>');
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0,
      end = range ? Math.min(Number(range[2] || data.length - 1), data.length - 1) : data.length - 1;
    const method = request.method ?? 'GET';
    requests.push({ path, start, end, method, ifRange: request.headers['if-range'] as string });
    if (expiredHeaders.has(path) && request.headers.authorization !== 'Bearer new') {
      response.writeHead(403);
      response.end('Expired request context');
      return;
    }
    if (expired.has(path) && (address.searchParams.get('token') !== 'new' || deniedRenewals.has(path))) {
      response.writeHead(path.includes('gone') ? 410 : 403);
      response.end('Expired signature');
      return;
    }
    const validators = path.includes('date')
      ? { 'last-modified': date, ...(path.includes('weak') ? { etag: 'W/"weak-v1"' } : {}) }
      : path.includes('none')
        ? {}
        : { etag: '"strong-v1"' };
    response.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      ...validators,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    const bytes = Buffer.from(data);
    if (changed.has(path)) bytes[Math.ceil(data.length / 2) - 17] ^= 1;
    let cursor = start;
    const payload = end - start + 1 > 32 * 1024;
    const timer = setInterval(() => {
      if (payload && !allowed.has(path) && (start > 0 || (path.includes('subchunk') && cursor >= 1.5 * blockBytes)))
        return;
      const next = Math.min(cursor + 64 * 1024, end + 1);
      response.write(bytes.subarray(cursor, next));
      cursor = next;
      if (cursor > end) {
        clearInterval(timer);
        response.end();
      }
    }, 2);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'uuget-resume-m4-http-'));
  process.env.VIDSY_E2E_PROFILE_DIR = profile;
  process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = 'true';
  await startBrowser();
  await extensionWorker().evaluate(async () =>
    chrome.storage.local.set({ 'media-settings': { downloadConcurrency: 1, downloadConnectionsPerFile: 1 } }),
  );
});
afterEach(async () => {
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async () => {
      const state = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      for (const job of Object.values(state.jobs as Record<string, DownloadJob>) as {
        requestId: string;
        state: string;
      }[])
        if (!['cancelled', 'succeeded'].includes(job.state))
          await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key: job.requestId, intent: 'cancel' } });
    });
  });
});
afterAll(async () => {
  await stopBrowser();
  if (priorProfile === undefined) delete process.env.VIDSY_E2E_PROFILE_DIR;
  else process.env.VIDSY_E2E_PROFILE_DIR = priorProfile;
  if (priorNative === undefined) delete process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
  else process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = priorNative;
  if (profile) await rm(profile, { recursive: true, force: true });
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
const progress = (key: string) =>
  extensionWorker().evaluate(
    async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key],
    key,
  );
const stage = (key: string, expected: string) =>
  expect
    .poll(
      async () => {
        const p = await progress(key);
        if (p?.stage === 'failed' && expected !== 'failed') throw new Error(p.error);
        return p?.stage;
      },
      { timeout: 20_000 },
    )
    .toBe(expected);
const submit = (key: string, path: string, tabId?: number) =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const response = await page.evaluate(
      async args => chrome.runtime.sendMessage({ type: 'media/download', payload: args }),
      { key, url: origin + path, kind: 'video', fileName: key, tabId },
    );
    expect(response.ok).toBe(true);
  });
const control = (key: string, intent: string) =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async ({ key, intent }) =>
        chrome.runtime.sendMessage(
          intent === 'pause'
            ? { type: 'media/cancel', payload: { key, intent } }
            : { type: 'media/control', payload: { key, intent } },
        ),
      { key, intent },
    );
  });
const pause = async (key: string, path: string, subchunk = false) => {
  await submit(key, path);
  if (subchunk)
    await expect
      .poll(async () => (await progress(key))?.downloadedBytes ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1.5 * blockBytes);
  else
    await expect
      .poll(
        async () =>
          (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
        { timeout: 15_000 },
      )
      .toBe(1);
  await control(key, 'pause');
  await stage(key, 'paused');
};
const verify = async (key: string, path: string) => {
  await stage(key, 'success');
  const [download] = await extensionWorker().evaluate(
    async id => chrome.downloads.search({ id }),
    (await progress(key)).downloadId,
  );
  const expected = Buffer.from(data);
  if (changed.has(path)) expected[Math.ceil(data.length / 2) - 17] ^= 1;
  expect(await readFile(download.filename)).toEqual(expected);
  await unlink(download.filename);
};

for (const path of ['/date.mp4', '/weak-date.mp4', '/none.mp4']) {
  it(`${path} resumes verified weak-source cache after browser restart`, async () => {
    const key = crypto.randomUUID();
    await pause(key, path);
    const retained = (await progress(key)).downloadedBytes;
    expect((await progress(key)).validationMethod).toBe(path.includes('date') ? 'last-modified' : 'boundary-sample');
    const before = requests.length;
    await stopBrowser();
    await startBrowser();
    expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      await expect
        .poll(() => page.locator('body').innerText())
        .toContain(path.includes('date') ? 'Last-Modified + boundary samples' : 'Length + boundary samples');
    });
    allowed.add(path);
    await control(key, 'resume');
    await verify(key, path);
    const resumed = requests.slice(before).filter(request => request.path === path && request.method !== 'HEAD');
    expect(resumed.some(request => request.end - request.start + 1 <= 32 * 1024)).toBe(true);
    expect(
      resumed
        .filter(request => request.end - request.start + 1 > 32 * 1024)
        .every(request => request.start >= Math.ceil(data.length / 2)),
    ).toBe(true);
    if (path.includes('date')) expect(resumed.every(request => request.ifRange === date)).toBe(true);
  });
}
it('an interrupted large Range resumes inside its chunk with at most 1 MiB lost payload', async () => {
  const key = crypto.randomUUID(),
    path = '/subchunk.mp4';
  await pause(key, path, true);
  const record = await extensionWorker().evaluate(
    async key =>
      (
        Object.values((await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records) as {
          jobKey: string;
          ranges?: { checkpoints: { downloaded: number }[] };
        }[]
      ).find(record => record.jobKey === key),
    key,
  );
  const checkpoint = record!.ranges!.checkpoints[0].downloaded;
  expect(checkpoint).toBe(blockBytes);
  const previous = (await progress(key)).downloadedBytes,
    before = requests.length;
  await stopBrowser();
  await startBrowser();
  expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(previous);
  allowed.add(path);
  await control(key, 'resume');
  await verify(key, path);
  const payloads = requests
    .slice(before)
    .filter(
      request => request.path === path && request.method !== 'HEAD' && request.end - request.start + 1 > 32 * 1024,
    );
  expect(payloads.some(request => request.start === checkpoint)).toBe(true);
  expect(1.5 * blockBytes - checkpoint).toBeLessThanOrEqual(blockBytes);
});
it('validator-free boundary mismatch explicitly discards old bytes and delivers the new complete file', async () => {
  const key = crypto.randomUUID(),
    path = '/none-changed.mp4';
  await pause(key, path);
  changed.add(path);
  allowed.add(path);
  const before = requests.length;
  await control(key, 'resume');
  await verify(key, path);
  expect((await progress(key)).resumeNotice).toContain('download restarted');
  expect(
    requests
      .slice(before)
      .some(request => request.path === path && request.start === 0 && request.end - request.start + 1 > 32 * 1024),
  ).toBe(true);
});
it('mutating an interior cached byte is detected before resume and triggers an explained full restart', async () => {
  const key = crypto.randomUUID(),
    path = '/local-mutation.mp4';
  await pause(key, path);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async key => {
      const record = (
        Object.values((await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records) as {
          jobKey: string;
          name: string;
        }[]
      ).find(record => record.jobKey === key)!;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(record.name);
      const file = await handle.getFile();
      const stream = await handle.createWritable({ keepExistingData: true });
      const bytes = new Uint8Array(await file.slice(900000, 900001).arrayBuffer());
      bytes[0] ^= 1;
      await stream.write({ type: 'write', position: 900000, data: bytes });
      await stream.close();
    }, key);
  });
  allowed.add(path);
  await control(key, 'resume');
  await verify(key, path);
  expect((await progress(key)).resumeNotice).toContain('Cached checkpoint bytes changed');
});

it('an interrupted native delivery survives browser restart and is delivered without a media request', async () => {
  const key = crypto.randomUUID(),
    path = '/delivery.mp4';
  allowed.add(path);
  await extensionWorker().evaluate(() => {
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (async (options: chrome.downloads.DownloadOptions) => {
      chrome.downloads.download = original;
      const id = await original(options);
      await chrome.downloads.cancel(id);
      return id;
    }) as typeof chrome.downloads.download;
  });
  await submit(key, path);
  await stage(key, 'failed');
  const saved = await extensionWorker().evaluate(async key => {
    const runtime = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
    const job = Object.values(runtime.jobs as Record<string, DownloadJob>).find(
      (job: DownloadJob) => job.requestId === key,
    )!;
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    return {
      ready: job.artifactReady,
      artifacts: Object.values(ledger.records as Record<string, CacheRecord>).filter(
        (record: CacheRecord) => record.jobKey === key && record.artifact,
      ).length,
    };
  }, key);
  expect(saved).toEqual({ ready: true, artifacts: 1 });
  const before = requests.length;
  await stopBrowser();
  await startBrowser();
  await control(key, 'retry');
  await verify(key, path);
  expect(requests.slice(before).filter(request => request.path === path)).toEqual([]);
  const files = await extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    return Object.values(ledger.records as Record<string, CacheRecord>).filter(
      (record: CacheRecord) => record.jobKey === key,
    ).length;
  }, key);
  expect(files).toBe(0);
});

it('expired signed URL is reparsed once and verified cached ranges survive the new URL', async () => {
  await withNewPage(async player => {
    await player.goto(origin + '/player');
    const tabId = await extensionWorker().evaluate(
      async url => (await chrome.tabs.query({ url }))[0].id!,
      origin + '/player',
    );
    const key = crypto.randomUUID(),
      path = '/signed.mp4';
    await submit(key, path + '?token=old', tabId);
    await expect
      .poll(
        async () =>
          (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
        {
          timeout: 15000,
        },
      )
      .toBe(1);
    await control(key, 'pause');
    await stage(key, 'paused');
    const retained = (await progress(key)).downloadedBytes;
    expired.add(path);
    allowed.add(path);
    await player.evaluate(
      url => {
        const video = document.createElement('video');
        video.preload = 'none';
        video.src = url;
        document.body.append(video);
      },
      origin + path + '?token=new',
    );
    const before = requests.length;
    await control(key, 'resume');
    await verify(key, path);
    expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
    const resumed = requests.slice(before).filter(request => request.path === path && request.method !== 'HEAD');
    expect(resumed.some(request => request.end - request.start + 1 <= 32768)).toBe(true);
    expect(
      resumed
        .filter(request => request.end - request.start + 1 > 32768)
        .every(request => request.start >= Math.ceil(data.length / 2)),
    ).toBe(true);
    const job = await extensionWorker().evaluate(async key => {
      const runtime = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      return Object.values(runtime.jobs as Record<string, DownloadJob>).find(
        (job: DownloadJob) => job.requestId === key,
      )!;
    }, key);
    expect(job.execution.url).toBe(origin + path + '?token=new');
    expect(job.diagnostics.filter((event: { event: string }) => event.event === 'source-renewed')).toHaveLength(1);
  });
});

it('410 without an available source page preserves progress and explains how to re-detect', async () => {
  const key = crypto.randomUUID(),
    path = '/gone.mp4';
  await pause(key, path);
  const retained = (await progress(key)).downloadedBytes;
  expired.add(path);
  allowed.add(path);
  await control(key, 'resume');
  await stage(key, 'failed');
  const p = await progress(key);
  expect(p.downloadedBytes).toBeGreaterThanOrEqual(retained);
  expect(p.error).toContain('re-detect');
  const records = await extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    return Object.values(ledger.records as Record<string, CacheRecord>).filter(
      (record: CacheRecord) => record.jobKey === key,
    );
  }, key);
  expect(records.length).toBeGreaterThan(0);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const response = await page.evaluate(
      async ({ key, url }) =>
        chrome.runtime.sendMessage({
          type: 'offscreen/authorize-download-url',
          payload: { key, url },
        }),
      { key, url: origin + path },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain('cancelled');
  });
});

it('a renewed URL that still returns 403 stops after one reparse and retains its checkpoints', async () => {
  await withNewPage(async player => {
    await player.goto(origin + '/player');
    const tabId = await extensionWorker().evaluate(
      async url => (await chrome.tabs.query({ url }))[0].id!,
      origin + '/player',
    );
    const key = crypto.randomUUID(),
      path = '/denied-renewal.mp4';
    await submit(key, path + '?token=old', tabId);
    await expect
      .poll(
        async () =>
          (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
        {
          timeout: 15000,
        },
      )
      .toBe(1);
    await control(key, 'pause');
    await stage(key, 'paused');
    const retained = (await progress(key)).downloadedBytes;
    expired.add(path);
    deniedRenewals.add(path);
    allowed.add(path);
    await player.evaluate(
      url => {
        const video = document.createElement('video');
        video.preload = 'none';
        video.src = url;
        document.body.append(video);
      },
      origin + path + '?token=new',
    );
    await control(key, 'resume');
    await stage(key, 'failed');
    expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
    expect((await progress(key)).error).toContain('after one refresh');
    const evidence = await extensionWorker().evaluate(async key => {
      const state = await chrome.storage.local.get(['vidsy-download-runtime', 'uuget-download-cache']);
      const job = Object.values(state['vidsy-download-runtime'].jobs).find(
        (job: DownloadJob) => job.requestId === key,
      )!;
      return {
        renewals: job.diagnostics.filter((event: { event: string }) => event.event === 'source-renewed').length,
        records: Object.values(state['uuget-download-cache'].records).filter(
          (record: CacheRecord) => record.jobKey === key,
        ).length,
      };
    }, key);
    expect(evidence.renewals).toBe(1);
    expect(evidence.records).toBeGreaterThan(0);
  });
});

it('expired request headers are refreshed once and retain verified byte ranges on the same URL', async () => {
  await withNewPage(async player => {
    await player.goto(origin + '/player');
    const path = '/header-renewal.mp4',
      key = crypto.randomUUID();
    await player.evaluate(async url => {
      await fetch(url, { method: 'HEAD', headers: { Authorization: 'Bearer old' } });
      const video = document.createElement('video');
      video.preload = 'none';
      video.src = url;
      document.body.append(video);
    }, origin + path);
    const tabId = await extensionWorker().evaluate(
      async url => (await chrome.tabs.query({ url }))[0].id!,
      origin + '/player',
    );
    await submit(key, path, tabId);
    await expect
      .poll(
        async () =>
          (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
        {
          timeout: 15000,
        },
      )
      .toBe(1);
    await control(key, 'pause');
    await stage(key, 'paused');
    expiredHeaders.add(path);
    allowed.add(path);
    await player.evaluate(async url => {
      await fetch(url, { method: 'HEAD', headers: { Authorization: 'Bearer new' } });
    }, origin + path);
    const before = requests.length;
    await control(key, 'resume');
    await verify(key, path);
    const payloads = requests
      .slice(before)
      .filter(request => request.path === path && request.method !== 'HEAD' && request.end - request.start + 1 > 32768);
    expect(payloads.every(request => request.start >= Math.ceil(data.length / 2))).toBe(true);
    const job = await extensionWorker().evaluate(async key => {
      const runtime = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      return Object.values(runtime.jobs as Record<string, DownloadJob>).find(
        (job: DownloadJob) => job.requestId === key,
      )!;
    }, key);
    expect(job.diagnostics.filter((event: { event: string }) => event.event === 'source-renewed')).toHaveLength(1);
  });
});

const parkArtifact = async (key: string, path: string) => {
  allowed.add(path);
  await extensionWorker().evaluate(() => {
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (async () => {
      chrome.downloads.download = original;
      throw new Error('Injected native handoff interruption');
    }) as typeof chrome.downloads.download;
  });
  await submit(key, path);
  await stage(key, 'failed');
  return extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    return Object.values(ledger.records as Record<string, CacheRecord>).find(
      (record: CacheRecord) => record.jobKey === key && record.artifact,
    )!;
  }, key);
};

it('cancel after restart deletes the saved output and its entire input family', async () => {
  const key = crypto.randomUUID(),
    path = '/artifact-cancel.mp4';
  const saved = await parkArtifact(key, path);
  expect(saved).toBeTruthy();
  await stopBrowser();
  await startBrowser();
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const result = await page.evaluate(
      async ({ key, name }) => {
        await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'cancel' } });
        const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
        const root = await navigator.storage.getDirectory();
        const files: string[] = [];
        for await (const entry of (
          root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
        ).keys())
          files.push(entry);
        return {
          records: Object.values(ledger.records as Record<string, CacheRecord>).filter(
            (record: CacheRecord) => record.jobKey === key,
          ).length,
          outputExists: files.includes(name),
        };
      },
      { key, name: saved.name },
    );
    expect(result).toEqual({ records: 0, outputExists: false });
  });
});

it('saved output mutation fails before native publication; another Retry downloads a validated replacement', async () => {
  const key = crypto.randomUUID(),
    path = '/artifact-mutation.mp4';
  const saved = await parkArtifact(key, path);
  await stopBrowser();
  await startBrowser();
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async name => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name);
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.slice(900000, 900001).arrayBuffer());
      bytes[0] ^= 1;
      const stream = await handle.createWritable({ keepExistingData: true });
      await stream.write({ type: 'write', position: 900000, data: bytes });
      await stream.close();
    }, saved.name);
  });
  const before = requests.length;
  await control(key, 'retry');
  await stage(key, 'failed');
  expect((await progress(key)).error).toContain('Completed input bytes changed');
  expect(requests.slice(before).filter(request => request.path === path)).toEqual([]);
  await control(key, 'retry');
  await verify(key, path);
  expect(requests.slice(before).some(request => request.path === path && request.start === 0)).toBe(true);
});

it('expired output metadata is removed without extending or deleting the shared input lease', async () => {
  const key = crypto.randomUUID(),
    path = '/artifact-expiry.mp4';
  const saved = await parkArtifact(key, path);
  await extensionWorker().evaluate(async name => {
    const state = await chrome.storage.local.get('uuget-download-cache');
    state['uuget-download-cache'].records[name].artifact.expiresAt = Date.now() - 1;
    await chrome.storage.local.set(state);
  }, saved.name);
  const before = requests.length;
  await stopBrowser();
  await startBrowser();
  await extensionWorker().evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (!contexts.length)
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run saved artifact expiry fixture',
      });
  });
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'offscreen/collect-download-cache' }));
  });
  await expect
    .poll(
      async () =>
        extensionWorker().evaluate(
          async name =>
            (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records[name]?.artifact,
          saved.name,
        ),
      { timeout: 10000 },
    )
    .toBeUndefined();
  const record = await extensionWorker().evaluate(
    async name => (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records[name],
    saved.name,
  );
  expect(record.artifact).toBeUndefined();
  expect(record.expiresAt).toBe(saved.expiresAt);
  expect(record.complete).toEqual(saved.complete);
  await control(key, 'retry');
  await verify(key, path);
  expect(requests.slice(before).filter(request => request.path === path)).toEqual([]);
});
