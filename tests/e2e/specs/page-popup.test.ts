import { aiAssert, extensionUrl, extensionWorker, startBrowser, stopBrowser, withPage } from '../helpers/browser.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('Extension popup', () => {
  beforeAll(startBrowser);
  afterAll(stopBrowser);

  it('opens successfully', async () =>
    withPage(async (page, agent) => {
      await page.goto(extensionUrl('popup.html'));
      expect(await page.title()).toBe('UUGet');
      await page.locator('#app-container > *').waitFor();
      await aiAssert(agent, 'The UUGet popup has loaded and its controls are visible');
    }));

  it('shows current-page media, other-page downloads, and labeled toolbar actions', async () =>
    withPage(async page => {
      await page
        .context()
        .route('https://*.example.invalid/**', route =>
          route.fulfill({ contentType: 'text/html', body: '<html><body>Media page fixture</body></html>' }),
        );
      // Keep real web tabs behind the standalone popup, which uses the same
      // active-page fallback as the browser-action popup.
      const otherPage = await page.context().newPage();
      await otherPage.goto('https://other.example.invalid/');
      const currentPage = await page.context().newPage();
      await currentPage.goto('https://current.example.invalid/');
      const tabs = await extensionWorker().evaluate(async () => {
        const allTabs = await chrome.tabs.query({});
        return {
          current: allTabs.find(tab => tab.url === 'https://current.example.invalid/')!.id!,
          other: allTabs.find(tab => tab.url === 'https://other.example.invalid/')!.id!,
        };
      });
      await page.goto(extensionUrl('popup.html'));
      await extensionWorker().evaluate(async ({ current, other }) => {
        const item = (id: string, title: string, tabId: number) => ({
          id,
          title,
          tabId,
          url: `https://media.example.invalid/${id}.mp4`,
          kind: 'video',
          source: 'network',
          detectedAt: Date.now(),
        });
        const currentMedia = item('current', 'Current detected video', current);
        const currentTask = item('current-task', 'Current paused download', current);
        const otherMedia = item('other', 'Other detected video', other);
        const otherTask = item('other-task', 'Other active download', other);
        const fixtureStorage = {
          'media-detections': {
            [current]: [currentMedia, currentTask],
            [other]: [otherMedia, otherTask],
          },
          'media-downloads': {
            currentTask: {
              key: 'currentTask',
              stage: 'paused',
              resumeCapability: 'range',
              downloadedBytes: 0,
              item: currentTask,
            },
            otherTask: {
              key: 'otherTask',
              stage: 'download-video',
              resumeCapability: 'range',
              downloadedBytes: 5000000,
              estimatedBytes: 10000000,
              item: otherTask,
            },
          },
        };
        await chrome.storage.session.set({ 'media-detections': fixtureStorage['media-detections'] });
        await chrome.storage.local.set({ 'media-downloads': fixtureStorage['media-downloads'] });
      }, tabs);
      // Reload after seeding to make the active-tab selection deterministic.
      await extensionWorker().evaluate(async id => {
        await chrome.tabs.update(id, { active: true });
      }, tabs.current);
      await page.reload();
      const current = page.getByRole('region', { name: 'Current page', exact: true });
      const other = page.getByRole('region', { name: 'Other downloads', exact: true });
      await current.getByText('Current detected video', { exact: true }).waitFor();
      await current.getByText('Current paused download', { exact: true }).waitFor();
      expect(await page.getByText('Other detected video', { exact: true }).count()).toBe(0);
      await other.getByText('Other active download', { exact: true }).waitFor();
      expect(await page.getByText('Current paused download', { exact: true }).count()).toBe(1);
      expect(await page.getByText('Other active download', { exact: true }).count()).toBe(1);
      expect(await current.getByRole('button', { name: 'Resume', exact: true }).count()).toBe(1);
      expect(await other.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(1);
      const firstBox = await current.boundingBox();
      const secondBox = await other.boundingBox();
      expect(secondBox!.y).toBeGreaterThanOrEqual(firstBox!.y + firstBox!.height);
      expect(await other.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
      for (const title of ['Downloads', 'Toggle theme', 'Side Panel', 'Options']) {
        expect(await page.locator(`button[title="${title}"]`).count()).toBe(0);
      }
      const summary = page.getByTitle('Media and downloads');
      const mediaCount = current.getByTitle('Detected media on this page');
      expect(await mediaCount.innerText()).toBe('2');
      expect(await summary.getByTitle('Detected media on this page').count()).toBe(0);
      const titleBox = await current.getByRole('heading', { name: 'Current page', exact: true }).boundingBox();
      const countBox = await mediaCount.boundingBox();
      expect(Math.abs(titleBox!.y + titleBox!.height / 2 - (countBox!.y + countBox!.height / 2))).toBeLessThan(2);
      expect(countBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
      expect(await summary.getByTitle('Active and queued downloads').innerText()).toBe('1');
      expect(await page.getByRole('button', { name: 'Pick video', exact: true }).isVisible()).toBe(true);
      await summary.click();
      await page.getByRole('button', { name: 'Add link', exact: true }).click();
      const urlInput = page.getByPlaceholder('Paste a video URL…');
      await urlInput.waitFor();
      const inputBox = await urlInput.boundingBox();
      const addLinkBox = await page.getByRole('button', { name: 'Add link', exact: true }).boundingBox();
      expect(inputBox!.y).toBeGreaterThan(400);
      expect(inputBox!.y + inputBox!.height).toBeLessThan(addLinkBox!.y);
      await page.locator('#app-container').screenshot({ path: '/tmp/vidsy-popup-add-link.png' });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('#app-container').screenshot({ path: '/tmp/vidsy-merged-popup.png' });
      expect(await page.getByRole('button', { name: 'Clear page', exact: true }).count()).toBe(0);
      const summaryBox = await summary.boundingBox();
      const pickBox = await page.getByRole('button', { name: 'Pick video', exact: true }).boundingBox();
      const linkBox = await page.getByRole('button', { name: 'Add link', exact: true }).boundingBox();
      expect(Math.abs(summaryBox!.y + summaryBox!.height / 2 - (pickBox!.y + pickBox!.height / 2))).toBeLessThan(2);
      expect(Math.abs(pickBox!.y - linkBox!.y)).toBeLessThan(2);
      expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(380);
      await extensionWorker().evaluate(async () => {
        await chrome.storage.session.set({ 'media-detections': {} });
        await chrome.storage.local.set({ 'media-downloads': {} });
      });
      await other.waitFor({ state: 'hidden' });
      await current.getByText('No media detected', { exact: true }).waitFor();
      expect(await page.getByText('No downloads from other pages', { exact: true }).count()).toBe(0);
      await page.locator('#app-container').screenshot({ path: '/tmp/vidsy-popup-clean.png' });
      await extensionWorker().evaluate(async ({ current, other }) => {
        await chrome.tabs.remove([current, other]);
        await chrome.storage.session.set({ 'media-detections': {} });
        await chrome.storage.local.set({ 'media-downloads': {} });
      }, tabs);
    }));
});
