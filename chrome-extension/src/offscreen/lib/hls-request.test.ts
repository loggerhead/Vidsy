import { fetchResolvedHlsPlaylist, headersForFetch } from './hls-request';
import assert from 'node:assert/strict';
import test from 'node:test';

test('headersForFetch excludes browser-controlled headers case-insensitively', () => {
  assert.deepEqual(
    headersForFetch({
      Accept: 'application/vnd.apple.mpegurl',
      Authorization: 'Bearer token',
      Cookie: 'session=secret',
      Origin: 'https://example.com',
      Referer: 'https://example.com/watch',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': 'Captured browser user agent',
    }),
    {
      Accept: 'application/vnd.apple.mpegurl',
      Authorization: 'Bearer token',
      'User-Agent': 'Captured browser user agent',
    },
  );
});

test('fetchResolvedHlsPlaylist preserves headers and authorizes a cross-origin variant before fetching it', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const authorizedUrls: string[] = [];
  const headers = {
    Accept: 'application/vnd.apple.mpegurl',
    'User-Agent': 'Captured browser user agent',
    Referer: 'https://example.com/watch',
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === 'https://master.example/video.m3u8?token=one') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://cdn.example/high.m3u8?token=two');
    }
    if (url === 'https://cdn.example/high.m3u8?token=two') {
      return new Response('#EXTM3U\n#EXTINF:5,\nsegment.ts');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const resolved = await fetchResolvedHlsPlaylist('https://master.example/video.m3u8?token=one', headers, {
    fetchImpl,
    authorizeUrl: async url => {
      authorizedUrls.push(url);
    },
  });

  assert.equal(resolved.url, 'https://cdn.example/high.m3u8?token=two');
  assert.deepEqual(authorizedUrls, [
    'https://master.example/video.m3u8?token=one',
    'https://cdn.example/high.m3u8?token=two',
  ]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.init?.credentials, 'include');
    assert.deepEqual(request.init?.headers, {
      Accept: 'application/vnd.apple.mpegurl',
      'User-Agent': 'Captured browser user agent',
    });
  }
});

test('fetchResolvedHlsPlaylist propagates representative HTTP failures before parsing', async () => {
  for (const status of [401, 403, 404, 416, 500, 503]) {
    await assert.rejects(
      fetchResolvedHlsPlaylist('https://fixture.invalid/playlist.m3u8', undefined, {
        fetchImpl: async () => new Response('', { status }),
      }),
      new RegExp(`HLS playlist: ${status}`),
    );
  }
});

test('fetchResolvedHlsPlaylist rejects DRM before descriptor planning', async () => {
  await assert.rejects(
    fetchResolvedHlsPlaylist('https://fixture.invalid/playlist.m3u8', undefined, {
      fetchImpl: async () =>
        new Response(
          '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.widevine.alpha",URI="data:text/plain,key"\n',
        ),
    }),
    /DRM-protected/,
  );
});
