import { aiAssert } from './browser.js';
import { expect } from 'vitest';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import type { Page } from 'playwright';

const canSwitchTheme = async (page: Page, agent: PlaywrightAgent) => {
  const app = page.locator('.App');
  const button = page.getByRole('button', { name: 'Toggle theme' });
  await app.waitFor();
  await button.waitFor();
  const initialClasses = (await app.getAttribute('class')) ?? '';
  const initial = initialClasses.includes('bg-slate-50') ? 'bg-slate-50' : 'bg-gray-800';
  const next = initial === 'bg-slate-50' ? 'bg-gray-800' : 'bg-slate-50';

  if (process.env.VIDSY_E2E_AI === 'off') await button.click();
  else await agent.aiTap('the Toggle theme button');
  await expect.poll(() => app.getAttribute('class')).toContain(next);
  await aiAssert(agent, 'The page theme changed after clicking Toggle theme');

  if (process.env.VIDSY_E2E_AI === 'off') await button.click();
  else await agent.aiTap('the Toggle theme button');
  await expect.poll(() => app.getAttribute('class')).toContain(initial);
};

export { canSwitchTheme };
