import { flowLog, errorInfo } from './download-log';
import { headersForFetch, scopeHeaders } from './fetch-headers';
import { parseHlsMaster } from './m3u8-parser';
import { HttpRequestError, openDownloadResponse, retryableRequest } from './network-request';

type ResolvedPlaylist = { url: string; manifestText: string; audio?: ResolvedPlaylist };

type HlsPlaylistFetchOptions = {
  fetchImpl?: typeof fetch;
  authorizeUrl?: (url: string) => Promise<void | string>;
  signal?: AbortSignal;
};

const fetchResolvedHlsPlaylist = async (
  playlistUrl: string,
  headers?: Record<string, string>,
  options: HlsPlaylistFetchOptions = {},
): Promise<ResolvedPlaylist> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  options.signal?.throwIfAborted();

  let responseUrl = playlistUrl;
  let manifestText = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let request: Awaited<ReturnType<typeof openDownloadResponse>> | undefined;
    try {
      request = await openDownloadResponse(responseUrl, {
        signal: options.signal,
        headers,
        fetchImpl,
        authorizeUrl: options.authorizeUrl,
        totalMs: 120_000,
      });
      const res = request.response;
      responseUrl = res.url || responseUrl;
      if (!res.ok) {
        await res.body?.cancel();
        if ([401, 403].includes(res.status))
          throw new Error(`Failed to fetch HLS playlist: ${res.status}. Refresh the video page and retry.`);
        throw new HttpRequestError(res.status, responseUrl);
      }
      if (!res.body) throw new Error('HLS playlist response has no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      manifestText = '';
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          request.touch();
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error('HLS playlist exceeds 8 MiB');
          manifestText += decoder.decode(value, { stream: true });
        }
        manifestText += decoder.decode();
      } finally {
        await reader.cancel();
      }
      break;
    } catch (error) {
      const reason = request?.signal.aborted ? request.signal.reason : error;
      flowLog('hls.playlist.failed', { url: responseUrl, attempt: attempt + 1, error: errorInfo(reason) });
      if (
        options.signal?.aborted ||
        attempt === 2 ||
        !retryableRequest(reason) ||
        /Refresh the video page|exceeds 8 MiB/.test(String(reason))
      )
        throw reason instanceof HttpRequestError
          ? new Error(`Failed to fetch HLS playlist: ${reason.status} ${reason.url}`)
          : reason;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    } finally {
      request?.dispose();
    }
  }
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
