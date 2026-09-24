import { DeferredMediaSendScheduler } from './media-send-scheduler';
import assert from 'node:assert/strict';
import test from 'node:test';

test('each media element owns an independent deferred send', async () => {
  const sent: string[] = [];
  const scheduler = new DeferredMediaSendScheduler<object>(5);
  const first = {};
  const second = {};

  scheduler.schedule(first, () => sent.push('first'));
  scheduler.schedule(second, () => sent.push('second'));

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.sort(), ['first', 'second']);
});

test('cancelling one media element leaves other deferred sends intact', async () => {
  const sent: string[] = [];
  const scheduler = new DeferredMediaSendScheduler<object>(5);
  const first = {};
  const second = {};

  scheduler.schedule(first, () => sent.push('first'));
  scheduler.schedule(second, () => sent.push('second'));
  scheduler.cancel(first);

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['second']);
});

test('media element identities are stable and distinct', () => {
  const scheduler = new DeferredMediaSendScheduler<object>(5);
  const first = {};
  const second = {};

  assert.equal(scheduler.identity(first), scheduler.identity(first));
  assert.notEqual(scheduler.identity(first), scheduler.identity(second));
});
