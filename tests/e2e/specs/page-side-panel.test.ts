import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension side panel', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens successfully', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('side-panel.html'));
      expect(await page.title()).toBe('Side Panel');
      await page.locator('#app-container > *').waitFor();
      await aiAssert(agent, 'The Vidsy side panel has loaded');
    }));
});
