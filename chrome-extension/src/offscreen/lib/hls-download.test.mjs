import process from 'node:process';
import { File } from 'node:buffer';
import { URL } from 'node:url';
const { Response, Headers } = globalThis;
// Run with: node --import tsx --experimental-test-module-mocks --test <this file>
// Prepare first: node tools/media-remux/prepare-test-media.mjs
import { DownloadFailure } from './download-failure.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

const enabled = process.execArgv.includes('--experimental-test-module-mocks');
test('HLS download orchestration preserves separate tracks and validates delivery', { skip: !enabled }, async t => {
  const root =
    process.env.VIDSY_MEDIA_FIXTURES ?? path.resolve(import.meta.dirname, '../../../../.media-test/fixtures');
  const video = await readFile(path.join(root, 'separate-video.mp4'));
  const audio = await readFile(path.join(root, 'separate-audio.m4a'));
  const combined = await readFile(path.join(root, 'direct.mp4'));
  const files = new Map();
  const calls = [];
  let failAudio = false;
  let failMux = false;
  let silentOutput = false;
  let cancelAfterVideo = false;
  let requireTrackCredentials = false;
  const trackCredentials = [];
  const controllers = new Map();
  const stopIntents = new Map();
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
  mock.module(new URL('./progress.ts', import.meta.url).href, { namedExports: { updateProgress: async () => {} } });
  mock.module(new URL('./segment-fetcher.ts', import.meta.url).href, {
    namedExports: { activeAbortControllers: controllers, downloadStopIntents: stopIntents },
  });
  mock.module(new URL('./worker-client.ts', import.meta.url).href, {
    namedExports: {
      persistOutputArtifact: async () => {},
      restoreOutputArtifactFile: async name => new File([files.get(name)], name),
      cancelWorkerJob: () => {},
      discardWorkerJobFiles: async () => {
        files.clear();
      },
      removeOpfs: async name => {
        files.delete(name);
      },
      getOpfsFile: async name => {
        assert.ok(files.has(name), 'requested input exists');
        return new File([files.get(name)], name);
      },
      fetchSegmentsToOpfs: async args => {
        calls.push(args.stage);
        if (requireTrackCredentials) {
          const expected = args.stage === 'download-audio' ? 'Bearer audio' : 'Bearer video';
          assert.equal(args.keyHeaders?.Authorization, expected, 'segment requests use their track credentials');
          trackCredentials.push(args.stage);
        }
        if (args.stage === 'download-audio' && failAudio) throw new Error('audio fetch failed');
        const bytes = args.stage === 'download-audio' ? audio : video;
        files.set(args.opfsName, bytes);
        if (cancelAfterVideo) {
          stopIntents.set(args.jobKey, 'cancel');
          controllers.get(args.jobKey).abort();
        }
        return { totalBytes: bytes.length, opfsName: args.opfsName };
      },
      muxInWorker: async args => {
        calls.push('mux');
        if (failMux) throw new DownloadFailure('processing', 'Injected mux failure');
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
  const fetchMock = mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (requireTrackCredentials) {
      const expected = url.includes('audio') ? 'Bearer audio' : 'Bearer video';
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        expected,
        'playlist and metadata requests use their track credentials',
      );
      trackCredentials.push(url);
    }
    if (url.endsWith('/master.m3u8'))
      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x180,AUDIO="a"\nvideo.m3u8',
      );
    if (url.endsWith('.m3u8'))
      return new Response(
        `#EXTM3U\n#EXT-X-MAP:URI="${url.includes('audio') ? 'audio' : 'video'}.mp4"\n#EXTINF:2,\nsegment.m4s\n#EXT-X-ENDLIST`,
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
    await t.test('separate authenticated HLS tracks keep their own credentials for probes and payload', async () => {
      requireTrackCredentials = true;
      try {
        const result = await downloadHlsMuxed(
          'https://cdn.example/video.m3u8',
          'test.mp4',
          'mp4',
          'auth-tracks',
          { Authorization: 'Bearer video' },
          'https://cdn.example/audio.m3u8',
          { Authorization: 'Bearer audio' },
        );
        assert.ok(trackCredentials.includes('https://cdn.example/audio.m3u8'));
        assert.ok(trackCredentials.includes('download-audio'));
        assert.equal(result.artifact.tracks.length, 2);
        await cleanupBlob(result.blobUrl);
        assert.equal(files.size, 0);
      } finally {
        requireTrackCredentials = false;
      }
    });
    await t.test('audio failure retains completed video and never muxes', async () => {
      calls.length = 0;
      failAudio = true;
      await assert.rejects(
        downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'),
        /audio fetch failed/,
      );
      assert.ok(!calls.includes('mux'));
      assert.equal(files.size, 1);
      assert.equal(controllers.size, 0);
      files.clear();
      failAudio = false;
    });
    await t.test('mux failure retains both fully downloaded HLS track inputs', async () => {
      failMux = true;
      calls.length = 0;
      await assert.rejects(
        downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'),
        /Injected mux failure/,
      );
      assert.deepEqual(calls, ['download-video', 'download-audio', 'mux']);
      assert.equal(files.size, 2);
      assert.equal(controllers.size, 0);
      files.clear();
      failMux = false;
    });
    await t.test('silent output fails the real artifact validator', async () => {
      silentOutput = true;
      await assert.rejects(
        downloadHlsMuxed('https://cdn.example/master.m3u8', 'test.mp4', 'mp4', 'test'),
        /missing required audio/,
      );
      assert.equal(files.size, 2, 'valid complete input tracks survive an invalid mux output');
      files.clear();
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
