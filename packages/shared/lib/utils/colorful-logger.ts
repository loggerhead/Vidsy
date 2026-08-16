import type { ColorType } from './types.js';
import { createLogger } from './runtime-logger.js';

export const colorfulLog = (message: string, type: ColorType) => {
  const log = createLogger('shared');
  if (type === 'error') log.error(message);
  else if (type === 'warning') log.warn(message);
  else log.info(message, { color: type });
};
