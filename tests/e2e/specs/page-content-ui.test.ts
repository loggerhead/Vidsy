import { aiAssert, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Content UI injection', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('injects all and example UI on example.com', async () =>
    withPage(async (page, agent) => {
      await page.goto('https://example.com');
      await page.locator('#CEB-extension-all').waitFor({ state: 'attached' });
      await page.locator('#CEB-extension-example').waitFor();
      await aiAssert(agent, 'The example web page is visible with the Vidsy content UI');
    }));

  it('injects only the all-sites UI on other sites', async () =>
    withPage(async (page, agent) => {
      await page.route('http://example.com/**', route =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Other site fixture</title><main>Other site</main>',
        }),
      );
      await page.goto('http://example.com/');
      await page.locator('#CEB-extension-all').waitFor({ state: 'attached' });
      expect(await page.locator('#CEB-extension-example').count()).toBe(0);
      await aiAssert(agent, 'The web page is visible with the Vidsy content UI');
    }));
});
