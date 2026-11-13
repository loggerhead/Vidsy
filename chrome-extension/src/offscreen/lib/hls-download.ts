import { shouldDiscardInput, failureKind, LiveSnapshotFailure } from './download-failure';
import { fetchResolvedHlsPlaylist } from './hls-request';
import { hlsManifestDurationSeconds, jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { parseHlsPlaylist } from './m3u8-parser';
import { describeHls, mergeTrackDescriptors } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { opfsJobName } from './opfs-job-name';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress } from './progress';
import { activeAbortControllers, downloadStopIntents } from './segment-fetcher';
import {
  prepareSegmentedSource,
  rememberSegmentedDescriptor,
  isLiveHls,
  readFrozenSegmentedSnapshot,
} from './segmented-resume';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, removeOpfs, discardWorkerJobFiles } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): Promise<string> => opfsJobName('hls', key, tag, ext);

const descriptions = new Map<string, Awaited<ReturnType<typeof describeHls>>>();
const describeRetainedHls = async (
  key: string,
  args: Parameters<typeof describeHls>[0],
): ReturnType<typeof describeHls> => {
  const identity = JSON.stringify({ key, url: args.manifestUrl, manifest: args.manifestText });
  const prior = descriptions.get(identity);
  if (prior) return prior;
  const descriptor = await describeHls(args);
  descriptions.set(identity, descriptor);
  return descriptor;
};

const authorizeDownloadUrl = async (key: string, url: string): Promise<string> => {
  const response = await chrome.runtime.sendMessage({
    type: 'offscreen/authorize-download-url',
    payload: { key, url },
  });
  if (!response?.ok) throw new Error(response?.error || `Failed to authorize HLS request: ${url}`);
  return response.url ?? url;
};

