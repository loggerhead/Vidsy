import { extensionWorker, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MediaDownloadProgress } from '../../../packages/shared/lib/utils/media.js';

const pageUrl = 'https://vidsy.test/download-hover';
const itemId = 'download-hover-video';
const setProgress = async (progress: Partial<MediaDownloadProgress>) =>
  extensionWorker().evaluate(
    async ({ progress, pageUrl, itemId }) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      if (!tab?.id) throw new Error('Fixture tab missing');
      const item = {
        id: itemId,
        tabId: tab.id,
        url: 'https://media.invalid/video.mp4',
        kind: 'video',
        source: 'element',
        detectedAt: 1,
        pageUrl,
        title: 'Hover fixture',
        variants: [{ url: 'https://media.invalid/video.mp4', mimeType: 'video/mp4' }],
      };
      await chrome.storage.session.set({
        'media-detections': { [tab.id]: [item] },
        'media-downloads': {
          'hover-task': {
            key: 'hover-task',
            item,
            downloadedBytes: 96,
            estimatedBytes: 100,
            startedAt: 1,
            updatedAt: Date.now(),
            ...progress,
          },
        },
      });
    },
    { progress, pageUrl, itemId },
  );

describe('Player download hover details', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('shows persisted failure reasons on hover and keyboard focus', async () =>
    withPage(async page => {
      await page.route('https://vidsy.test/**', route =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><style>body{margin:0;background:#202027}video{display:block;margin:60px 40px;width:600px;height:360px;background:#303544}</style><video></video><button id="outside">Outside</button>',
        }),
      );
      await page.setViewportSize({ width: 900, height: 600 });
      await page.goto(pageUrl);
      const host = page.locator('#CEB-extension-all');
      await host.waitFor({ state: 'attached' });
      await setProgress({
        stage: 'failed',
        error: 'Failed to fetch HLS playlist: 403. Refresh the video page and retry.',
      });
      const trigger = host.getByRole('button', { name: 'Show download options', exact: true });
      await trigger.hover();
      const tooltip = host.getByRole('tooltip');
      await expect.poll(() => tooltip.innerText()).toContain('Permission denied (403)');
      expect(await tooltip.innerText()).toContain('Failed to fetch HLS playlist: 403');
      expect(await trigger.getAttribute('aria-describedby')).toBe(await tooltip.getAttribute('id'));
      await tooltip.hover();
      await expect.poll(() => tooltip.isVisible()).toBe(true);
      const artifacts = resolve(import.meta.dirname, '../../../.e2e-artifacts/download-hover');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, 'failed.png') });
      await page.mouse.move(5, 5);
      await expect.poll(() => tooltip.count()).toBe(0);
      await trigger.focus();
      await expect.poll(() => tooltip.isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      expect(await tooltip.count()).toBe(0);
      await page.locator('#outside').click();
      await setProgress({ stage: 'failed', error: 'Media processing stalled: no output for 120 seconds' });
      await trigger.hover();
      await expect.poll(() => tooltip.innerText()).toContain('Video processing');
      expect(await tooltip.innerText()).toContain('no output for 120 seconds');
      await setProgress({ stage: 'failed', error: 'Failed to fetch https://cdn.test/video?token=secret' });
      await expect.poll(() => tooltip.innerText()).toContain('Network problem');
      expect(await tooltip.innerText()).not.toContain('secret');
    }));

  it('shows current download activity and keeps details inside a small viewport', async () =>
    withPage(async page => {
      await page.setViewportSize({ width: 390, height: 300 });
      await page.locator('video').evaluate(video => {
        video.style.margin = '120px 0 0';
        video.style.width = '300px';
        video.style.height = '160px';
      });
      await setProgress({
        stage: 'download-video',
        downloadedBytes: 1024 * 1024,
        estimatedBytes: 2 * 1024 * 1024,
        completedParts: 9,
        totalParts: 10,
        activity: 'retrying',
      });
      const host = page.locator('#CEB-extension-all');
      const trigger = host.getByRole('button', { name: 'Show download progress', exact: true });
      await trigger.hover();
      const tooltip = host.getByRole('tooltip');
      await expect.poll(() => tooltip.innerText()).toContain('Retrying download');
      expect(await tooltip.innerText()).toContain('Completed parts: 9 / 10');
      await expect
        .poll(async () => {
          const box = await tooltip.boundingBox();
          return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 300;
        })
        .toBe(true);
      await trigger.click();
      expect(await tooltip.isVisible()).toBe(true);
      await setProgress({ stage: 'mux', activity: 'waiting-mux' });
      await expect.poll(() => tooltip.innerText()).toContain('Waiting to merge');
    }));
});
