import { defineContentScript } from 'wxt/utils/define-content-script';
import { startVimeoContentScript } from '../pages/content/src/matches/vimeo/index';

export default defineContentScript({
  matches: ['*://*.vimeo.com/*'],
  runAt: 'document_idle',
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-vimeo', () => {
      stop?.();
      stop = startVimeoContentScript();
    });
    window.addEventListener('vidsy:stop-vimeo', () => {
      stop?.();
      stop = undefined;
    });
  },
});
