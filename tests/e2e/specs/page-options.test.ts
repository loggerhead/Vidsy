import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension options', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens successfully', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('options.html'));
      expect(await page.title()).toBe('Options');
      await page.locator('#app-container > *').waitFor();
      await aiAssert(agent, 'The extension options page has loaded');
    }));
});
