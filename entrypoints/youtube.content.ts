import { defineContentScript } from 'wxt/utils/define-content-script';
import { startYouTubeContentScript } from '../pages/content/src/matches/youtube/index';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    startYouTubeContentScript();
  },
});
