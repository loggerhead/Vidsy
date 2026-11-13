import { setExecutionProgressReporter } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import assert from 'node:assert/strict';
import test from 'node:test';

test('cancel while reading connection settings prevents a later worker dispatch', async () => {
  const previousChrome = globalThis.chrome;
  const previousWorker = globalThis.Worker;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const area = {
    get: async () => {
      await gate;
      return { 'media-settings': { downloadConnectionsPerFile: 8 } };
    },
    onChanged: { addListener() {} },
  };
  const messages: string[] = [];
  const payloads: {
    type: string;
    jobId?: string;
    resourceVersion?: string;
    weakEtag?: string;
    validationMethod?: string;
  }[] = [];
  let onMessage!: (event: { data: object }) => void;
  let progressReports = 0;
  setExecutionProgressReporter(() => {
    progressReports++;
    return true;
  });
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        getURL: (url: string) => url,
        sendMessage: async () => {
          await gate;
          return { downloadConnectionsPerFile: 8 };
        },
      },
      storage: { local: area, session: area, sync: area },
    },
    Worker: class {
      addEventListener(name: string, listener: typeof onMessage) {
        if (name === 'message') onMessage = listener;
      }
      postMessage(message: (typeof payloads)[number]) {
        messages.push(message.type);
        payloads.push(message);
      }
    },
  });
  const controller = new AbortController();
  activeAbortControllers.set('pending-start', controller);
  try {
    const { fetchRangesToOpfs, cancelWorkerJob } = await import('./worker-client');
    const rejected = assert.rejects(
      fetchRangesToOpfs({
        jobKey: 'pending-start',
        opfsName: 'pending.bin',
        url: 'https://source.test/video',
        ranges: [{ start: 0, end: 9 }],
        totalBytes: 10,
        stage: 'download-video',
        maxConnections: 1,
      }),
      /aborted/i,
    );
    controller.abort();
    cancelWorkerJob('pending-start');
    release();
    await rejected;
    assert.deepEqual(messages, ['cancel']);
    onMessage({
      data: {
        type: 'progress',
        jobId: 'finished-rpc',
        jobKey: 'pending-start',
        stage: 'download-video',
        downloadedBytes: 999,
      },
    });
    assert.equal(progressReports, 0, 'late RPC progress cannot be attributed to a new attempt of the same request');
    const forwarded = fetchRangesToOpfs({
      jobKey: 'date-fields',
      opfsName: 'date.bin',
      url: 'https://source.test/video',
      ranges: [{ start: 0, end: 9 }],
      totalBytes: 10,
      stage: 'download-video',
      resourceVersion: 'Tue, 10 Nov 2026 08:00:00 GMT',
      weakEtag: 'W/"v1"',
      validationMethod: 'last-modified',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const request = payloads.find(message => message.type === 'fetch-ranges')!;
    assert.equal(request.validationMethod, 'last-modified');
    assert.equal(request.weakEtag, 'W/"v1"');
    assert.equal(request.resourceVersion, 'Tue, 10 Nov 2026 08:00:00 GMT');
    onMessage({ data: { type: 'fetch-done', jobId: request.jobId, totalBytes: 10 } });
    await forwarded;
  } finally {
    release();
    activeAbortControllers.delete('pending-start');
    Object.assign(globalThis, { chrome: previousChrome, Worker: previousWorker });
  }
});
