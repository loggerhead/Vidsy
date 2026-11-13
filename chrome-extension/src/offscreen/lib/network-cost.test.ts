import { detectNetworkCost } from './network-cost';
import assert from 'node:assert/strict';
import test from 'node:test';

test('metered policy uses reported connection type or data-saving preference, never throughput as cellular proof', () => {
  assert.deepEqual(detectNetworkCost({ type: 'cellular' }), { supported: true, metered: true });
  assert.deepEqual(detectNetworkCost({ type: 'wifi', effectiveType: '4g' }), { supported: true, metered: false });
  assert.deepEqual(detectNetworkCost({ effectiveType: '4g' }), { supported: false, metered: false });
  assert.deepEqual(detectNetworkCost({ saveData: true }), { supported: false, metered: true });
});
