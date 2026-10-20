import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { canSwitchTheme } from '../helpers/theme.js';
import { beforeAll, afterAll, describe, it } from 'vitest';

describe('Extension new tab page', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens and switches theme', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('new-tab.html'));
      await page.locator('.App').waitFor();
      await aiAssert(agent, 'The extension new tab page has loaded');
      await canSwitchTheme(page, agent);
    }));
});
