const BROWSER_CONTROLLED_HEADERS = new Set(['cookie', 'origin', 'referer']);

const headersForFetch = (headers?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !BROWSER_CONTROLLED_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-fetch-'),
    ),
  );

type ResolvedPlaylist = { url: string; manifestText: string };

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

  const lines = manifestText.split('\n').map(line => line.trim());
  let bestBandwidth = -1;
  let bestUrl = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
    const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
    let urlIndex = index + 1;
    while (urlIndex < lines.length && (lines[urlIndex] === '' || lines[urlIndex].startsWith('#'))) urlIndex++;
    if (urlIndex < lines.length && bandwidth > bestBandwidth) {
      bestBandwidth = bandwidth;
      bestUrl = new URL(lines[urlIndex], responseUrl).toString();
    }
  }
  if (!bestUrl) throw new Error('No variant stream found in master playlist');
  return fetchResolvedHlsPlaylist(bestUrl, headers, options);
};

export { fetchResolvedHlsPlaylist, headersForFetch };