export const downloadHlsMuxed = async (
  playlistUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
  audioUrl?: string,
  audioHeaders?: Record<string, string>,
): ReturnType<typeof prepareOutputDelivery> => {
  void fileName;
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));
  const trackFiles: string[] = [];
  const trackBlobs: string[] = [];
  let outputOpfsName: string | null = null;
  let inputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;
  let discardInputs = false;
  let live = false;
  try {
    await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });

    const frozen = await readFrozenSegmentedSnapshot(key);
    const resolved =
      frozen?.kind === 'hls'
        ? { ...frozen.video, audio: frozen.audio }
        : await fetchResolvedHlsPlaylist(playlistUrl, headers, {
            authorizeUrl: url => authorizeDownloadUrl(key, url),
            signal: abortController.signal,
          });

    const { url: variantUrl, manifestText } = resolved;
    const audio =
      frozen?.kind === 'hls'
        ? frozen.audio
        : audioUrl
          ? await fetchResolvedHlsPlaylist(audioUrl, audioHeaders ?? headers, {
              authorizeUrl: url => authorizeDownloadUrl(key, url),
              signal: abortController.signal,
            })
          : resolved.audio;

    const durationSeconds = hlsManifestDurationSeconds(manifestText);
    live = isLiveHls(manifestText) || Boolean(audio && isLiveHls(audio.manifestText));
    const source = await prepareSegmentedSource(
      key,
      {
        kind: 'hls',
        video: { url: variantUrl, manifestText },
        audio: audio && { url: audio.url, manifestText: audio.manifestText },
        headers,
        ...(audioHeaders ? { audioHeaders } : {}),
      },
      live,
      {
        kind: 'hls',
        video: { url: variantUrl, manifestText },
        audio: audio && { url: audio.url, manifestText: audio.manifestText },
      },
    );
    let descriptor =
      source.descriptor ??
      (await describeRetainedHls(key, {
        manifestText,
        manifestUrl: variantUrl,
        headers,
        authorizeUrl: url => authorizeDownloadUrl(key, url),
        signal: abortController.signal,
        durationSeconds,
      }));
    if (audio && !source.descriptor) {
      const audioDescriptor = await describeRetainedHls(key, {
        manifestText: audio.manifestText,
        manifestUrl: audio.url,
        headers: audioHeaders ?? headers,
        authorizeUrl: url => authorizeDownloadUrl(key, url),
        signal: abortController.signal,
      });
      if (!audioDescriptor.tracks.some(track => track.type === 'audio')) {
        throw new Error('The declared HLS audio rendition has no audio track');
      }
      descriptor = mergeTrackDescriptors([descriptor, audioDescriptor]);
    }
    await rememberSegmentedDescriptor(key, source, descriptor);
    const plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));
    if (plan.type === 'passthrough') throw new Error('Unexpected passthrough plan for HLS input');
    outputOpfsName = await opfsNameFor(key, 'out', plan.output.container);
    abortController.signal.throwIfAborted();
    if (audio) {
      if (plan.type === 'concatenate-fmp4') throw new Error('Separate HLS tracks require muxing');
      let totalBytes = 0;
      const inputs: string[] = [];
      for (const [index, playlist] of [resolved, audio].entries()) {
        if (abortController.signal.aborted) throw new Error('Download cancelled');
        const { segments, mapUrl, mapRange } = parseHlsPlaylist(playlist.manifestText, playlist.url);
        if (!segments.length) throw new Error('No segments in HLS playlist');
        const name = await opfsNameFor(key, index === 0 ? 'video' : 'audio', mapUrl ? 'mp4' : 'ts');
        trackFiles.push(name);
        const result = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: name,
          segments,
          initUrl: mapUrl,
          initRange: mapRange,
          manifestIdentity: playlist.manifestText,
          keyHeaders: index === 1 ? (audioHeaders ?? headers) : headers,
          stage: index === 0 ? 'download-video' : 'download-audio',
          progressOffset: totalBytes,
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
    } else {
      // Prefetch: download segments with retry and strict response validation,
      // then feed libav one stable OPFS-backed input.
      const { segments, mapUrl, mapRange } = parseHlsPlaylist(manifestText, variantUrl);
      if (segments.length === 0) throw new Error('No segments in HLS playlist');
      const isFmp4 = Boolean(mapUrl);
      inputOpfsName = await opfsNameFor(key, 'in', isFmp4 ? 'mp4' : 'ts');

      const { totalBytes } = await fetchSegmentsToOpfs({
        jobKey: key,
        opfsName: inputOpfsName,
        segments,
        initUrl: mapUrl,
        initRange: mapRange,
        manifestIdentity: manifestText,
        keyHeaders: headers,
        stage: 'download-video',
      });

      if (plan.type === 'concatenate-fmp4') {
        const file = await getOpfsFile(inputOpfsName);
        const delivery = await prepareOutputDelivery({
          signal: abortController.signal,
          jobKey: key,
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
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const delivery = await prepareOutputDelivery({
      signal: abortController.signal,
      jobKey: key,
      file: outputFile,
      opfsName: outputOpfsName,
      plan,
      expectedDurationSeconds: durationSeconds,
    });
    if (inputOpfsName) await removeOpfs(inputOpfsName).catch(() => undefined);
    discardInputs = true;
    return delivery;
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    discardInputs =
      (live && failureKind(err) !== 'processing') || shouldDiscardInput(err, downloadStopIntents.get(key));
    if (live && discardInputs) await discardWorkerJobFiles(key);
    if (inputOpfsName && discardInputs) await removeOpfs(inputOpfsName).catch(() => undefined);
    if (outputOpfsName) await removeOpfs(outputOpfsName).catch(() => undefined);
    throw live && failureKind(err) === 'transport' ? new LiveSnapshotFailure(err) : err;
  } finally {
    for (const url of trackBlobs) URL.revokeObjectURL(url);
    if (discardInputs) for (const name of trackFiles) await removeOpfs(name).catch(() => undefined);
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
