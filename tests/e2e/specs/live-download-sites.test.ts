import { aiAssert, extensionWorker, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type SiteCase = { name: string; url: string; requiresLogin?: boolean };

const sites: SiteCase[] = [
  { name: 'Bilibili', url: 'https://www.bilibili.com/video/BV1j5nj68E48', requiresLogin: true },
  { name: 'X', url: 'https://x.com/HiTw93/status/2101676087222964545', requiresLogin: true },
  { name: 'AcFun', url: 'https://www.acfun.cn/v/ac48903653' },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=SiKWVMUcGiE' },
];
const downloadDirectory = process.env.VIDSY_E2E_DOWNLOAD_DIR
  ? resolve(import.meta.dirname, '../../..', process.env.VIDSY_E2E_DOWNLOAD_DIR)
  : undefined;
const enabled = process.env.VIDSY_LIVE_DOWNLOAD_E2E === 'true' && Boolean(downloadDirectory);
const minimumBytes = 1024 * 1024;

const completedFiles = async () =>
  (await readdir(downloadDirectory!, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.endsWith('.crdownload'))
    .map(entry => entry.name);

const waitForCompletedFile = async (before: string[]) => {
  let result: string | undefined;
  await expect
    .poll(
      async () => {
        const previous = new Set(before);
        const candidate = (await completedFiles()).find(file => !previous.has(file));
        if (!candidate) return false;
        result = candidate;
        return true;
      },
      { timeout: 15 * 60_000, interval: 1000 },
    )
    .toBe(true);
  return result!;
};

describe.skipIf(!enabled)('Live media downloads', () => {
  beforeAll(async () => {
    await mkdir(downloadDirectory!, { recursive: true });
    await startBrowser();
  });
  afterAll(stopBrowser);

  for (const site of sites) {
    it.skipIf(
      Boolean(
        site.requiresLogin &&
          !(site.name === 'X' && process.env.VIDSY_E2E_X_COOKIES_FILE) &&
          !process.env.VIDSY_E2E_PROFILE_DIR,
      ),
    )(
      `${site.name} downloads a file of at least 1 MB`,
      async () =>
        withPage(async (page, agent) => {
          const before = await completedFiles();
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          await page.goto(site.url, { waitUntil: 'domcontentloaded' });
          if (site.name === 'Bilibili') {
            const video = page.locator('video').first();
            await video.waitFor();
            await video.evaluate(element => {
              const media = element as HTMLVideoElement;
              media.pause();
              media.currentTime = 0;
            });
          }
          if (site.name === 'X') {
            const video = page.locator('video').first();
            await video.waitFor();
            await video.scrollIntoViewIfNeeded();
          }
          const content = page.locator('#CEB-extension-all');
          const compactButton = content.locator('button[aria-label="Show download options"]');
          try {
            await compactButton.waitFor({ timeout: Number(process.env.VIDSY_E2E_CONTROL_TIMEOUT_MS ?? 120_000) });
          } catch (error) {
            const pageState = await page.evaluate(() => ({
              url: location.href,
              title: document.title,
              text: document.body?.innerText.slice(0, 800),
              contentHostPresent: Boolean(document.querySelector('#CEB-extension-all')),
              extensionButtons: Array.from(
                document.querySelector('#CEB-extension-all')?.shadowRoot?.querySelectorAll('button') ?? [],
                button => button.getAttribute('aria-label') ?? button.textContent?.trim(),
              ).slice(0, 20),
              videos: Array.from(document.querySelectorAll('video'), video => ({
                width: video.offsetWidth,
                height: video.offsetHeight,
                currentSrc: video.currentSrc.slice(0, 100),
                poster: video.poster.slice(0, 100),
              })).slice(0, 8),
            }));
            const detectedItems = await extensionWorker().evaluate(async () => {
              const state = (await chrome.storage.session.get('media-detections'))['media-detections'] ?? {};
              return (Object.values(state).flat() as { kind: string; source: string; pageUrl?: string }[]).map(
                item => ({
                  kind: item.kind,
                  source: item.source,
                  pageUrl: item.pageUrl,
                }),
              );
            });
            throw new Error(
              `${site.name} download control unavailable: ${JSON.stringify({ ...pageState, detectedItems })}; ${String(error)}`,
            );
          }
          if (process.env.VIDSY_E2E_AI === 'off') await compactButton.click();
          else await agent.aiTap('the Vidsy Show download options button');

          const x1080pChoice = content.getByRole('radio', { name: /^1080p,/ }).first();
          if (site.name === 'X' && (await x1080pChoice.count())) await x1080pChoice.check();
          const downloadButton = content.getByRole('button', { name: /^Download (?:\d+p|video)$/ });
          await downloadButton.waitFor();
          await aiAssert(agent, 'The Vidsy download menu is open with a video quality choice');
          if (process.env.VIDSY_E2E_AI === 'off') await downloadButton.click();
          else await agent.aiTap('the primary Download button at the bottom of the Vidsy menu');

          const downloaded = await waitForCompletedFile(before);
          const filePath = join(downloadDirectory!, downloaded);
          try {
            expect((await stat(filePath)).size).toBeGreaterThanOrEqual(minimumBytes);
          } finally {
            if (process.env.VIDSY_KEEP_E2E_ARTIFACTS !== '1') await unlink(filePath);
          }
        }),
      20 * 60_000,
    );
  }
});
