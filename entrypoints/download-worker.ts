import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

export default defineUnlistedScript({
  globalName: false,
  main() {
    void import('../chrome-extension/src/offscreen/download_worker/main');
  },
});
