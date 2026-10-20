import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

test('cancel while loading libav prevents ffmpeg and releases the late instance', async () => {
  let release;
  let created;
  const loading = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { created = resolve; });
  let ffmpeg = 0;
  let terminated = 0;
  const instance = { ffmpeg: async () => { ffmpeg++; return 0; }, terminate: () => { terminated++; } };
  mock.module(new URL('./libav.ts', import.meta.url).href, { namedExports: {
    createLibAV: async () => { created(); await loading; return instance; },
    registerOutputDevice: async () => {}, registerJsfetch: async () => {},
  } });
  const removed = [];
  mock.module(new URL('./opfs.ts', import.meta.url).href, { namedExports: { opfs: { remove: async name => { removed.push(name); } } } });
  let receive;
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  Object.assign(globalThis, { self: {
    addEventListener: (_name, listener) => { receive = listener; },
    postMessage: message => { if (message.type === 'error') finished(message); },
  } });
  await import('./main.ts');
  receive({ data: { type: 'mux', jobId: 'mux-loading', jobKey: 'cancel-loading', outputOpfsName: 'cancel.mp4', stage: 'mux',
    plan: { type: 'copy-to-mp4', prefetchToOpfs: true, requiredTracks: [{ type: 'video', codec: 'h264' }],
      output: { container: 'mp4', extension: '.mp4', mime: 'video/mp4' } },
    input: { urls: ['jsfetch:blob:fixture'] },
  } });
  await entered;
  receive({ data: { type: 'cancel', jobKey: 'cancel-loading' } });
  release();
  assert.match((await done).error, /aborted/i);
  assert.equal(ffmpeg, 0);
  assert.equal(terminated, 1);
  assert.deepEqual(removed, ['cancel.mp4']);
});
