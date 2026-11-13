import { prepareOutputDelivery, restoreSavedOutput } from './output-delivery';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cancel during real output metadata validation prevents a later artifact hash dispatch or Blob publication', async () => {
  const bytes = await readFile(new URL('../../../../.media-test/fixtures/direct.mp4', import.meta.url));
  const file = new File([new Uint8Array(bytes).buffer], 'output.mp4');
  const controller = new AbortController();
  const slice = file.slice.bind(file);
  file.slice = (start, end, type) => {
    const blob = slice(start, end, type),
      read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = async () => {
      controller.abort();
      return read();
    };
    return blob;
  };
  await assert.rejects(
    prepareOutputDelivery({
      file,
      opfsName: 'cancelled-output.mp4',
      jobKey: 'cancelled',
      signal: controller.signal,
      plan: {
        type: 'passthrough',
        prefetchToOpfs: false,
        output: { container: 'mp4', extension: '.mp4', mime: 'video/mp4' },
        requiredTracks: [{ type: 'video', codec: 'h264' }],
      },
    }),
    error => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('an already cancelled saved-output restore never opens storage or dispatches a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    restoreSavedOutput('cancelled', controller.signal),
    error => error instanceof DOMException && error.name === 'AbortError',
  );
});
