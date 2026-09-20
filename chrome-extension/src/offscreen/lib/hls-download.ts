import { fetchResolvedHlsPlaylist, headersForFetch } from './hls-request';
import { hlsManifestDurationSeconds, jsfetchInputForOpfs, jsfetchInputForUrl, preflightDiskSpace } from './libav-mux';
import { parseHlsPlaylist } from './m3u8-parser';
import { describeHls, mergeTrackDescriptors } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress } from './progress';
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
  audioUrl?: string,
): ReturnType<typeof prepareOutputDelivery> => {
  void fileName;
  await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });

  const resolved = await fetchResolvedHlsPlaylist(playlistUrl, headers, {
    authorizeUrl: url => authorizeDownloadUrl(key, url),
  });

  const { url: variantUrl, manifestText } = resolved;
  const audio = audioUrl
    ? await fetchResolvedHlsPlaylist(audioUrl, headers, { authorizeUrl: url => authorizeDownloadUrl(key, url) })
    : resolved.audio;

  const durationSeconds = hlsManifestDurationSeconds(manifestText);
  let descriptor = await describeHls({
    manifestText,
    manifestUrl: variantUrl,
    headers: headersForFetch(headers),
    durationSeconds,
  });
  if (audio) {
    const audioDescriptor = await describeHls({
      manifestText: audio.manifestText,
      manifestUrl: audio.url,
      headers: headersForFetch(headers),
    });
    if (!audioDescriptor.tracks.some(track => track.type === 'audio')) {
      throw new Error('The declared HLS audio rendition has no audio track');
    }
    descriptor = mergeTrackDescriptors([descriptor, audioDescriptor]);
  }
  const plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));
  if (plan.type === 'passthrough') throw new Error('Unexpected passthrough plan for HLS input');
  const outputOpfsName = opfsNameFor(key, 'out', plan.output.container);
  let inputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const trackFiles: string[] = [];
  const trackBlobs: string[] = [];
  try {
    if (audio) {
      if (plan.type === 'concatenate-fmp4') throw new Error('Separate HLS tracks require muxing');
      let totalBytes = 0;
      const inputs: string[] = [];
      for (const [index, playlist] of [resolved, audio].entries()) {
        if (abortController.signal.aborted) throw new Error('Download cancelled');
        const { segments, mapUrl } = parseHlsPlaylist(playlist.manifestText, playlist.url);
        if (!segments.length) throw new Error('No segments in HLS playlist');
        const resources = [mapUrl, ...segments.flatMap(segment => [segment.url, segment.keyInfo?.uri])].filter(
          (url): url is string => Boolean(url),
        );
        for (const url of new Map(resources.map(url => [new URL(url).hostname, url])).values()) {
          await authorizeDownloadUrl(key, url);
        }
        const name = opfsNameFor(key, index === 0 ? 'video' : 'audio', mapUrl ? 'mp4' : 'ts');
        trackFiles.push(name);
        const result = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: name,
          segments,
          initUrl: mapUrl,
          keyHeaders: headers,
          stage: index === 0 ? 'download-video' : 'download-audio',
        });
        totalBytes += result.totalBytes;
        const input = await jsfetchInputForOpfs(name);
        trackBlobs.push(input.blobUrl);
        inputs.push(input.jsfetchUrl);
      }
      await preflightDiskSpace(totalBytes);
      if (abortController.signal.aborted) throw new Error('Download cancelled');
      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: output === 'mp3' ? [inputs[1]] : inputs },
        durationSeconds,
        estimatedBytes: totalBytes,
      });
    } else if (!plan.prefetchToOpfs && plan.type !== 'concatenate-fmp4') {
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
    for (const url of trackBlobs) URL.revokeObjectURL(url);
    for (const name of trackFiles) void removeOpfs(name).catch(() => undefined);
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
