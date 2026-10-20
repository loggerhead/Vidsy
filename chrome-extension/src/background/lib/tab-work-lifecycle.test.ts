import { createTabWorkLifecycle } from './tab-work-lifecycle';
import assert from 'node:assert/strict';
import test from 'node:test';

test('starts only on first tracking and keeps work running when another tab is tracked', async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void started.push(`${work.tabId}:${work.generation}`),
    stop: async work => void stopped.push(`${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, true);
  await lifecycle.track(2, true);
  await lifecycle.track(1, true);

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

  await lifecycle.track(1, true);
  await lifecycle.navigationStarted(1);
  await lifecycle.navigationStarted(1);
  assert.equal(lifecycle.isRunning(1), false);
  await lifecycle.pageReady(1);

  assert.deepEqual(events, ['start:1:0', 'stop:1:1:true', 'start:1:1']);
});

test('duplicate loading and URL notifications advance an untracked tab only once', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.navigationStarted(1, 'https://example.com/watch');
  const generation = lifecycle.generationForCapture(1);
  await lifecycle.navigationStarted(1, 'https://example.com/watch');

  assert.equal(generation, undefined);
  await lifecycle.track(1, false, 'https://example.com/watch');
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

  await lifecycle.track(1, true);
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

test('content readiness waits for old-document cleanup before starting page work', async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => {
    releaseCleanup = resolve;
  });
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.generation}`),
    stop: async work => {
      events.push(`stop:${work.generation}`);
      await cleanup;
    },
  });

  await lifecycle.track(1, true);
  const navigation = lifecycle.navigationStarted(1);
  const ready = lifecycle.track(1, true);
  await Promise.resolve();
  assert.deepEqual(events, ['start:0', 'stop:1']);

  releaseCleanup();
  await Promise.all([navigation, ready]);
  assert.deepEqual(events, ['start:0', 'stop:1', 'start:1']);
});

test('initial loading activation and navigation share one capture generation', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, false);
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

  await lifecycle.track(1, false);
  await lifecycle.track(1, true);
  await lifecycle.navigationStarted(1);

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
});

test('a response after a same-document URL change keeps existing work and detections', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, true, 'https://example.com/watch');
  await lifecycle.prepareCapture(1, false, 'https://example.com/watch?source=feed');

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
  assert.equal(lifecycle.isRunning(1), true);
});

test('a loading response after a same-document URL change does not clear detections', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, true, 'https://example.com/watch');
  await lifecycle.prepareCapture(1, true, 'https://example.com/watch?source=feed');

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
  assert.equal(lifecycle.isRunning(1), true);
});

test('a committed document replacement clears and restarts its generation', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, true, 'https://example.com/watch');
  await lifecycle.navigationStarted(1, 'https://example.com/next');
  await lifecycle.pageReady(1);
  assert.equal(lifecycle.generationForCapture(1), 1);
  assert.deepEqual(events, ['start:1:0', 'stop:1:1', 'start:1:1']);
});

test('a response establishes capture for a background tab document', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, true, 'https://example.com/watch');

  assert.equal(lifecycle.isCapturing(1), true);
  assert.equal(lifecycle.generationForCapture(1), 0);
});

test('a response can establish generation zero for a newly loading tab', async () => {
  const lifecycle = createTabWorkLifecycle({
    start: async () => undefined,
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, true, 'https://example.com/watch');

  assert.equal(lifecycle.isCapturing(1), true);
  assert.equal(lifecycle.generationForCapture(1), 0);
});

test('a response restores page work for a newly tracked tab that already completed', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async () => undefined,
  });

  await lifecycle.prepareCapture(1, false, 'https://example.com/watch');

  assert.equal(lifecycle.generationForCapture(1), 0);
  assert.deepEqual(events, ['start:1:0']);
});

test('closing a tab cancels its work without starting a replacement', async () => {
  const events: string[] = [];
  const lifecycle = createTabWorkLifecycle({
    start: async work => void events.push(`start:${work.tabId}:${work.generation}`),
    stop: async work => void events.push(`stop:${work.tabId}:${work.generation}`),
  });

  await lifecycle.track(1, true);
  await lifecycle.close(1);
  await lifecycle.pageReady(1);

  assert.deepEqual(events, ['start:1:0', 'stop:1:1']);
  assert.equal(lifecycle.isRunning(1), false);
});
