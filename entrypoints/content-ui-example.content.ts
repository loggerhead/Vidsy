import { defineContentScript } from 'wxt/utils/define-content-script';
import { startExampleContentUi } from '../pages/content-ui/src/matches/example/index';

export default defineContentScript({
  matches: ['https://example.com/*'],
  main() {
    startExampleContentUi();
  },
});
