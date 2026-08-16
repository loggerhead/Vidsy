import { defineContentScript } from 'wxt/utils/define-content-script';
import { startVimeoContentScript } from '../pages/content/src/matches/vimeo/index';

export default defineContentScript({
  matches: ['*://*.vimeo.com/*'],
  runAt: 'document_idle',
  main() {
    startVimeoContentScript();
  },
});
