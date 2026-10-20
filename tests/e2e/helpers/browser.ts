import { PlaywrightAgent } from '@midscene/web/playwright';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { BrowserContext, Page, Worker } from 'playwright';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const extensionDirectory = resolve(repositoryRoot, process.env.VIDSY_EXTENSION_DIR ?? '.output/chrome-mv3');
const downloadDirectory = resolve(repositoryRoot, process.env.VIDSY_E2E_DOWNLOAD_DIR ?? '.e2e-downloads');

let context: BrowserContext | undefined;
let profileDirectory: string | undefined;
let removeProfileAfterRun = false;
let extensionOrigin: string | undefined;

const importXCookies = async (browserContext: BrowserContext) => {
  const file = process.env.VIDSY_E2E_X_COOKIES_FILE;
  if (!file) return;
  let data: unknown;
  try {
    data = JSON.parse(await readFile(resolve(repositoryRoot, file), 'utf8'));
  } catch {
    throw new Error('Unable to read the local X cookie export');
  }
  if (!data || typeof data !== 'object' || !('cookieHeader' in data) || typeof data.cookieHeader !== 'string') {
    throw new Error('X cookie file must contain a cookieHeader string');
  }
  const header = data.cookieHeader.trim().replace(/^cookie:\s*/i, '');
  const imported = header.split(/;\s*/).map(pair => {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('X cookie header contains an invalid cookie');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    if (!/^[A-Za-z0-9_!.-]+$/.test(name)) throw new Error('X cookie header contains an invalid cookie name');
    return {
      name,
      value,
      domain: name.startsWith('__Host-') ? 'x.com' : '.x.com',
      path: '/',
      expires: -1,
      httpOnly: name === 'auth_token',
      secure: true,
      sameSite: 'Lax' as const,
    };
  });
  if (!imported.length) throw new Error('X cookie header is empty');
  try {
    await browserContext.addCookies(imported);
  } catch {
    throw new Error('Unable to import X cookies into the test browser');
  }
};

const startBrowser = async () => {
  removeProfileAfterRun = !process.env.VIDSY_E2E_PROFILE_DIR;
  profileDirectory = removeProfileAfterRun
    ? await mkdtemp(join(tmpdir(), 'vidsy-midscene-'))
    : resolve(repositoryRoot, process.env.VIDSY_E2E_PROFILE_DIR!);
  context = await chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    headless: process.env.VIDSY_E2E_HEADED !== 'true',
    acceptDownloads: true,
    downloadsPath: downloadDirectory,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
  });
  await importXCookies(context);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  // A worker target appears before its module has registered runtime/network
  // listeners. Wait for app readiness before a one-shot fixture request.
  const readyDeadline = Date.now() + 10_000;
  while (!(await worker.evaluate(() => chrome.runtime.onMessage.hasListeners()))) {
    if (Date.now() > readyDeadline) throw new Error('Extension background listeners did not become ready');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const stopBrowser = async () => {
  await context?.close();
  context = undefined;
  extensionOrigin = undefined;
  if (profileDirectory && removeProfileAfterRun) await rm(profileDirectory, { recursive: true, force: true });
  profileDirectory = undefined;
  removeProfileAfterRun = false;
};

const extensionUrl = (path: string) => {
  if (!extensionOrigin) throw new Error('Extension browser was not started');
  return `${extensionOrigin}/${path}`;
};

const extensionWorker = (): Worker => {
  const worker = context
    ?.serviceWorkers()
    .find(item => item.url().startsWith(extensionOrigin ?? 'chrome-extension://'));
  if (!worker) throw new Error('Extension service worker was not found');
  return worker;
};

const withPage = async (run: (page: Page, agent: PlaywrightAgent) => Promise<void>) => {
  if (!context) throw new Error('Extension browser was not started');
  const page = context.pages()[0] ?? (await context.newPage());
  await runWithAgent(page, run);
};

const withNewPage = async (run: (page: Page, agent: PlaywrightAgent) => Promise<void>) => {
  if (!context) throw new Error('Extension browser was not started');
  const page = await context.newPage();
  try {
    await runWithAgent(page, run);
  } finally {
    await page.close();
  }
};

const runWithAgent = async (page: Page, run: (page: Page, agent: PlaywrightAgent) => Promise<void>) => {
  const agent = new PlaywrightAgent(page, { forceChromeSelectRendering: false });
  try {
    await run(page, agent);
  } finally {
    await agent.destroy();
  }
};

const aiAssert = async (agent: PlaywrightAgent, assertion: string) => {
  if (process.env.VIDSY_E2E_AI === 'off') return;
  if (!process.env.MIDSCENE_MODEL_API_KEY) {
    throw new Error(
      'Set MIDSCENE_MODEL_API_KEY and model settings, or use VIDSY_E2E_AI=off for deterministic checks only',
    );
  }
  await agent.aiAssert(assertion);
};

export { aiAssert, extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage, withPage };
