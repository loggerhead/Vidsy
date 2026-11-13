import {
  DownloadFailure,
  LiveSnapshotFailure,
  explainFailure,
  failureKind,
  shouldDiscardInput,
} from './download-failure';
import assert from 'node:assert/strict';
import test from 'node:test';

test('transport and processing failures retain input; integrity failures and cancel discard it', () => {
  for (const kind of ['transport', 'processing', 'integrity'] as const) {
    const error = new DownloadFailure(kind, 'fixture');
    assert.equal(failureKind(error), kind);
    assert.equal(shouldDiscardInput(error), kind === 'integrity');
    assert.equal(shouldDiscardInput(error, 'pause'), kind === 'integrity');
    assert.equal(shouldDiscardInput(error, 'cancel'), true);
    assert.match(explainFailure(error), kind === 'integrity' ? /download again/ : /retained/);
  }
  assert.equal(shouldDiscardInput(new TypeError('fetch failed')), false);
});

test('live transport failure explains discarded snapshot data and never promises cached stream resume', () => {
  const failure = new LiveSnapshotFailure(new TypeError('connection reset'));
  assert.equal(failureKind(failure), 'transport');
  assert.equal(failure.retryable, false);
  assert.match(explainFailure(failure), /partial cache was discarded.*live streams cannot resume/);
  assert.doesNotMatch(explainFailure(failure), /valid cached progress is retained/);
});
