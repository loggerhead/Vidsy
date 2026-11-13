import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage } from '../helpers/browser.js';
import { injectNextMuxFailure } from '../helpers/mux-failure.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CacheRecord } from '../../../chrome-extension/src/offscreen/lib/cache-protocol';
import type { Server } from 'node:http';

let server: Server, origin: string, profile: string;
const previousProfile = process.env.VIDSY_E2E_PROFILE_DIR;
const previousNative = process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
const fixtures = resolve(import.meta.dirname, '../../../.media-test/fixtures');
const blocked = new Set<string>(),
  released = new Set<string>(),
  changed = new Set<string>();
const requests: { path: string; range?: string }[] = [];
const expired = new Set<string>();
let hlsText: string, dashText: string;

beforeAll(async () => {
  hlsText = await readFile(join(fixtures, 'hls-fmp4/playlist.m3u8'), 'utf8');
  dashText = await readFile(join(fixtures, 'dash/manifest.mpd'), 'utf8');
  server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push({ path, range: request.headers.range });
    const prefix = path.split('/')[1];
    let text: string | undefined;
    if (path.endsWith('/master.m3u8'))
      text =
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180,AUDIO="a"\nvideo.m3u8';
    else if (path.endsWith('/video.m3u8') || path.endsWith('/audio.m3u8')) {
      const audio = path.endsWith('/audio.m3u8'),
        id = audio ? 1 : 0;
      text = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init-stream${id}.m4s"\n#EXTINF:1,\nchunk-stream${id}-00001.m4s\n#EXTINF:1,\nchunk-stream${id}-00002.m4s\n${audio ? '#EXTINF:0.016,\nchunk-stream1-00003.m4s\n' : ''}#EXT-X-ENDLIST`;
    } else if (path.endsWith('.m3u8')) {
      text = hlsText;
      if (prefix.includes('live')) text = text.replace('#EXT-X-ENDLIST', '').replace('#EXT-X-PLAYLIST-TYPE:VOD', '');
      if (changed.has(prefix)) text = text.replace('MEDIA-SEQUENCE:0', 'MEDIA-SEQUENCE:101');
    } else if (path.endsWith('.mpd')) {
      text = dashText;
      if (prefix.includes('live')) text = text.replace('type="static"', 'type="dynamic"');
      if (changed.has(prefix)) text = text.replaceAll('startNumber="1"', 'startNumber="11"');
    }
    if (text !== undefined && expired.has(prefix)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (text !== undefined && prefix.includes('live') && path.endsWith('.m3u8'))
      text = text.replaceAll('#EXT-X-ENDLIST', '');
    if (text !== undefined) {
      response.writeHead(200, {
        'content-type': path.endsWith('.mpd') ? 'application/dash+xml' : 'application/vnd.apple.mpegurl',
      });
      response.end(text);
      return;
    }
    let name = path.split('/').pop()!;
    if (changed.has(prefix))
      name = name.replace(
        /(chunk-stream\d-)(\d{5})/,
        (_, track: string, index: string) => track + String(Number(index) - 10).padStart(5, '0'),
      );
    const folder = name === 'init.mp4' || name.startsWith('segment-') ? 'hls-fmp4' : 'dash';
    let bytes: Buffer;
    try {
      bytes = await readFile(join(fixtures, folder, name));
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    if (prefix.includes('internal') && (name === 'segment-00.m4s' || name === 'chunk-stream0-00001.m4s')) {
      const free = Buffer.alloc(3 * 1024 * 1024);
      free.writeUInt32BE(free.length, 0);
      free.write('free', 4);
      bytes = Buffer.concat([bytes, free]);
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0,
      end = range ? Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    });
    let cursor = start;
    const timer = setInterval(() => {
      if (blocked.has(path) && !released.has(path) && (!prefix.includes('internal') || cursor >= 1.5 * 1024 * 1024))
        return;
      const next = Math.min(cursor + 16 * 1024, end + 1);
      response.write(bytes.subarray(cursor, next));
      cursor = next;
      if (cursor > end) {
        clearInterval(timer);
        response.end();
      }
    }, 5);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'uuget-resume-m3-'));
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
        if (!['succeeded', 'cancelled'].includes(job.state))
          await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key: job.requestId, intent: 'cancel' } });
    });
  });
});
afterAll(async () => {
  await stopBrowser();
  if (previousProfile === undefined) delete process.env.VIDSY_E2E_PROFILE_DIR;
  else process.env.VIDSY_E2E_PROFILE_DIR = previousProfile;
  if (previousNative === undefined) delete process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
  else process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = previousNative;
  if (profile) await rm(profile, { recursive: true, force: true });
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
const progress = (key: string) =>
  extensionWorker().evaluate(
    async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key],
    key,
  );
const submit = (key: string, path: string, kind: string) =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const result = await page.evaluate(
      async args => chrome.runtime.sendMessage({ type: 'media/download', payload: args }),
      { key, url: origin + path, kind, title: key, fileName: key },
    );
    expect(result.ok).toBe(true);
  });
