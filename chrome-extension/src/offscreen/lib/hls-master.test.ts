import { fetchResolvedHlsPlaylist } from './hls-request';
import { parseHlsMaster } from './m3u8-parser';
import assert from 'node:assert/strict';
import test from 'node:test';

const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="Alternate",AUTOSELECT=YES,URI="audio-alt.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="Default",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="Low",URI="audio-low.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.640032,mp4a.40.2",AUDIO="high"
video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=480x270,AUDIO="low"
low.m3u8
`;
const base = 'https://cdn.example/master.m3u8';

test('master pairs each quality with its declared audio group and owns all renditions', () => {
  const result = parseHlsMaster(master, base);
  assert.equal(result.variants[0].audioUrl, 'https://cdn.example/audio.m3u8');
  assert.equal(result.variants[1].audioUrl, 'https://cdn.example/audio-low.m3u8');
  assert.equal(result.variants[0].codecs, 'avc1.640032,mp4a.40.2');
  assert.equal(result.childUrls.length, 5);
  assert.ok(result.childUrls.includes('https://cdn.example/audio-alt.m3u8'));
});

test('in-band audio and combined playlists require no separate input', () => {
  const parsed = parseHlsMaster(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Inband"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8',
    base,
  );
  assert.equal(parsed.variants[0].audioUrl, undefined);
  assert.deepEqual(parseHlsMaster('#EXTM3U\n#EXTINF:1,\ns.ts', base).variants, []);
});

test('download resolution retains and authorizes the paired audio playlist', async () => {
  const authorized: string[] = [];
  const result = await fetchResolvedHlsPlaylist(base, undefined, {
    authorizeUrl: async url => {
      authorized.push(url);
    },
    fetchImpl: async input => new Response(String(input) === base ? master : '#EXTM3U\n#EXTINF:1,\nsegment.m4s'),
  });
  assert.equal(result.url, 'https://cdn.example/video.m3u8');
  assert.equal(result.audio?.url, 'https://cdn.example/audio.m3u8');
  assert.deepEqual(authorized, [base, result.url, result.audio?.url]);
});

test('missing external audio fails resolution instead of delivering a silent video', async () => {
  await assert.rejects(
    fetchResolvedHlsPlaylist(base, undefined, {
      fetchImpl: async input =>
        String(input).endsWith('/audio.m3u8')
          ? new Response('', { status: 404 })
          : new Response(String(input) === base ? master : '#EXTM3U\n#EXTINF:1,\ns.ts'),
    }),
    /404/,
  );
});
