import console from 'node:console';
import { mkdir, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://x.com';
if (!/^https?:\/\//.test(url)) throw new Error('Pass an http(s) login or video URL');

const repositoryRoot = resolve(import.meta.dirname, '../..');
const profileDirectory = resolve(repositoryRoot, process.env.VIDSY_E2E_PROFILE_DIR ?? '.e2e-private/profile');
const extensionDirectory = resolve(repositoryRoot, process.env.VIDSY_EXTENSION_DIR ?? '.output/chrome-mv3');
await mkdir(profileDirectory, { recursive: true });

try {
  const lock = await readlink(join(profileDirectory, 'SingletonLock'));
  const pid = lock.startsWith(`${hostname()}-`) ? Number(lock.slice(hostname().length + 1)) : NaN;
  if (Number.isSafeInteger(pid) && pid > 0) {
    let active = false;
    try {
      process.kill(pid, 0);
      active = true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (active) {
      throw new Error(
        `The test profile is already open in Chromium (PID ${pid}). Close the existing e2e:login or test browser before retrying: ${profileDirectory}`,
      );
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const context = await chromium.launchPersistentContext(profileDirectory, {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const finished = new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      console.log('Closing the test browser...');
      resolve();
    });
    context.once('close', () => {
      console.log('Test browser closed.');
      resolve();
    });
  });
  console.log(
    `Complete login or verification in the opened browser, then press Enter in this terminal. Profile: ${profileDirectory}`,
  );
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
  } catch (error) {
    console.error(`Initial navigation failed. Open the login page manually in the browser: ${String(error)}`);
  }
  await finished;
} finally {
  process.stdin.pause();
  await context.close();
  console.log('Login profile saved.');
}
