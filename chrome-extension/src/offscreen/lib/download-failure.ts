export type DownloadFailureKind = 'transport' | 'processing' | 'integrity';

export class DownloadFailure extends Error {
  constructor(
    readonly kind: DownloadFailureKind,
    message: string,
    options?: ErrorOptions,
    readonly retryable?: boolean,
  ) {
    super(message, options);
    this.name = 'DownloadFailure';
  }
}

export class LiveSnapshotFailure extends DownloadFailure {
  constructor(cause: unknown) {
    super(
      'transport',
      `Live snapshot transfer failed; its partial cache was discarded. Restart downloads the current playlist; live streams cannot resume. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
      false,
    );
  }
}

export const failureKind = (error: unknown, fallback: DownloadFailureKind = 'transport'): DownloadFailureKind =>
  error instanceof DownloadFailure ? error.kind : fallback;

export const shouldDiscardInput = (error: unknown, intent?: 'pause' | 'cancel'): boolean =>
  intent === 'cancel' || failureKind(error) === 'integrity';

export const explainFailure = (error: unknown): string => {
  if (error instanceof LiveSnapshotFailure) return error.message;
  const reason = error instanceof Error ? error.message : String(error);
  switch (failureKind(error)) {
    case 'integrity':
      return `Integrity check failed; cached input was discarded. Retry will download again. ${reason}`;
    case 'processing':
      return `Media processing failed; completed inputs are retained. Retry will rerun processing. ${reason}`;
    default:
      return `Transfer failed; valid cached progress is retained. Retry will validate it before continuing. ${reason}`;
  }
};
