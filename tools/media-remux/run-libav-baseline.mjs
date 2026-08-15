import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const libavDirectory = path.join(repositoryRoot, 'chrome-extension/public/libav');

const fixturePath = path.resolve(process.argv[2] ?? '');
const outputPath = path.resolve(process.argv[3] ?? '');
const variant = process.argv[4] ?? 'h264-aac-mp3-cli';

if (!process.argv[2] || !process.argv[3]) {
  console.error('Usage: node run-libav-baseline.mjs <input> <output> [variant]');
  process.exit(2);
}

const wrapperPath = path.join(libavDirectory, `libav-6.8.8.0-${variant}.mjs`);
const wrapperModule = await import(pathToFileURL(wrapperPath).href);
const wrapper = wrapperModule.default;

const initializationStarted = performance.now();
const libav = await wrapper.LibAV({
  noworker: true,
  nothreads: true,
  base: pathToFileURL(libavDirectory).href,
  variant,
});
const initializationMilliseconds = performance.now() - initializationStarted;

const inputName = path.basename(fixturePath);
const outputName = path.basename(outputPath);
await libav.writeFile(inputName, new Uint8Array(await readFile(fixturePath)));

const videoTagArguments = inputName.includes('hevc') ? ['-tag:v', 'hvc1'] : [];
const muxStarted = performance.now();
let exitCode;
let thrown;

try {
  exitCode = await libav.ffmpeg(
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputName,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    ...videoTagArguments,
    '-y',
    outputName,
  );
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}

const muxMilliseconds = performance.now() - muxStarted;
let output = new Uint8Array();

try {
  output = await libav.readFile(outputName);
} catch {
  // A failed command may not create an output in MEMFS.
}

await writeFile(outputPath, output);
console.log(
  JSON.stringify(
    {
      fixturePath,
      outputPath,
      variant,
      initializationMilliseconds,
      muxMilliseconds,
      exitCode,
      thrown,
      outputBytes: output.byteLength,
    },
    null,
    2,
  ),
);

process.exitCode = exitCode === 0 && output.byteLength > 0 ? 0 : 1;
