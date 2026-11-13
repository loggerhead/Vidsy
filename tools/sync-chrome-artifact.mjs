import { log } from 'node:console';
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const source = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
const destination = join(homedir(), 'Downloads', 'UUGet');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string') {
  throw new Error('Build a Chrome MV3 artifact before syncing it to Downloads.');
}

const statIfExists = async path => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const syncDirectory = async (from, to) => {
  const existing = await statIfExists(to);
  if (existing && !existing.isDirectory()) await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const input = join(from, entry.name);
    const output = join(to, entry.name);
    if (entry.isDirectory()) {
      await syncDirectory(input, output);
    } else if (entry.isFile()) {
      const previous = await statIfExists(output);
      if (previous && !previous.isFile()) await rm(output, { recursive: true, force: true });
      await copyFile(input, output);
    } else {
      throw new Error(`Unexpected artifact entry: ${input}`);
    }
  }
  const names = new Set(entries.map(entry => entry.name));
  for (const name of await readdir(to)) {
    if (!names.has(name)) await rm(join(to, name), { recursive: true, force: true });
  }
};

await syncDirectory(source, destination);
log(`Updated ${destination} (version ${manifest.version})`);
