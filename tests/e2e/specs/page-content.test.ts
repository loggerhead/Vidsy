import { aiAssert, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Content script lifecycle', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('mounts the all-sites content UI and removes it on stop', async () =>
    withPage(async (page, agent) => {
      await page.goto('https://example.com');
      await page.locator('#CEB-extension-all').waitFor();
      await aiAssert(agent, 'The Vidsy content UI is present on the page');
      await page.evaluate(() => window.dispatchEvent(new Event('vidsy:stop-content-ui')));
      await page.locator('#CEB-extension-all').waitFor({ state: 'detached' });
      expect(await page.locator('#CEB-extension-example').count()).toBe(1);
      await page.evaluate(() => window.dispatchEvent(new Event('vidsy:start-content-ui')));
      await page.locator('#CEB-extension-all').waitFor();
    }));
});
