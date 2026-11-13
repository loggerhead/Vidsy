import { aiAssert, extensionUrl, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension options', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens successfully', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('options.html'));
      expect(await page.title()).toBe('UUGet — Settings');
      await page.locator('#app-container > *').waitFor();
      await page.getByRole('button', { name: 'About', exact: true }).click();
      await page.getByRole('heading', { name: 'UUGet', exact: true }).waitFor();
      expect(await page.getByRole('link', { name: 'uu0uu.com', exact: true }).getAttribute('href')).toBe(
        'https://uu0uu.com',
      );
      expect(await page.getByText('UUGet v1.1.0', { exact: true }).count()).toBe(1);
      await page.locator('#app-container').screenshot({ path: '/tmp/uuget-about.png' });
      await aiAssert(agent, 'The extension options page has loaded');
    }));
});
