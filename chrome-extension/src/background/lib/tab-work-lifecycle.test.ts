import { createTabWorkLifecycle } from './tab-work-lifecycle';
import assert from 'node:assert/strict';
import test from 'node:test';

test('starts only on first activation and keeps work running when another tab becomes active', async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void started.push(`${work.tabId}:${work.generation}`),
    stop: async work => void stopped.push(`${work.tabId}:${work.generation}`),
  });

  await lifecycle.activate(1, true);
  await lifecycle.activate(2, true);
  await lifecycle.activate(1, true);

  assert.deepEqual(started, ['1:0', '2:0']);
  assert.deepEqual(stopped, []);
  assert.equal(lifecycle.isRunning(1), true);
  assert.equal(lifecycle.isRunning(2), true);
});

test('refresh cancels, clears the old generation, then starts the replacement only when ready', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}:${work.signal.aborted}`),
  });

  await lifecycle.activate(1, true);
  await lifecycle.navigationStarted(1);
  await lifecycle.navigationStarted(1);
  assert.equal(lifecycle.isRunning(1), false);
  await lifecycle.pageReady(1);

  assert.deepEqual(events, ['start:1:0', 'stop:1:1:true', 'start:1:1']);
});

test('navigation captures early network requests while old-document cleanup is still pending', async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => {
    releaseCleanup = resolve;
  });
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => cleanup,
  });

  await lifecycle.activate(1, true);
  const navigation = lifecycle.navigationStarted(1);
  const generation = lifecycle.generationForCapture(1);

  assert.equal(generation, 1);
  assert.equal(lifecycle.isCapturing(1), true);
  assert.equal(lifecycle.isCurrent(1, 0), false);
  assert.equal(lifecycle.isCurrent(1, 1), true);

  let ready = false;
  const captureReady = lifecycle.waitForCapture(1, generation!).then(value => {
    ready = value;
  });
  await Promise.resolve();
  assert.equal(ready, false);

  releaseCleanup();
  await navigation;
  await captureReady;
  assert.equal(ready, true);
  assert.equal(lifecycle.isRunning(1), false);

  await lifecycle.pageReady(1);
  assert.equal(lifecycle.isRunning(1), true);
});

test('closing a tab cancels its work without starting a replacement', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.activate(1, true);
  await lifecycle.close(1);
  await lifecycle.pageReady(1);

  assert.deepEqual(events, ['start:1:0', 'stop:1:1']);
  assert.equal(lifecycle.isRunning(1), false);
});
