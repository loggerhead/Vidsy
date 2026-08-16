import { sampleFunction } from '@src/sample-function';
import { createLogger } from '@extension/shared';

export const startExampleContentScript = (): void => {
  createLogger('content-example').info('started');

  void sampleFunction();
};
