import { aiAssert, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Example page', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('loads', async () =>
    withPage(async (page, agent) => {
      await page.goto('https://www.example.com');
      expect(await page.title()).toBe('Example Domain');
      await aiAssert(agent, 'The Example Domain page is visible');
    }));
});
