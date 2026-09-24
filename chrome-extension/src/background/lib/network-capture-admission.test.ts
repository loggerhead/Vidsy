import { createNetworkCaptureAdmission } from './network-capture-admission';
import assert from 'node:assert/strict';
import test from 'node:test';

test('retains an early response until initial capture state is known', async () => {
  let finishBootstrap!: () => void;
  const bootstrap = new Promise<void>(resolve => {
    finishBootstrap = resolve;
  });
  let capturing = false;
  const admitted: number[] = [];
  const admission = createNetworkCaptureAdmission({
    bootstrap,
    prepareCapture: async () => undefined,
    isCapturing: () => capturing,
    handle: async details => void admitted.push(details.tabId),
  });

  const earlyResponse = admission({ tabId: 42 });
  await Promise.resolve();
  assert.deepEqual(admitted, []);

  capturing = true;
  finishBootstrap();
  await earlyResponse;
  assert.deepEqual(admitted, [42]);
});

test('aligns a loading replacement document before assigning its response generation', async () => {
  const events: string[] = [];
  const admission = createNetworkCaptureAdmission({
    bootstrap: Promise.resolve(),
    prepareCapture: async tabId => void events.push(`prepare:${tabId}`),
    isCapturing: () => true,
    handle: async details => void events.push(`handle:${details.tabId}`),
  });

  await admission({ tabId: 42 });
  assert.deepEqual(events, ['prepare:42', 'handle:42']);
});

test('prepareCapture is the sole authority for admitting a newly observed tab', async () => {
  let capturing = false;
  const admitted: number[] = [];
  const prepared: number[] = [];
  const admission = createNetworkCaptureAdmission({
    bootstrap: Promise.resolve(),
    prepareCapture: async tabId => {
      prepared.push(tabId);
      capturing = true;
    },
    isCapturing: () => capturing,
    handle: async details => void admitted.push(details.tabId),
  });

  await admission({ tabId: 42 });
  assert.deepEqual(prepared, [42]);
  assert.deepEqual(admitted, [42]);
});

test('drops a response when its tab is still outside capture after bootstrap', async () => {
  const admitted: number[] = [];
  const admission = createNetworkCaptureAdmission({
    bootstrap: Promise.resolve(),
    prepareCapture: async () => undefined,
    isCapturing: () => false,
    handle: async details => void admitted.push(details.tabId),
  });

  await admission({ tabId: 7 });
  assert.deepEqual(admitted, []);
});
