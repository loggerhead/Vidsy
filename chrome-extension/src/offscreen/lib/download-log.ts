import { createLogger } from '@extension/shared';

const safeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
};

const errorInfo = (error: unknown) => ({
  name: error instanceof Error ? error.name : 'UnknownError',
  message: error instanceof Error ? error.message : String(error),
});

const flowLog = createLogger('download').debug;

export { errorInfo, flowLog, safeUrl };
