// Run real FFmpeg against sparse virtual MP4s. The payload is small, while
// movie metadata lives beyond 2 GiB/4 GiB, forcing the production seek ABI.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, process.env.VIDSY_LIBAV_DIR ?? 'chrome-extension/public/libav');
const prefix = 'libav-6.8.8.0-web-media-remux-cli';
const glue = await readFile(resolve(directory, `${prefix}.wasm.mjs`), 'utf8');
const binary = await readFile(resolve(directory, `${prefix}.wasm.wasm`));
const aliases = new Map(
  ['jsfetch_open_js', 'jsfetch_seek_js', 'jsfetch_get_filesize_js'].map(name => {
    const match = glue.match(new RegExp(`([\\w$]+):${name}\\b`));
    assert.ok(match, `Missing import binding for ${name}`);
    return [match[1], name];
  }),
);

const signatures = new Map();
const types = [];
const leb = index => {
  let value = 0,
    shift = 0;
  while (true) {
    const byte = binary[index++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) return [value, index];
    shift += 7;
  }
};
const string = index => {
  const [length, start] = leb(index);
  return [binary.subarray(start, start + length).toString(), start + length];
};
for (let offset = 8; offset < binary.length; ) {
  const section = binary[offset++];
  const [length, start] = leb(offset);
  offset = start + length;
  let cursor = start;
  if (section === 1) {
    let count;
    [count, cursor] = leb(cursor);
    for (let i = 0; i < count; i++) {
      assert.equal(binary[cursor++], 0x60);
      let n;
      [n, cursor] = leb(cursor);
      const params = [...binary.subarray(cursor, cursor + n)];
      cursor += n;
      [n, cursor] = leb(cursor);
      const results = [...binary.subarray(cursor, cursor + n)];
      cursor += n;
      types.push({ params, results });
    }
  } else if (section === 2) {
    let count;
    [count, cursor] = leb(cursor);
    for (let i = 0; i < count; i++) {
      let module, name;
      [module, cursor] = string(cursor);
      [name, cursor] = string(cursor);
      const kind = binary[cursor++];
      if (kind === 0) {
        let index;
        [index, cursor] = leb(cursor);
        if (aliases.has(name)) signatures.set(aliases.get(name), types[index]);
      } else if (kind === 1 || kind === 2) {
        if (kind === 1) cursor++;
        let flags;
        [flags, cursor] = leb(cursor);
        [, cursor] = leb(cursor);
        if (flags & 1) [, cursor] = leb(cursor);
      } else if (kind === 3) cursor += 2;
      else if (kind === 4) {
        cursor++;
        [, cursor] = leb(cursor);
      } else throw new Error(`Unsupported import kind ${kind} in ${module}`);
    }
  }
}
assert.deepEqual(signatures.get('jsfetch_open_js'), { params: [0x7f, 0x7c], results: [0x7f] });
assert.deepEqual(signatures.get('jsfetch_seek_js'), { params: [0x7f, 0x7f, 0x7c], results: [0x7f] });
assert.deepEqual(signatures.get('jsfetch_get_filesize_js'), { params: [0x7f], results: [0x7c] });

