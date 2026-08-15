import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

type SiteCase = { name: string; url: string };

const cases: SiteCase[] = [
  {
    name: 'Bilibili',
    url: 'https://www.bilibili.com/video/BV1HnM269EV7/?spm_id_from=333.1007.tianma.1-3-3.click&vd_source=94e84eeb9c84c0082db21db3c32160ff',
  },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=SiKWVMUcGiE' },
  { name: 'AcFun', url: 'https://www.acfun.cn/v/ac48766652' },
  { name: 'MissAV', url: 'https://missav.ws/en/midv-999-english-subtitle' },
];

const downloadDirectory = process.env.VIDSY_E2E_DOWNLOAD_DIR;
const enabled = process.env.VIDSY_LIVE_DOWNLOAD_E2E === 'true' && !!downloadDirectory;
const minimumBytes = 1024 * 1024;

const files = async () =>
  (await readdir(downloadDirectory!, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.endsWith('.crdownload'))
    .map(entry => entry.name);

const waitForCompletedFile = async (before: string[]) => {
  let candidate: string | undefined;
  await browser.waitUntil(
    async () => {
      const known = new Set(before);
      const current = await files();
      candidate = current.find(file => !known.has(file));
      if (!candidate) return false;
      const info = await stat(join(downloadDirectory!, candidate));
      return info.size > minimumBytes;
    },
    { timeout: 15 * 60 * 1000, interval: 1000, timeoutMsg: 'No completed download larger than 1 MB appeared' },
  );
  return candidate!;
};

describe('Live media downloads', function () {
  before(function () {
    if (!enabled || (browser.capabilities as WebdriverIO.Capabilities).browserName !== 'chrome') this.skip();
  });

  for (const site of cases) {
    it(`${site.name} downloads one file larger than 1 MB`, async function () {
      this.timeout(20 * 60 * 1000);
      const before = await files();
      await browser.url(site.url);
      try {
        await browser.waitUntil(
          async () =>
            browser.execute(() => {
              const host = document.querySelector('#CEB-extension-all');
              return Array.from(host?.shadowRoot?.querySelectorAll('button') ?? []).some(button =>
                button.textContent?.includes('Download'),
              );
            }),
          { timeout: 120000, interval: 1000, timeoutMsg: 'No Download button found in content UI shadow root' },
        );
      } catch (error) {
        const diagnostic = await browser.execute(() => ({
          url: location.href,
          title: document.title,
          text: (document.body?.innerText ?? '').slice(0, 2000),
          buttons: Array.from(document.querySelectorAll('button'))
            .map(button => button.innerText)
            .slice(0, 30),
        }));
        throw new Error(`${site.name} download control unavailable: ${JSON.stringify(diagnostic)}; ${String(error)}`);
      }
      const clicked = await browser.execute(() => {
        const host = document.querySelector('#CEB-extension-all');
        const button = Array.from(host?.shadowRoot?.querySelectorAll('button') ?? []).find(element =>
          element.textContent?.includes('Download'),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      expect(clicked).toBe(true);
      const downloaded = await waitForCompletedFile(before);
      const info = await stat(join(downloadDirectory!, downloaded));
      expect(info.size).toBeGreaterThan(minimumBytes);

      // Keep the opt-in suite repeatable without deleting user files outside
      // the explicitly configured test directory.
      await unlink(join(downloadDirectory!, downloaded));
    });
  }
});
