import { createLogger } from './runtime-logger.js';
import type { ColorType } from './types.js';

export const colorfulLog = (message: string, type: ColorType) => {
  const log = createLogger('shared');
  if (type === 'error') log.error(message);
  else if (type === 'warning') log.warn(message);
  else log.info(message, { color: type });
};
