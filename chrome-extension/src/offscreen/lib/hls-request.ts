import { parseHlsMaster } from './m3u8-parser';

const BROWSER_CONTROLLED_HEADERS = new Set(['cookie', 'origin', 'referer']);

const headersForFetch = (headers?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !BROWSER_CONTROLLED_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-fetch-'),
    ),
  );

type ResolvedPlaylist = { url: string; manifestText: string; audio?: ResolvedPlaylist };

type HlsPlaylistFetchOptions = {
  fetchImpl?: typeof fetch;
  authorizeUrl?: (url: string) => Promise<void>;
};

const fetchResolvedHlsPlaylist = async (
  playlistUrl: string,
  headers?: Record<string, string>,
  options: HlsPlaylistFetchOptions = {},
): Promise<ResolvedPlaylist> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  await options.authorizeUrl?.(playlistUrl);

  const res = await fetchImpl(playlistUrl, {
    headers: headersForFetch(headers),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch HLS playlist: ${res.status} ${res.url || playlistUrl}`);

  const responseUrl = res.url || playlistUrl;
  if (responseUrl !== playlistUrl) await options.authorizeUrl?.(responseUrl);
  const manifestText = await res.text();
  if (
    /METHOD=SAMPLE-AES|URI="skd:\/\/|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|com\.microsoft\.playready|com\.widevine\.alpha|urn:uuid:)/i.test(
      manifestText,
    )
  ) {
    throw new Error('This video is DRM-protected and cannot be downloaded.');
  }
  if (!manifestText.includes('#EXT-X-STREAM-INF')) return { url: responseUrl, manifestText };

  const { variants } = parseHlsMaster(manifestText, responseUrl);
  const best = variants.sort(
    (a, b) => (b.resolution?.height ?? 0) - (a.resolution?.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  )[0];
  if (!best) throw new Error('No variant stream found in master playlist');
  const video = await fetchResolvedHlsPlaylist(best.url, headers, options);
  const audio = best.audioUrl ? await fetchResolvedHlsPlaylist(best.audioUrl, headers, options) : undefined;
  return { ...video, audio: audio ?? video.audio };
};

export { fetchResolvedHlsPlaylist, headersForFetch };
