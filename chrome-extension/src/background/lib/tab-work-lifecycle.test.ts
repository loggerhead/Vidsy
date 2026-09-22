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

test('duplicate loading and URL notifications advance an inactive tab only once', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.navigationStarted(1, 'https://example.com/watch');
  const generation = lifecycle.generationForCapture(1);
  await lifecycle.navigationStarted(1, 'https://example.com/watch');

  assert.equal(generation, undefined);
  await lifecycle.activate(1, false, 'https://example.com/watch');
  assert.equal(lifecycle.generationForCapture(1), 1);
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

test('initial loading activation and navigation share one capture generation', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.activate(1, false);
  const earlyGeneration = lifecycle.generationForCapture(1);
  await lifecycle.navigationStarted(1);

  assert.equal(earlyGeneration, 0);
  assert.equal(lifecycle.isCurrent(1, earlyGeneration!), true);
  assert.deepEqual(events, []);

  await lifecycle.pageReady(1);
  assert.deepEqual(events, ['start:1:0']);
});

test('loading activation stays in the same generation even if document work started first', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.activate(1, false);
  await lifecycle.activate(1, true);
  await lifecycle.navigationStarted(1);

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
});

test('a response aligns a completed replacement URL before onUpdated arrives', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.activate(1, true, 'about:blank');
  await lifecycle.prepareCapture(1, false, 'https://example.com/watch');

  assert.equal(lifecycle.generationForCapture(1), 1);
  assert.deepEqual(events, ['start:1:0', 'stop:1:1']);

  await lifecycle.navigationStarted(1, 'https://example.com/watch');
  await lifecycle.pageReady(1);
  assert.equal(lifecycle.generationForCapture(1), 1);
  assert.deepEqual(events, ['start:1:0', 'stop:1:1', 'start:1:1']);
});

test('a response cannot establish capture for an inactive unknown tab', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, true, 'https://example.com/watch', false);

  assert.equal(lifecycle.isCapturing(1), false);
  assert.equal(lifecycle.generationForCapture(1), undefined);
});

test('a response can establish generation zero for a newly active loading tab', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, true, 'https://example.com/watch', true);

  assert.equal(lifecycle.isCapturing(1), true);
  assert.equal(lifecycle.generationForCapture(1), 0);
});

test('a response restores page work for a newly active tab that already completed', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, false, 'https://example.com/watch', true);

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
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
