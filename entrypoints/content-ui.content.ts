import { defineContentScript } from 'wxt/utils/define-content-script';
import { startAllContentUi } from '../pages/content-ui/src/matches/all/index';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*', '<all_urls>'],
  allFrames: true,
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-content-ui', () => {
      stop?.();
      stop = startAllContentUi();
    });
    window.addEventListener('vidsy:stop-content-ui', () => {
      stop?.();
      stop = undefined;
    });
  },
});
