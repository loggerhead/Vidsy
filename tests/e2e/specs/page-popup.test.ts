import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension popup', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens successfully', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('popup.html'));
      expect(await page.title()).toBe('Popup');
      await page.locator('#app-container > *').waitFor();
      await aiAssert(agent, 'The Vidsy popup has loaded and its controls are visible');
    }));
});
