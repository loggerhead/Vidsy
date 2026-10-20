export const expectedResponseBytes = (response: Response): number | undefined => {
  const rawLength = response.headers.get('content-length');
  if (!rawLength) return undefined;
  const length = Number(rawLength);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
};

export const assertSuccessfulResponse = (response: Response): void => {
  if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
};

export const assertCompleteResponse = (response: Response, actualBytes: number): void => {
  const expectedBytes = expectedResponseBytes(response);
  if (expectedBytes !== undefined && actualBytes !== expectedBytes) {
    throw new Error(`Response body length mismatch: expected ${expectedBytes} bytes, received ${actualBytes}`);
  }
};

export type ExpectedRange = { start: number; end: number; total?: number; resourceVersion?: string };
export class RangeResponseError extends Error {}

export const assertRangeResponse = (response: Response, range: ExpectedRange, actualBytes?: number): void => {
  const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (
    response.status !== 206 ||
    !match ||
    Number(match[1]) !== range.start ||
    Number(match[2]) !== range.end ||
    !Number.isSafeInteger(Number(match[3])) ||
    Number(match[3]) <= range.end ||
    (range.total !== undefined && Number(match[3]) !== range.total) ||
    (range.resourceVersion && response.headers.get('etag') !== range.resourceVersion)
  ) {
    throw new RangeResponseError(`Invalid Range response: expected bytes ${range.start}-${range.end}/${range.total}`);
  }
  const expected = range.end - range.start + 1;
  const declared = expectedResponseBytes(response);
  if ((declared !== undefined && declared !== expected) || (actualBytes !== undefined && actualBytes !== expected)) {
    throw new RangeResponseError(
      `Range body length mismatch: expected ${expected}, received ${actualBytes ?? declared}`,
    );
  }
};