const control = (key: string, intent: string) =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async ({ key, intent }) =>
        chrome.runtime.sendMessage(
          intent === 'pause' || intent === 'cancel'
            ? { type: 'media/cancel', payload: { key, intent } }
            : { type: 'media/control', payload: { key, intent } },
        ),
      { key, intent },
    );
  });
const waitStage = (key: string, stage: string) =>
  expect
    .poll(
      async () => {
        const entry = await progress(key);
        if (entry?.stage === 'failed' && stage !== 'failed') throw new Error(entry.error);
        return entry?.stage;
      },
      { timeout: 20_000 },
    )
    .toBe(stage);
const pauseAt = async (key: string, stage: string) => {
  await expect
    .poll(
      async () => {
        const p = await progress(key);
        return p?.stage === stage && p?.completedParts === 1;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await control(key, 'pause');
  await waitStage(key, 'paused');
  return (await progress(key)).downloadedBytes;
};
const verify = async (key: string) => {
  await waitStage(key, 'success');
  const [download] = await extensionWorker().evaluate(
    async id => chrome.downloads.search({ id }),
    (await progress(key)).downloadId,
  );
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', download.filename],
    { encoding: 'utf8' },
  );
  expect(probe.status, probe.stderr).toBe(0);
  const value = JSON.parse(probe.stdout);
  expect(value.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video')).toBe(true);
  expect(value.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio')).toBe(true);
  expect(Number(value.format.duration)).toBeGreaterThan(1.9);
  expect(Number(value.format.duration)).toBeLessThan(2.5);
  expect(Number(value.format.size)).toBeGreaterThan(1000);
  await unlink(download.filename);
};

for (const kind of ['hls', 'dash']) {
  it(`M5 ${kind} completed live output pauses and survives restart for local delivery`, async () => {
    const prefix = `${kind}-live-artifact`,
      key = crypto.randomUUID();
    await extensionWorker().evaluate(async () => {
      await chrome.storage.local.remove('m5-live-native-held');
      const original = chrome.downloads.search.bind(chrome.downloads);
      Reflect.set(globalThis, '__m5_live_search_original', original);
      let held = false;
      chrome.downloads.search = (async (query: chrome.downloads.DownloadQuery) => {
        if (!held && query.url?.startsWith('^blob:')) {
          held = true;
          await chrome.storage.local.set({ 'm5-live-native-held': true });
          await new Promise<void>(resolve => Reflect.set(globalThis, '__m5_live_release', resolve));
        }
        return original(query);
      }) as typeof chrome.downloads.search;
    });
    await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
    await expect
      .poll(
        async () =>
          extensionWorker().evaluate(
            async () => (await chrome.storage.local.get('m5-live-native-held'))['m5-live-native-held'],
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await control(key, 'pause');
    await waitStage(key, 'paused');
    expect((await progress(key)).resumeCapability).toBe('artifact');
    await extensionWorker().evaluate(() => {
      Reflect.get(globalThis, '__m5_live_release')?.();
      chrome.downloads.search = Reflect.get(globalThis, '__m5_live_search_original');
    });
    const before = requests.length;
    expired.add(prefix);
    await stopBrowser();
    await startBrowser();
    await waitStage(key, 'paused');
    await control(key, 'resume');
    await verify(key);
    expect(requests.slice(before).filter(request => request.path.startsWith(`/${prefix}/`))).toEqual([]);
  });
  it(`M4 ${kind} expired manifest preserves cached parts and provides re-detection guidance`, async () => {
    const prefix = `${kind}-expired-manifest`,
      key = crypto.randomUUID();
    const missing = `/${prefix}/${kind === 'hls' ? 'segment-01.m4s' : 'chunk-stream0-00002.m4s'}`;
    blocked.add(missing);
    await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
    const retained = await pauseAt(key, 'download-video');
    expired.add(prefix);
    const before = requests.length;
    await control(key, 'resume');
    await waitStage(key, 'failed');
    expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
    expect((await progress(key)).error).toContain('re-detect');
    expect(
      requests
        .slice(before)
        .filter(
          request =>
            request.path.startsWith(`/${prefix}/`) && !request.path.endsWith('.m3u8') && !request.path.endsWith('.mpd'),
        ),
    ).toEqual([]);
    const count = await extensionWorker().evaluate(async key => {
      const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
      return Object.values(ledger.records as Record<string, CacheRecord>).filter(
        (record: CacheRecord) => record.jobKey === key,
      ).length;
    }, key);
    expect(count).toBeGreaterThan(0);
  });
  it(`M4 ${kind} large segment resumes within the segment after browser restart`, async () => {
    const prefix = `${kind}-internal`,
      key = crypto.randomUUID();
    const partial = `/${prefix}/${kind === 'hls' ? 'segment-00.m4s' : 'chunk-stream0-00001.m4s'}`;
    blocked.add(partial);
    await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
    await expect
      .poll(async () => (await progress(key))?.downloadedBytes ?? 0, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1.5 * 1024 * 1024);
    await control(key, 'pause');
    await waitStage(key, 'paused');
    const before = requests.length;
    await stopBrowser();
    await startBrowser();
    released.add(partial);
    await control(key, 'resume');
    await verify(key);
    const payloads = requests
      .slice(before)
      .filter(
        request =>
          request.path === partial &&
          request.range &&
          Number(request.range.split('-')[1]) - Number(request.range.split('=')[1].split('-')[0]) > 32768,
      );
    expect(payloads[0].range).toMatch(/^bytes=1048576-/);
  });
  it(`${kind} VOD cross-session resume only fetches missing segments`, async () => {
    const prefix = kind === 'hls' ? 'hls-single' : 'dash-single';
    const missing = `/${prefix}/${kind === 'hls' ? 'segment-01.m4s' : 'chunk-stream0-00002.m4s'}`;
    blocked.add(missing);
    const key = crypto.randomUUID();
    await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
    const retained = await pauseAt(key, 'download-video');
    const before = requests.length;
    await stopBrowser();
    await startBrowser();
    expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
    released.add(missing);
    await control(key, 'resume');
    await verify(key);
    const repeated = requests
      .slice(before)
      .filter(
        request =>
          request.path.startsWith(`/${prefix}/`) && !request.path.endsWith('.m3u8') && !request.path.endsWith('.mpd'),
      );
    expect(
      repeated.some(request => request.path.endsWith(kind === 'hls' ? 'segment-00.m4s' : 'chunk-stream0-00001.m4s')),
    ).toBe(false);
    expect(repeated.some(request => request.path.endsWith(kind === 'hls' ? 'init.mp4' : 'init-stream0.m4s'))).toBe(
      false,
    );
  });
  it(`${kind} retains complete video and resumes only unfinished audio`, async () => {
    const prefix = `${kind}-tracks`,
      missing = `/${prefix}/chunk-stream1-00002.m4s`;
    blocked.add(missing);
    const key = crypto.randomUUID();
    await submit(key, `/${prefix}/${kind === 'hls' ? 'master.m3u8' : 'manifest.mpd'}`, kind);
    const retained = await pauseAt(key, 'download-audio');
    const before = requests.length;
    await stopBrowser();
    await startBrowser();
    released.add(missing);
    await control(key, 'resume');
    await verify(key);
    expect((await progress(key)).downloadedBytes).toBeGreaterThan(0);
    expect(retained).toBeGreaterThan(0);
    const media = requests
      .slice(before)
      .filter(
        request =>
          request.path.startsWith(`/${prefix}/`) && !request.path.endsWith('.m3u8') && !request.path.endsWith('.mpd'),
      );
    expect(
      media.every(
        request => request.path.includes('chunk-stream1-00002') || request.path.includes('chunk-stream1-00003'),
      ),
    ).toBe(true);
  });
  it(`${kind} manifest/sequence drift explicitly restarts instead of splicing old segments`, async () => {
    const prefix = `${kind}-change`,
      missing = `/${prefix}/${kind === 'hls' ? 'segment-01.m4s' : 'chunk-stream0-00002.m4s'}`;
    blocked.add(missing);
    const key = crypto.randomUUID();
    await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
    await pauseAt(key, 'download-video');
    const before = requests.length;
    changed.add(prefix);
    released.add(missing);
    await control(key, 'resume');
    await verify(key);
    expect((await progress(key)).resumeNotice).toContain('identity changed');
    expect(
      requests
        .slice(before)
        .some(request => request.path.endsWith(kind === 'hls' ? 'segment-00.m4s' : 'chunk-stream0-00011.m4s')),
    ).toBe(true);
  });
  for (const action of ['Stop', 'Pause all'])
    it(`${kind} live snapshot ${action} stops transport and never promises Resume`, async () => {
      const prefix = `${kind}-live`,
        missing = `/${prefix}/${kind === 'hls' ? 'segment-01.m4s' : 'chunk-stream0-00002.m4s'}`;
      blocked.add(missing);
      const key = crypto.randomUUID();
      await submit(key, `/${prefix}/${kind === 'hls' ? 'playlist.m3u8' : 'manifest.mpd'}`, kind);
      await expect.poll(async () => (await progress(key))?.resumeCapability).toBe('none');
      await expect.poll(async () => (await progress(key))?.completedParts, { timeout: 15_000 }).toBe(1);
      await withNewPage(async page => {
        const sidePanel = action === 'Pause all' && kind === 'dash';
        await page.goto(extensionUrl(sidePanel ? 'side-panel.html' : 'popup.html'));
        if (sidePanel) await page.getByTitle('Downloads', { exact: true }).click();
        const row = page.getByText(key, { exact: true }).locator('..').locator('..').locator('..');
        await expect.poll(() => page.locator('body').innerText()).toContain('Live playlist');
        expect(await row.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(0);
        const names = await page.evaluate(async key => {
          const records = Object.values(
            (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records,
          ) as { jobKey: string; name: string }[];
          return records
            .filter(record => record.jobKey === key)
            .map(record => record.name.replace(/\.(?:part-\d+|init)$/, ''));
        }, key);
        expect(names.length).toBeGreaterThan(0);
        await page.getByRole('button', { name: action, exact: true }).click();
        await waitStage(key, 'cancelled');
        if (action === 'Pause all') expect((await progress(key)).error).toContain('Live snapshot stopped by Pause all');
        const remaining = await page.evaluate(async key => {
          const records = Object.values(
            (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records,
          ) as { jobKey: string }[];
          const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
            keys(): AsyncIterableIterator<string>;
          };
          const files: string[] = [];
          for await (const name of root.keys()) files.push(name);
          return { records: records.filter(record => record.jobKey === key).length, files };
        }, key);
        expect(remaining.records).toBe(0);
        expect(remaining.files.some(file => names.some(name => file === name || file.startsWith(`${name}.`)))).toBe(
          false,
        );
      });
      await waitStage(key, 'cancelled');
      expect((await progress(key)).resumeCapability).toBe('none');
    });
}

for (const kind of ['hls', 'dash']) {
  it(`${kind} completed live snapshot survives mux failure and restart; Retry needs no media or playlist requests`, async () => {
    const prefix = kind === 'hls' ? 'hls-live-tracks' : 'dash-live-mux';
    const key = crypto.randomUUID();
    await submit(key + '-seed', '/hls-seed/playlist.m3u8', 'hls');
    await verify(key + '-seed');
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      const cdp = await injectNextMuxFailure(page);
      await submit(key, `/${prefix}/${kind === 'hls' ? 'master.m3u8' : 'manifest.mpd'}`, kind);
      await waitStage(key, 'failed');
      expect((await progress(key)).resumeCapability).toBe('complete-input');
      expect((await progress(key)).error).toContain('completed inputs are retained');
      await page.goto(extensionUrl(`popup.html?dlKey=${key}#download-details`));
      await expect.poll(() => page.locator('body').innerText()).toContain('Completed snapshot · Retry processing');
      await cdp.detach();
    });
    expired.add(prefix);
    await stopBrowser();
    await startBrowser();
    const before = requests.length;
    await control(key, 'retry');
    await verify(key);
    expect(requests.slice(before).filter(request => request.path.startsWith(`/${prefix}/`))).toEqual([]);
  });
}
