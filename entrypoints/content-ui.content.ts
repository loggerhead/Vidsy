import { defineContentScript } from 'wxt/utils/define-content-script';
import { startAllContentUi } from '../pages/content-ui/src/matches/all/index';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*', '<all_urls>'],
  allFrames: true,
  main() {
    startAllContentUi();
  },
});
