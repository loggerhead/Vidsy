import { ResourceBudget } from './resource-budget';
import assert from 'node:assert/strict';
import test from 'node:test';

test('rotates jobs under contention and never exceeds its budget', async () => {
  const budget = new ResourceBudget(1);
  const release = await budget.acquire('A');
  const order: string[] = [];
  const a = budget.acquire('A').then(release => {
    order.push('A');
    release();
  });
  const b = budget.acquire('B').then(release => {
    order.push('B');
    release();
  });
  release();
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['B', 'A']);
});

test('cancelled queued work releases no extra slot', async () => {
  const budget = new ResourceBudget(1);
  const release = await budget.acquire('A');
  const controller = new AbortController();
  const pending = budget.acquire('B', controller.signal);
  controller.abort(new Error('Paused'));
  await assert.rejects(pending, /Paused/);
  release();
  (await budget.acquire('C'))();
});
