import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { canSwitchTheme } from '../helpers/theme.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension DevTools panel', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens and switches theme', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('devtools-panel.html'));
      expect(await page.title()).toBe('Devtools Panel');
      await aiAssert(agent, 'The extension DevTools panel has loaded');
      await canSwitchTheme(page, agent);
    }));
});