// Exercise the generated JS bridge with exact large positions, including its
// response-size fallback, rather than duplicating its offset calculation.
const jsStart = glue.indexOf('function jsfetch_get_filesize_js(');
const jsEnd = glue.indexOf('function jsfetch_close_js(', jsStart);
const ranges = [];
const sandbox = {
  UTF8ToString: () => 'jsfetch:blob:fixture',
  Asyncify: { handleAsync: fn => fn() },
  AbortController: globalThis.AbortController,
  Module: { libavjsJSFetch: { ctr: 2, fetches: { 1: { filesize: 5 * 2 ** 30, reader: { cancel() {} } } } } },
  fetch: async (_url, options) => {
    ranges.push(options.headers.Range);
    return new globalThis.Response(new Uint8Array([1]), { status: 206 });
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(glue.slice(jsStart, jsEnd), sandbox);
for (const position of [2 ** 31 - 1, 2 ** 31, 3532077072, 2 ** 32, 5 * 2 ** 30 - 1]) {
  const index = await sandbox.jsfetch_seek_js(1, 0, position);
  assert.equal(ranges.at(-1), `bytes=${position}-`);
  assert.equal(sandbox.jsfetch_get_filesize_js(index), 5 * 2 ** 30);
  sandbox.Module.libavjsJSFetch.fetches[1] = sandbox.Module.libavjsJSFetch.fetches[index];
}

const fixture = await readFile(resolve(root, '.media-test/fixtures/direct.mp4'));
let moovStart = -1;
for (let offset = 0; offset < fixture.length; ) {
  let size = fixture.readUInt32BE(offset);
  if (size === 1) size = Number(fixture.readBigUInt64BE(offset + 8));
  if (fixture.toString('ascii', offset + 4, offset + 8) === 'moov') {
    moovStart = offset;
    break;
  }
  offset += size;
}
assert.ok(moovStart > 0, 'Fixture must have movie metadata after the media payload');
const head = fixture.subarray(0, moovStart),
  movie = fixture.subarray(moovStart);
let current;
const requests = [];
let servedBytes = 0;
const slice = (position, length) => {
  const bytes = Buffer.alloc(Math.min(length, current.size - position));
  for (const [start, data] of [
    [0, head],
    [moovStart, current.free],
    [current.metadataOffset, movie],
  ]) {
    const from = Math.max(position, start),
      to = Math.min(position + bytes.length, start + data.length);
    if (to > from) data.copy(bytes, from - position, from - start, to - start);
  }
  return bytes;
};
const server = createServer((request, response) => {
  const range = request.headers.range;
  const match = range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = match ? Number(match[1]) : 0;
  requests.push({ range, start });
  if ((range && !match) || start >= current.size) {
    response.writeHead(416, { 'content-range': `bytes */${current.size}` });
    response.end();
    return;
  }
  const end = match?.[2] ? Math.min(Number(match[2]), current.size - 1) : current.size - 1;
  response.writeHead(match ? 206 : 200, {
    'content-type': 'video/mp4',
    'content-length': end - start + 1,
    ...(match ? { 'content-range': `bytes ${start}-${end}/${current.size}` } : {}),
  });
  let position = start;
  const pump = () => {
    while (!response.destroyed && position <= end) {
      const bytes = slice(position, Math.min(64 * 1024, end - position + 1));
      if (servedBytes + bytes.length > 64 * 1024 * 1024) {
        response.destroy(new Error('Sparse test exceeded its transfer budget'));
        return;
      }
      position += bytes.length;
      servedBytes += bytes.length;
      if (!response.write(bytes)) {
        response.once('drain', pump);
        return;
      }
    }
    if (!response.destroyed) response.end();
  };
  pump();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const wrapper = (await import(pathToFileURL(resolve(directory, `${prefix}.mjs`)).href)).default;
const reports = [];
try {
  for (const metadataOffset of [2 ** 31 + 8192, 3532077072 + 4096, 2 ** 32 + 8192, 5 * 2 ** 30 + 4096]) {
    const free = Buffer.alloc(16);
    free.writeUInt32BE(1);
    free.write('free', 4);
    free.writeBigUInt64BE(BigInt(metadataOffset - moovStart), 8);
    current = { free, metadataOffset, size: metadataOffset + movie.length };
    requests.length = 0;
    servedBytes = 0;
    const libav = await wrapper.LibAV({
      noworker: true,
      nothreads: true,
      base: directory + '/',
      variant: 'web-media-remux-cli',
    });
    try {
      const output = 'result.mp4';
      const input = `jsfetch:http://127.0.0.1:${server.address().port}/sparse.mp4`;
      const result = await libav.ffmpeg('-hide_banner', '-loglevel', 'error', '-i', input, '-c', 'copy', '-y', output);
      assert.equal(result, 0);
      const bytes = await libav.readFile(output);
      assert.ok(bytes.length > 1000);
      assert.ok(
        requests.some(request => request.start >= metadataOffset),
        `FFmpeg did not seek to large metadata offset ${metadataOffset}`,
      );
      assert.ok(
        requests.every(request => request.start < current.size),
        'EOF must not create an unsatisfiable request',
      );
      assert.ok(servedBytes < 64 * 1024 * 1024, 'Sparse test unexpectedly streamed the padding');
      reports.push({
        virtualBytes: current.size,
        metadataOffset,
        outputBytes: bytes.length,
        servedBytes,
        ranges: requests.map(request => request.range).filter(Boolean),
      });
    } finally {
      libav.terminate();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ signatures: Object.fromEntries(signatures), cases: reports }, null, 2));
