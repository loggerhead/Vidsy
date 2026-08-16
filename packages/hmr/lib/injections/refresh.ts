import initClient from '../initializers/init-client.js';

(() => {
  initClient({
    // @ts-expect-error That's because of the dynamic code loading
    id: __HMR_ID,
    onUpdate: () => {
      // Refresh only the tab being worked on. A hidden tab deliberately keeps
      // its existing page and HMR connection; it must not refresh merely
      // because the user visits it later.
      const isTestTab = navigator.webdriver;
      if (document.hidden && !isTestTab) return false;
      window.location.reload();
      return true;
    },
  });
})();
