import { defineContentScript } from 'wxt/utils/define-content-script';
import { startExampleContentScript } from '../pages/content/src/matches/example/index';

export default defineContentScript({
  matches: ['https://example.com/*'],
  main() {
    startExampleContentScript();
  },
});
