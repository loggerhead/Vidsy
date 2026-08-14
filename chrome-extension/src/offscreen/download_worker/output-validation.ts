const assertSuccessfulMux = (exitCode: number): void => {
  if (exitCode !== 0) {
    throw new Error(`Media processing failed with exit code ${exitCode}`);
  }
};

const assertNonEmptyOutput = (totalBytes: number): void => {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('Media processing produced an empty output file');
  }
};

export { assertNonEmptyOutput, assertSuccessfulMux };
