import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = process.env.VIDSY_MEDIA_FIXTURES ?? resolve(root, '.media-test/fixtures');
const outputs = process.env.VIDSY_MEDIA_SMOKE ?? resolve(root, '.media-test/outputs');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0)
    throw new Error(`${command} failed. Install ffmpeg and ffprobe, then rerun the test command.`);
};
if (!existsSync(resolve(fixtures, 'audio-source.wav')))
  run('bash', [resolve(root, 'tools/media-remux/generate-fixtures.sh'), fixtures]);
mkdirSync(outputs, { recursive: true });
const convert = (source, name, options) => {
  const destination = resolve(outputs, name);
  if (!existsSync(destination))
    run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      resolve(fixtures, source),
      ...options,
      destination,
    ]);
};
convert('hls-ts-hevc.ts', 'hevc-web-media-remux.mp4', ['-c', 'copy', '-tag:v', 'hvc1']);
// Container-validator fixture; actual DASH execution is exercised by browser tests.
const dashTracks = ['0', '1'].map(id => {
  const destination = resolve(outputs, `dash-track-${id}.mp4`);
  if (!existsSync(destination))
    writeFileSync(
      destination,
      Buffer.concat(
        [
          `init-stream${id}.m4s`,
          ...readdirSync(resolve(fixtures, 'dash'))
            .filter(name => name.startsWith(`chunk-stream${id}-`))
            .sort(),
        ].map(name => readFileSync(resolve(fixtures, 'dash', name))),
      ),
    );
  return destination;
});
if (!existsSync(resolve(outputs, 'matrix-dash-fixed.mp4')))
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    dashTracks[0],
    '-i',
    dashTracks[1],
    '-c',
    'copy',
    resolve(outputs, 'matrix-dash-fixed.mp4'),
  ]);
convert('vp9-opus.webm', 'matrix-vp9.webm', ['-c', 'copy']);
convert('separate-audio.m4a', 'matrix-audio.mp3', ['-c:a', 'libmp3lame', '-q:a', '2']);
const fmp4 = resolve(outputs, 'matrix-hls-fmp4.mp4');
if (!existsSync(fmp4))
  writeFileSync(
    fmp4,
    Buffer.concat(
      ['init.mp4', 'segment-00.m4s', 'segment-01.m4s'].map(name => readFileSync(resolve(fixtures, 'hls-fmp4', name))),
    ),
  );
console.log(
  'Prepared deterministic media inputs and container-validation fixtures. These are not evidence of browser/libav acceptance.',
);
