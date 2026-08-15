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
