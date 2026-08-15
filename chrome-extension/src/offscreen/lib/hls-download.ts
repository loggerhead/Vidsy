import { fetchResolvedHlsPlaylist, headersForFetch } from './hls-request';
import { hlsManifestDurationSeconds, jsfetchInputForOpfs, jsfetchInputForUrl, preflightDiskSpace } from './libav-mux';
import { parseHlsPlaylist } from './m3u8-parser';
import { describeHls } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, removeOpfs } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `hls-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

const authorizeDownloadUrl = async (key: string, url: string): Promise<void> => {
  const response = await chrome.runtime.sendMessage({
    type: 'offscreen/authorize-download-url',
    payload: { key, url },
  });
  if (!response?.ok) throw new Error(response?.error || `Failed to authorize HLS request: ${url}`);
};

export const downloadHlsMuxed = async (
  playlistUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
): ReturnType<typeof prepareOutputDelivery> => {
  void fileName;
  await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });

  const { url: variantUrl, manifestText } = await fetchResolvedHlsPlaylist(playlistUrl, headers, {
    authorizeUrl: url => authorizeDownloadUrl(key, url),
  });

  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const durationSeconds = hlsManifestDurationSeconds(manifestText);
  const descriptor = await describeHls({
    manifestText,
    manifestUrl: variantUrl,
    headers: headersForFetch(headers),
    durationSeconds,
  });
  const plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));
  if (plan.type === 'passthrough') throw new Error('Unexpected passthrough plan for HLS input');
  const outputOpfsName = opfsNameFor(key, 'out', plan.output.container);
  let inputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  try {
    if (!plan.prefetchToOpfs && plan.type !== 'concatenate-fmp4') {
      // Direct: libav demuxes HLS natively and writes the MP4/MP3 to OPFS.
      const jsfetchUrl = jsfetchInputForUrl(variantUrl);
      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: [jsfetchUrl], formatHint: 'hls' },
        durationSeconds,
      });
    } else {
      // Prefetch: download segments with retry and strict response validation,
      // then feed libav one stable OPFS-backed input.
      const { segments, mapUrl } = parseHlsPlaylist(manifestText, variantUrl);
      if (segments.length === 0) throw new Error('No segments in HLS playlist');
      const resourceUrls = [mapUrl, ...segments.flatMap(segment => [segment.url, segment.keyInfo?.uri])].filter(
        (url): url is string => Boolean(url),
      );
      const resourceUrlByHost = new Map(resourceUrls.map(url => [new URL(url).hostname, url]));
      for (const resourceUrl of resourceUrlByHost.values()) {
        await authorizeDownloadUrl(key, resourceUrl);
      }
      const isFmp4 = Boolean(mapUrl);
      inputOpfsName = opfsNameFor(key, 'in', isFmp4 ? 'mp4' : 'ts');

      const { totalBytes } = await fetchSegmentsToOpfs({
        jobKey: key,
        opfsName: inputOpfsName,
        segments: segments.map(s => ({ url: s.url, keyInfo: s.keyInfo, sequenceNumber: s.sequenceNumber })),
        initUrl: mapUrl,
        keyHeaders: headers,
        stage: 'download-video',
      });

      if (plan.type === 'concatenate-fmp4') {
        const file = await getOpfsFile(inputOpfsName);
        const delivery = await prepareOutputDelivery({
          file,
          opfsName: inputOpfsName,
          plan,
          expectedDurationSeconds: durationSeconds,
        });
        inputOpfsName = null; // hand-off: do not remove on cleanup
        await clearProgress(key);
        return delivery;
      }

      // Need room for the output (≈ totalBytes for stream-copy MP4,
      // noticeably less for MP3 but still nonzero). Fail cleanly up front.
      await preflightDiskSpace(totalBytes);

      const { jsfetchUrl, blobUrl } = await jsfetchInputForOpfs(inputOpfsName);
      inputBlobUrl = blobUrl;

      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: [jsfetchUrl] },
        durationSeconds,
        estimatedBytes: plan.type === 'transcode-audio-to-mp3' ? undefined : totalBytes,
      });

      URL.revokeObjectURL(inputBlobUrl);
      inputBlobUrl = null;
      void removeOpfs(inputOpfsName).catch(() => undefined);
      inputOpfsName = null;
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const delivery = await prepareOutputDelivery({
      file: outputFile,
      opfsName: outputOpfsName,
      plan,
      expectedDurationSeconds: durationSeconds,
    });
    await clearProgress(key);
    return delivery;
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (inputOpfsName) void removeOpfs(inputOpfsName).catch(() => undefined);
    void removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
