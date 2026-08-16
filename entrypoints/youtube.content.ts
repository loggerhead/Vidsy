import { defineContentScript } from 'wxt/utils/define-content-script';
import { startYouTubeContentScript } from '../pages/content/src/matches/youtube/index';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-youtube', () => {
      stop?.();
      stop = startYouTubeContentScript();
    });
    window.addEventListener('vidsy:stop-youtube', () => {
      stop?.();
      stop = undefined;
    });
  },
});
