import { DownloadFailure } from '../lib/download-failure';
import type { HttpValidationMethod } from '../lib/http-validator';
import type { ChunkProgress } from '@extension/shared';

export const RANGE_CHECKPOINT_BYTES = 1024 * 1024;
export type RangeCheckpoint = { i: number; start: number; end: number; downloaded: number; hashes: string[] };

export type RangeSource = {
  url: string;
  resourceVersion?: string;
  weakEtag?: string;
  validationMethod?: HttpValidationMethod;
  totalBytes: number;
  ranges: { start: number; end: number }[];
};
export type RangeResumeRecord = { source: RangeSource; done: ChunkProgress[]; checkpoints?: RangeCheckpoint[] };
export class RangeResumeRegistry {
  private records = new Map<string, RangeResumeRecord>();
  restore(name: string, record?: RangeResumeRecord): void {
    if (!record) return;
    if (
      !record.source ||
      !Array.isArray(record.source.ranges) ||
      !Array.isArray(record.done) ||
      record.done.some(
        chunk =>
          !Number.isSafeInteger(chunk.i) ||
          chunk.i < 0 ||
          !record.source.ranges[chunk.i] ||
          chunk.start !== record.source.ranges[chunk.i].start ||
          chunk.end !== record.source.ranges[chunk.i].end ||
          chunk.status !== 'done' ||
          chunk.downloaded !== chunk.end - chunk.start + 1,
      ) ||
      new Set(record.done.map(chunk => chunk.i)).size !== record.done.length ||
      (record.checkpoints &&
        (!Array.isArray(record.checkpoints) ||
          new Set(record.checkpoints.map(checkpoint => checkpoint.i)).size !== record.checkpoints.length ||
          record.checkpoints.some(checkpoint => {
            const range = record.source.ranges[checkpoint.i];
            return (
              !range ||
              !Number.isSafeInteger(checkpoint.i) ||
              checkpoint.i < 0 ||
              checkpoint.start !== range.start ||
              checkpoint.end !== range.end ||
              !Number.isSafeInteger(checkpoint.downloaded) ||
              checkpoint.downloaded <= 0 ||
              checkpoint.downloaded > range.end - range.start + 1 ||
              (checkpoint.downloaded !== range.end - range.start + 1 &&
                checkpoint.downloaded % RANGE_CHECKPOINT_BYTES !== 0) ||
              !Array.isArray(checkpoint.hashes) ||
              checkpoint.hashes.length !== Math.ceil(checkpoint.downloaded / RANGE_CHECKPOINT_BYTES) ||
              checkpoint.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))
            );
          })))
    )
      throw new DownloadFailure('integrity', 'Persisted range indices are invalid');
    this.records.set(name, structuredClone(record));
  }
  snapshot(name: string): RangeResumeRecord | undefined {
    const record = this.records.get(name);
    return record ? structuredClone(record) : undefined;
  }
  begin(name: string, source: RangeSource, size: number, samplesValidated = false): ChunkProgress[] | undefined {
    const previous = this.records.get(name);
    const valid =
      (source.validationMethod === 'boundary-sample'
        ? samplesValidated
        : source.validationMethod === 'last-modified'
          ? samplesValidated && source.resourceVersion
          : source.resourceVersion && /^"[^\r\n]*"$/.test(source.resourceVersion)) &&
      previous &&
      previous.source.url === source.url &&
      previous.source.resourceVersion === source.resourceVersion &&
      previous.source.weakEtag === source.weakEtag &&
      (previous.source.validationMethod ?? 'etag') === (source.validationMethod ?? 'etag') &&
      previous.source.totalBytes === source.totalBytes &&
      previous.source.ranges.length === source.ranges.length &&
      previous.source.ranges.every(
        (range, index) => range.start === source.ranges[index].start && range.end === source.ranges[index].end,
      ) &&
      previous.done.every(chunk => chunk.end < size) &&
      (previous.checkpoints ?? []).every(checkpoint => checkpoint.start + checkpoint.downloaded <= size) &&
      size <= source.totalBytes;
    if (valid && (previous.done.length || previous.checkpoints?.length)) {
      const chunks = new Map(previous.done.map(chunk => [chunk.i, { ...chunk }]));
      for (const checkpoint of previous.checkpoints ?? [])
        if (!chunks.has(checkpoint.i))
          chunks.set(checkpoint.i, {
            i: checkpoint.i,
            start: checkpoint.start,
            end: checkpoint.end,
            downloaded: checkpoint.downloaded,
            status: 'pending',
          });
      return [...chunks.values()];
    }
    this.records.set(name, { source, done: [] });
    if (previous?.done.length || previous?.checkpoints?.length) {
      throw new DownloadFailure('integrity', 'Range identity, layout, validator or retained file length changed');
    }
    return undefined;
  }
  completed(name: string, chunk: ChunkProgress) {
    const record = this.records.get(name);
    if (record) record.done = [...record.done.filter(item => item.i !== chunk.i), { ...chunk, status: 'done' }];
  }
  checkpoint(name: string, checkpoint: RangeCheckpoint) {
    const record = this.records.get(name);
    if (record)
      record.checkpoints = [
        ...(record.checkpoints ?? []).filter(entry => entry.i !== checkpoint.i),
        structuredClone(checkpoint),
      ];
  }
  remove(name: string) {
    this.records.delete(name);
  }
}
