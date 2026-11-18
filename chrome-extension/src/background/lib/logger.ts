import { createLogger, sanitizeLogData } from '@extension/shared';

const log = createLogger('download');

export const dlLog = (stage: string, data?: unknown): void => log.debug(stage, data);

export { sanitizeLogData };
