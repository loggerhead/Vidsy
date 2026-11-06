import { extensionWorker, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MediaDownloadProgress } from '../../../packages/shared/lib/utils/media.js';

const pageUrl = 'https://vidsy.test/download-options';
const videoId = 'download-options-fixture';

describe('Player download options', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('groups qualities, preserves selection and submits only the explicit download action', async () =>
    withPage(async page => {
      await page.route('https://vidsy.test/**', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Download options fixture</title><style>
          body{margin:0;background:#f5f5f7;font:16px Arial}main{margin:80px 40px}
          video{display:block;width:calc(100vw - 80px);height:600px;background:#303544}
          </style><main><h1>Video page</h1><video></video><button id="outside">Outside</button></main>`,
        }),
      );
      await page.setViewportSize({ width: 1327, height: 844 });
      await page.goto(pageUrl);
      await page.locator('#CEB-extension-all').waitFor({ state: 'attached' });
      await extensionWorker().evaluate(
        async ({ pageUrl, videoId }) => {
          const tab = (await chrome.tabs.query({})).find(tab => tab.url === pageUrl);
          if (!tab?.id) throw new Error('Fixture tab was not found');
          const variants = [2160, 1080, 720, 480, 360].flatMap(height =>
            ['avc1', 'av01', 'hvc1'].map((codecs, index) => ({
              url: `https://media.invalid/${height}-${codecs}.mp4`,
              resolution: { width: Math.round((height * 16) / 9), height },
              codecs,
              mimeType: 'video/mp4',
              frameRate: 30,
              contentLength: height * 10000 + index * 1024,
              audioUrl: 'https://media.invalid/audio.m4a',
              audioMimeType: 'audio/mp4',
            })),
          );
          await chrome.storage.session.set({
            'media-downloads': {},
            'media-detections': {
              [tab.id]: [
                {
                  id: videoId,
                  url: variants[0].url,
                  kind: 'video',
                  source: 'element',
                  detectedAt: Date.now(),
                  title: '打麻将很厉害的成都女孩',
                  pageUrl,
                  variants,
                  duration: 91,
                },
              ],
            },
          });
        },
        { pageUrl, videoId },
      );
      const host = page.locator('#CEB-extension-all');
      const trigger = host.getByRole('button', { name: 'Show download options', exact: true });
      await trigger.click();
      const panel = host.getByRole('dialog', { name: 'Download video' });
      await panel.waitFor();
      expect(await panel.getByRole('radio').count()).toBe(5);
      expect(await panel.getByRole('radio', { checked: true }).getAttribute('id')).toContain('1080-avc1');
      expect(await panel.innerText()).not.toContain('HTTP');
      expect(await panel.innerText()).not.toContain('Recommended');
      expect(await panel.innerText()).not.toContain('1920×1080');
      expect(await panel.innerText()).not.toContain('Before merging');
      expect(await panel.innerText()).not.toContain('Audio depends on the source');
      await page.mouse.move(20, 20);
      await page.waitForTimeout(250);
      expect(await panel.isVisible()).toBe(true);
      const groups = panel.locator('.vidsy-quality-group');
      await groups.nth(1).getByRole('button', { name: '2 other versions' }).click();
      expect(await panel.getByRole('radio').count()).toBe(7);
      await groups.nth(1).getByRole('radio', { name: /AV1/ }).check();
      expect(await panel.getByRole('radio', { checked: true }).getAttribute('id')).toContain('1080-av01');
      const jobs = () =>
        extensionWorker().evaluate(async videoId => {
          const downloads = (await chrome.storage.session.get('media-downloads'))['media-downloads'] ?? {};
          return (Object.values(downloads) as MediaDownloadProgress[]).filter(entry => entry.item?.id === videoId);
        }, videoId);
      expect(await jobs()).toHaveLength(0);
      await groups.nth(1).getByRole('button', { name: 'Hide other versions' }).click();
      expect(await panel.getByRole('radio', { checked: true }).getAttribute('id')).toContain('1080-av01');
      await page.keyboard.press('Escape');
      expect(await panel.count()).toBe(0);
      expect(
        await trigger.evaluate(
          element =>
            element.getRootNode() instanceof ShadowRoot &&
            (element.getRootNode() as ShadowRoot).activeElement === element,
        ),
      ).toBe(true);
      await trigger.click();
      await panel.getByRole('button', { name: 'Close download options' }).click();
      expect(await panel.count()).toBe(0);
      await trigger.click();
      await page.locator('#outside').click({ force: true });
      expect(await panel.count()).toBe(0);
      await trigger.click();
      const artifacts = resolve(import.meta.dirname, '../../../.e2e-artifacts/download-options');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, 'desktop.png') });
      // A short viewport and a player near the left edge must keep the entire panel visible.
      await page.setViewportSize({ width: 390, height: 460 });
      await page.locator('main').evaluate(element => {
        element.style.margin = '16px 0';
      });
      await page.locator('video').evaluate(element => {
        element.style.width = '300px';
      });
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 460;
        })
        .toBe(true);
      await page.screenshot({ path: resolve(artifacts, 'small-window.png') });
      await page.setViewportSize({ width: 1327, height: 844 });
      await groups.nth(1).getByRole('button', { name: '2 other versions' }).click();
      await groups.nth(1).getByRole('radio', { name: /AV1/ }).check();
      await panel.getByRole('button', { name: 'Download', exact: true }).click();
      await expect.poll(async () => (await jobs()).length, { timeout: 15_000 }).toBe(1);
      const [job] = await jobs();
      expect(job.item?.url).toBe('https://media.invalid/1080-av01.mp4');
      expect(job.item?.audioUrl).toBe('https://media.invalid/audio.m4a');
      expect(job.outputFormat).toBe('mp4');
    }));
});
