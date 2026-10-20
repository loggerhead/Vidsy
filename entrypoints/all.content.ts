import { startAllContentScript } from '../pages/content/src/matches/all/index';
import { defineContentScript } from 'wxt/utils/define-content-script';
import '../chrome-extension/public/content.css';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*', '<all_urls>'],
  allFrames: true,
  cssInjectionMode: 'manifest',
  main() {
    let stop: (() => void) | undefined;
    window.addEventListener('vidsy:start-content', () => {
      stop?.();
      stop = startAllContentScript();
    });
    window.addEventListener('vidsy:stop-content', () => {
      stop?.();
      stop = undefined;
    });
    void chrome.runtime.sendMessage({ type: 'content/ready', scope: 'all' }).catch(() => undefined);
  },
});
