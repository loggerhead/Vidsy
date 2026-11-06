import { createLogger, sanitizeLogData } from '@extension/shared';

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

const log = createLogger('download');
let diagnosticReporter: ((event: string, data: unknown) => void) | undefined;
const setDownloadDiagnosticReporter = (report: NonNullable<typeof diagnosticReporter>) => {
  diagnosticReporter = report;
};
const flowLog = (event: string, data?: unknown): void => {
  log.debug(event, data);
  if (/start|done|failed|retry|fallback|plan|snapshot/.test(event)) diagnosticReporter?.(event, sanitizeLogData(data));
};

export { errorInfo, flowLog, safeUrl, setDownloadDiagnosticReporter };
