import assert from 'node:assert/strict';
import test from 'node:test';

const data: Record<string, unknown> = {};
const area = {
  get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, structuredClone(data[key])])),
  set: async (value: Record<string, unknown>) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    Object.assign(data, structuredClone(value));
  },
  onChanged: { addListener() {} },
};
Object.assign(globalThis, { chrome: { storage: { local: area, session: area } } });
const { addHistoryEntry, clearHistory } = await import('./history');
const item = (id: string) => ({
  id,
  url: `https://source.test/${id}`,
  kind: 'video' as const,
  source: 'network' as const,
  detectedAt: 1,
});

test('history append and clear share one writer and do not resurrect cleared records', async () => {
  await addHistoryEntry(item('old'), 'success');
  await Promise.all([addHistoryEntry(item('finishing'), 'success'), clearHistory()]);
  assert.deepEqual(data['media-history'], []);
  await Promise.all([addHistoryEntry(item('first'), 'success'), addHistoryEntry(item('second'), 'success')]);
  assert.deepEqual(
    (data['media-history'] as { id: string }[]).map(value => value.id),
    ['second', 'first'],
  );
});
