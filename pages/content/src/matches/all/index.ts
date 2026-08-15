import { initMediaDetector } from './media-detector';
import { initDeclaredMediaPresentationDetector } from './media-presentations';
import { initPicker } from './picker';

console.log('[CEB] All content script loaded');

initMediaDetector();
initDeclaredMediaPresentationDetector();
initPicker();
