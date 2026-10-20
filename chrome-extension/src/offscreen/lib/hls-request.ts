import { parseHlsMaster } from './m3u8-parser';

const BROWSER_CONTROLLED_HEADERS = new Set(['cookie', 'origin', 'referer']);

const HEADER_ORIGIN = '__vidsy_source_origin';
const scopeHeaders = (headers: Record<string, string> | undefined, url: string): Record<string, string> | undefined =>
  headers && { ...headers, [HEADER_ORIGIN]: new URL(url).origin };

const headersForFetch = (headers?: Record<string, string>, targetUrl?: string): Record<string, string> => {
  const sourceOrigin = headers?.[HEADER_ORIGIN];
  const sameOrigin = !sourceOrigin || (!!targetUrl && new URL(targetUrl).origin === sourceOrigin);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const lower = name.toLowerCase();
      if (name === HEADER_ORIGIN || BROWSER_CONTROLLED_HEADERS.has(lower) || lower.startsWith('sec-fetch-'))
        return false;
      return sameOrigin || ['accept', 'accept-language', 'user-agent'].includes(lower);
    }),
  );
};

type ResolvedPlaylist = { url: string; manifestText: string; audio?: ResolvedPlaylist };

type HlsPlaylistFetchOptions = {
  fetchImpl?: typeof fetch;
  authorizeUrl?: (url: string) => Promise<void>;
  signal?: AbortSignal;
};

const fetchResolvedHlsPlaylist = async (
  playlistUrl: string,
  headers?: Record<string, string>,
  options: HlsPlaylistFetchOptions = {},
): Promise<ResolvedPlaylist> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  options.signal?.throwIfAborted();
  await options.authorizeUrl?.(playlistUrl);

  const res = await fetchImpl(playlistUrl, {
    headers: headersForFetch(headers, playlistUrl),
    credentials: 'include',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
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

export { fetchResolvedHlsPlaylist, headersForFetch, scopeHeaders };
