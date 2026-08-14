import { assertNonEmptyOutput, assertSuccessfulMux } from './output-validation';
import assert from 'node:assert/strict';
import test from 'node:test';

test('assertSuccessfulMux rejects non-zero media processor exit codes', () => {
  assert.throws(() => assertSuccessfulMux(1), /exit code 1/);
  assert.doesNotThrow(() => assertSuccessfulMux(0));
});

test('assertNonEmptyOutput rejects empty output files', () => {
  assert.throws(() => assertNonEmptyOutput(0), /empty output file/);
  assert.doesNotThrow(() => assertNonEmptyOutput(1));
});
