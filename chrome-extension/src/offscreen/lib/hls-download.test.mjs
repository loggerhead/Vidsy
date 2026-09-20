// Run with: node --import tsx --experimental-test-module-mocks --test <this file>
// Fixtures: tools/media-remux/generate-fixtures.sh /tmp/vidsy-web-media-remux/fixtures-full
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

const enabled = process.execArgv.includes('--experimental-test-module-mocks');
test('HLS download orchestration preserves separate tracks and validates delivery', { skip: !enabled }, async t => {
  const root = process.env.VIDSY_MEDIA_FIXTURES ?? '/tmp/vidsy-web-media-remux/fixtures-full';
  const video = await readFile(path.join(root, 'separate-video.mp4'));
  const audio = await readFile(path.join(root, 'separate-audio.m4a'));
  const combined = await readFile(path.join(root, 'direct.mp4'));
  const files = new Map();
  const calls = [];
  let failAudio = false;
  let silentOutput = false;
  let cancelAfterVideo = false;
  const controllers = new Map();
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
  mock.module(new URL('./progress.ts', import.meta.url).href, { namedExports: { updateProgress: async () => {} } });
  mock.module(new URL('./segment-fetcher.ts', import.meta.url).href, {
    namedExports: { activeAbortControllers: controllers },
  });
  mock.module(new URL('./worker-client.ts', import.meta.url).href, {
    namedExports: {
      cancelWorkerJob: () => {},
      removeOpfs: async name => {
        files.delete(name);
      },
      getOpfsFile: async name => {
        assert.ok(files.has(name), 'requested input exists');
        return new File([files.get(name)], name);
      },
      fetchSegmentsToOpfs: async args => {
        calls.push(args.stage);
        if (args.stage === 'download-audio' && failAudio) throw new Error('audio fetch failed');
        const bytes = args.stage === 'download-audio' ? audio : video;
        files.set(args.opfsName, bytes);
        if (cancelAfterVideo) controllers.get(args.jobKey).abort();
        return { totalBytes: bytes.length, opfsName: args.opfsName };
      },
      muxInWorker: async args => {
        calls.push('mux');
        assert.equal(args.input.urls.length, 2);
        assert.deepEqual(args.plan.requiredTracks, [
          { type: 'video', codec: 'h264' },
          { type: 'audio', codec: 'aac' },
        ]);
        assert.equal(args.plan.type, 'copy-to-mp4');
        files.set(args.outputOpfsName, silentOutput ? video : combined);
        return { outputOpfsName: args.outputOpfsName, totalBytes: combined.length };
      },
    },
  });
  const fetchMock = mock.method(globalThis, 'fetch', async input => {
    const url = String(input);
    if (url.endsWith('/master.m3u8'))
      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x180,AUDIO="a"\nvideo.m3u8',
      );
    if (url.endsWith('.m3u8'))
      return new Response(
        `#EXTM3U\n#EXT-X-MAP:URI="${url.includes('audio') ? 'audio' : 'video'}.mp4"\n#EXTINF:2,\nsegment.m4s`,
      );
    const bytes = url.endsWith('/audio.mp4') ? audio : video;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  try {
    const { downloadHlsMuxed } = await import('./hls-download.ts');
    const { cleanupBlob } = await import('./blob-cleanup.ts');
    for (const direct of [false, true]) {
      await t.test(
        direct ? 'explicit quality retains its paired audio' : 'master default downloads and muxes both tracks',
        async () => {
          calls.length = 0;
          const result = await downloadHlsMuxed(
            `https://cdn.example/${direct ? 'video' : 'master'}.m3u8`,
            'test.mp4',
            'mp4',
            'test',
            undefined,
            direct ? 'https://cdn.example/audio.m3u8' : undefined,
          );
          assert.deepEqual(calls, ['download-video', 'download-audio', 'mux']);
          assert.equal(result.artifact.tracks.length, 2);
          assert.equal(files.size, 1, 'only the delivered output survives');
          await cleanupBlob(result.blobUrl);
          assert.equal(files.size, 0);
          assert.equal(controllers.size, 0);
        },
      );
    }
    await t.test('audio failure cleans inputs and never muxes', async () => {
      calls.length = 0;
      failAudio = true;
      await assert.rejects(
        downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'),
        /audio fetch failed/,
      );
      assert.ok(!calls.includes('mux'));
      assert.equal(files.size, 0);
      assert.equal(controllers.size, 0);
      failAudio = false;
    });
    await t.test('silent output fails the real artifact validator', async () => {
      silentOutput = true;
      await assert.rejects(
        downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'),
        /missing required audio/,
      );
      assert.equal(files.size, 0);
      silentOutput = false;
    });
    await t.test('cancel between tracks stops audio and cleans video', async () => {
      calls.length = 0;
      cancelAfterVideo = true;
      await assert.rejects(downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'), /cancelled/);
      assert.deepEqual(calls, ['download-video']);
      assert.equal(files.size, 0);
      assert.equal(controllers.size, 0);
    });
  } finally {
    fetchMock.mock.restore();
    globalThis.chrome = originalChrome;
    mock.restoreAll();
  }
});
