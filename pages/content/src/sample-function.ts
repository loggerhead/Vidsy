import { createLogger } from '@extension/shared';

export const sampleFunction = () => {
  createLogger('content-sample').debug('called');
};
