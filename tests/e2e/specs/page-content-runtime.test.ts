import { extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension content runtime', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('keeps content scripts off extension pages', async () =>
    withPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      await page.locator('#app-container > *').waitFor();
      expect(await page.locator('#CEB-extension-runtime-all, #CEB-extension-runtime-example').count()).toBe(0);
      expect(await page.locator('#CEB-extension-all, #CEB-extension-example').count()).toBe(0);
    }));
});
