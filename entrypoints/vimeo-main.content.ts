import { defineContentScript } from 'wxt/utils/define-content-script';
import { startVimeoMainContentScript } from '../pages/content/src/matches/vimeo/main';

export default defineContentScript({
  matches: ['*://*.vimeo.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  globalName: false,
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-vimeo-main', () => {
      stop?.();
      stop = startVimeoMainContentScript();
    });
    window.addEventListener('vidsy:stop-vimeo-main', () => {
      stop?.();
      stop = undefined;
    });
  },
});
