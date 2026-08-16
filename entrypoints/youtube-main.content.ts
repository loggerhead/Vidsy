import { defineContentScript } from 'wxt/utils/define-content-script';
import { startYouTubeMainContentScript } from '../pages/content/src/matches/youtube/main';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  globalName: false,
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-youtube-main', () => {
      stop?.();
      stop = startYouTubeMainContentScript();
    });
    window.addEventListener('vidsy:stop-youtube-main', () => {
      stop?.();
      stop = undefined;
    });
  },
});
