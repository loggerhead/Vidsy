import { defineContentScript } from 'wxt/utils/define-content-script';
import '../chrome-extension/public/content.css';
import { startAllContentScript } from '../pages/content/src/matches/all/index';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*', '<all_urls>'],
  allFrames: true,
  cssInjectionMode: 'manifest',
  main() {
    startAllContentScript();
  },
});
