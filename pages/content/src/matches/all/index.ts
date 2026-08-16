import { initMediaDetector } from './media-detector';
import { createLogger } from '@extension/shared';
import { initDeclaredMediaPresentationDetector } from './media-presentations';
import { initPicker } from './picker';

export const startAllContentScript = (): (() => void) => {
  createLogger('content-all').info('started');

  const stopMediaDetector = initMediaDetector();
  const stopPresentationDetector = initDeclaredMediaPresentationDetector();
  const stopPicker = initPicker();
  return () => {
    stopPicker();
    stopPresentationDetector();
    stopMediaDetector();
  };
};
