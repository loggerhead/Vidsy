import { config as baseConfig } from './wdio.conf.js';
import { getChromeExtensionPath, getFirefoxExtensionPath } from '../utils/extension-path.js';
import { IS_CI, IS_FIREFOX } from '@extension/env';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const extName = IS_FIREFOX ? '.xpi' : '.zip';
const extensions = await readdir(join(import.meta.dirname, '../../../.output'));
const latestExtension = extensions
  .filter(file => extname(file) === extName && file.includes(`-${IS_FIREFOX ? 'firefox' : 'chrome'}`))
  .sort()
  .at(-1);
if (!latestExtension) throw new Error(`No WXT ${IS_FIREFOX ? 'Firefox' : 'Chrome'} zip found in .output; run pnpm zip first.`);
const extPath = join(import.meta.dirname, `../../../.output/${latestExtension}`);
const bundledExtension = (await readFile(extPath)).toString('base64');
const downloadDirectory = resolve(
  process.env.VIDSY_E2E_DOWNLOAD_DIR ?? join(import.meta.dirname, '../../../.e2e-downloads'),
);

const chromeCapabilities = {
  browserName: 'chrome',
  pageLoadStrategy: 'eager' as const,
  acceptInsecureCerts: true,
  'goog:chromeOptions': {
    ...(process.env.VIDSY_E2E_CHROME_BINARY ? { binary: process.env.VIDSY_E2E_CHROME_BINARY } : {}),
    args: [
      '--disable-web-security',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(IS_CI ? ['--headless'] : []),
    ],
    prefs: {
      'extensions.ui.developer_mode': true,
      'download.default_directory': downloadDirectory,
      'download.prompt_for_download': false,
      'download.directory_upgrade': true,
      'safebrowsing.enabled': true,
    },
    extensions: [bundledExtension],
  },
};

const firefoxCapabilities = {
  browserName: 'firefox',
  acceptInsecureCerts: true,
  'moz:firefoxOptions': {
    args: [...(IS_CI ? ['--headless'] : [])],
  },
};

export const config: WebdriverIO.Config = {
  ...baseConfig,
  mochaOpts: {
    ...baseConfig.mochaOpts,
    timeout: process.env.VIDSY_LIVE_DOWNLOAD_E2E === 'true' ? 20 * 60 * 1000 : baseConfig.mochaOpts?.timeout,
  },
  capabilities: IS_FIREFOX ? [firefoxCapabilities] : [chromeCapabilities],

  maxInstances: IS_CI ? 10 : 1,
  logLevel: 'error',
  execArgv: IS_CI ? [] : ['--inspect'],
  before: async ({ browserName }: WebdriverIO.Capabilities, _specs, browser: WebdriverIO.Browser) => {
    if (browserName === 'firefox') {
      await browser.installAddOn(bundledExtension, true);

      browser.addCommand('getExtensionPath', async () => getFirefoxExtensionPath(browser));
    } else if (browserName === 'chrome') {
      browser.addCommand('getExtensionPath', async () => getChromeExtensionPath(browser));
    }
  },
  afterTest: async () => {
    if (!IS_CI) {
      await browser.pause(500);
    }
  },
};
