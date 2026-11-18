import { createLogger } from '@extension/shared';
import { sampleFunction } from '@src/sample-function';

export const startExampleContentScript = (): void => {
  createLogger('content-example').info('started');

  void sampleFunction();
};
