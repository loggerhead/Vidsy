import type { ChunkProgress } from '@extension/shared';

type Source = { url: string; resourceVersion?: string; totalBytes: number; ranges: { start: number; end: number }[] };
export class RangeResumeRegistry {
  private records = new Map<string, { source: Source; done: ChunkProgress[] }>();
  begin(name: string, source: Source, size: number): ChunkProgress[] | undefined {
    const previous = this.records.get(name);
    const valid =
      source.resourceVersion &&
      previous &&
      JSON.stringify(previous.source) === JSON.stringify(source) &&
      previous.done.every(chunk => chunk.end < size) &&
      size <= source.totalBytes;
    if (valid && previous.done.length) return previous.done.map(chunk => ({ ...chunk }));
    this.records.set(name, { source, done: [] });
    return undefined;
  }
  completed(name: string, chunk: ChunkProgress) {
    const record = this.records.get(name);
    if (record) record.done = [...record.done.filter(item => item.i !== chunk.i), { ...chunk, status: 'done' }];
  }
  remove(name: string) {
    this.records.delete(name);
  }
}
