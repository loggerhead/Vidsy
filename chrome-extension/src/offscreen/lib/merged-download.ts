import { cacheCommand } from './cache-client';
import { errorInfo, flowLog, safeUrl } from './download-log';
import { downloadUrlToOpfs, discardCompletedHttpInput } from './http-download';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { describeDirectFile, mergeTrackDescriptors } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { opfsJobName } from './opfs-job-name';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress } from './progress';
import { probeRangeSupport } from './range-probe';
import { activeAbortControllers, downloadStopIntents } from './segment-fetcher';
import { cancelWorkerJob, getOpfsFile, readMaxConnections, removeOpfs } from './worker-client';
import type { DownloadTransport } from './http-download';
import type { RangeProbe } from './range-probe';
import type { ProgressUpdate } from '../download_worker/messages';

type TrackProgress = {
  downloadedBytes: number;
  estimatedBytes?: number;
  activeConnections: number;
  transport?: DownloadTransport;
  done: boolean;
  resumeNotice?: string;
};

const activeConnectionsFor = (progress: ProgressUpdate): number =>
  progress.chunks
    ? progress.chunks.filter(chunk => chunk.status === 'fetching').length
    : progress.downloadedBytes > 0
      ? 1
      : 0;

// Download video + audio into separate OPFS files under one connection
// budget, then feed libav two jsfetch:blob inputs for a zero-copy stream-copy
// mux. Both sources stay disk-backed; libav's only in-RAM state is its
// internal ring buffer.
export const downloadMerged = async (
  videoUrl: string,
  audioUrl: string,
  videoMimeType: string | undefined,
  audioMimeType: string | undefined,
  key: string,
  headers?: Record<string, string>,
  revalidateCompleted = false,
  audioHeaders?: Record<string, string>,
): ReturnType<typeof prepareOutputDelivery> => {
  flowLog('merged.start', {
    videoUrl: safeUrl(videoUrl),
    audioUrl: safeUrl(audioUrl),
    key: safeUrl(key),
    headerNames: Object.keys(headers ?? {}),
  });
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const videoOpfsName = await opfsJobName('merged', key, 'video', '.bin');
  const audioOpfsName = await opfsJobName('merged', key, 'audio', '.bin');
  let outputOpfsName: string | null = null;
  let videoBlobUrl: string | null = null;
  let audioBlobUrl: string | null = null;

  try {
    const totalConnectionBudget = await readMaxConnections();
    const videoConnections = totalConnectionBudget > 1 ? totalConnectionBudget - 1 : 1;
    const audioConnections = 1;
    const tracks: Record<'video' | 'audio', TrackProgress> = {
      video: { downloadedBytes: 0, activeConnections: 0, done: false },
      audio: { downloadedBytes: 0, activeConnections: 0, done: false },
    };
    let progressWrite = Promise.resolve();

    const publishCombinedProgress = (): Promise<void> => {
      const downloadedBytes = tracks.video.downloadedBytes + tracks.audio.downloadedBytes;
      const estimates = [tracks.video.estimatedBytes, tracks.audio.estimatedBytes];
      const estimatedBytes = estimates.every(value => value !== undefined)
        ? (estimates[0] as number) + (estimates[1] as number)
        : undefined;
      const transports = [tracks.video.transport, tracks.audio.transport].filter(
        (value): value is DownloadTransport => value !== undefined,
      );
      const modes = new Set(transports.map(transport => transport.mode));
      const transferMode = modes.size > 1 ? 'mixed' : modes.values().next().value;
      const methods = new Set(transports.map(transport => transport.validationMethod).filter(Boolean));
      const validationMethod = methods.size > 1 ? ('mixed' as const) : [...methods][0];
      const fallbackReason = transports
        .map(transport => transport.fallbackReason)
        .filter((reason): reason is string => !!reason)
        .join('; ');

      progressWrite = progressWrite.then(() =>
        updateProgress(key, {
          stage: tracks.video.done && !tracks.audio.done ? 'download-audio' : 'download-video',
          downloadedBytes,
          estimatedBytes,
          chunks: [],
          transferMode,
          validationMethod,
          resumeCapability: transports.some(transport => transport.mode === 'stream')
            ? 'restart'
            : transports.length === 2
              ? 'range'
              : undefined,
          activeConnections: tracks.video.activeConnections + tracks.audio.activeConnections,
          connectionLimit: totalConnectionBudget,
          fallbackReason: fallbackReason || undefined,
          resumeNotice: [tracks.video.resumeNotice, tracks.audio.resumeNotice].filter(Boolean).join('; ') || undefined,
        }),
      );
      return progressWrite;
    };

    const progressFor =
      (track: 'video' | 'audio') =>
      (progress: ProgressUpdate): void => {
        tracks[track].downloadedBytes = progress.downloadedBytes;
        if (progress.resumeNotice) tracks[track].resumeNotice = progress.resumeNotice;
        tracks[track].estimatedBytes = progress.estimatedBytes;
        tracks[track].activeConnections = activeConnectionsFor(progress);
        void publishCombinedProgress();
      };
    const transportFor =
      (track: 'video' | 'audio') =>
      async (transport: DownloadTransport): Promise<void> => {
        tracks[track].transport = transport;
        tracks[track].estimatedBytes = transport.totalBytes;
        tracks[track].activeConnections = transport.connectionLimit;
        await publishCombinedProgress();
      };

    await updateProgress(key, {
      stage: 'download-video',
      downloadedBytes: 0,
      chunks: [],
      connectionLimit: totalConnectionBudget,
    });

    const probes: Partial<Record<'video' | 'audio', RangeProbe>> = {};
    const preflightTrack = async (track: 'video' | 'audio', url: string, name: string, connections: number) => {
      const { record } = await cacheCommand({ operation: 'read', name });
      if (record?.complete && record.httpMetadata && !revalidateCompleted) {
        await transportFor(track)(record.httpMetadata.transport);
        return;
      }
      const probe = await probeRangeSupport(
        url,
        abortController.signal,
        track === 'audio' ? (audioHeaders ?? headers) : headers,
        record?.ranges?.source,
      );
      probes[track] = probe;
      const mode =
        probe.supportsRange && probe.totalBytes && probe.totalBytes > 0 ? ('range' as const) : ('stream' as const);
      await transportFor(track)({
        mode,
        connectionLimit: mode === 'range' ? connections : 1,
        totalBytes: probe.totalBytes,
        validationMethod: probe.validationMethod,
        fallbackReason: mode === 'stream' ? 'This track has no byte-offset resume; it restarts on Retry' : undefined,
      });
    };
    await preflightTrack('video', videoUrl, videoOpfsName, videoConnections);
    await preflightTrack('audio', audioUrl, audioOpfsName, audioConnections);
    tracks.video.activeConnections = 0;
    tracks.audio.activeConnections = 0;
    await publishCombinedProgress();

    const downloadVideo = async () => {
      const result = await downloadUrlToOpfs({
        url: videoUrl,
        preflightProbe: probes.video,
        revalidateCompleted,
        jobKey: key,
        opfsName: videoOpfsName,
        stage: 'download-video',
        signal: abortController.signal,
        headers,
        maxConnections: videoConnections,
        reportProgress: false,
        onProgress: progressFor('video'),
        onTransport: transportFor('video'),
      });
      tracks.video.downloadedBytes = result.totalBytes;
      tracks.video.estimatedBytes = result.totalBytes;
      tracks.video.activeConnections = 0;
      tracks.video.done = true;
      flowLog('merged.video.done', {
        url: safeUrl(videoUrl),
        totalBytes: result.totalBytes,
        transport: result.transport,
      });
      await publishCombinedProgress();
      return result;
    };
    const downloadAudio = async () => {
      const result = await downloadUrlToOpfs({
        url: audioUrl,
        preflightProbe: probes.audio,
        revalidateCompleted,
        jobKey: key,
        opfsName: audioOpfsName,
        stage: 'download-audio',
        signal: abortController.signal,
        headers: audioHeaders ?? headers,
        maxConnections: audioConnections,
        reportProgress: false,
        onProgress: progressFor('audio'),
        onTransport: transportFor('audio'),
      });
      tracks.audio.downloadedBytes = result.totalBytes;
      tracks.audio.estimatedBytes = result.totalBytes;
      tracks.audio.activeConnections = 0;
      tracks.audio.done = true;
      flowLog('merged.audio.done', {
        url: safeUrl(audioUrl),
        totalBytes: result.totalBytes,
        transport: result.transport,
      });
      await publishCombinedProgress();
      return result;
    };

    let videoDownload: Awaited<ReturnType<typeof downloadVideo>>;
    let audioDownload: Awaited<ReturnType<typeof downloadAudio>>;
    if (totalConnectionBudget > 1) {
      let firstFailure: unknown;
      const abortSiblingsOnFailure = async <T>(promise: Promise<T>): Promise<T> => {
        try {
          return await promise;
        } catch (err) {
          firstFailure ??= err;
          abortController.abort(err);
          cancelWorkerJob(key);
          throw err;
        }
      };
      const results = await Promise.allSettled([
        abortSiblingsOnFailure(downloadVideo()),
        abortSiblingsOnFailure(downloadAudio()),
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        throw firstFailure ?? failure.reason;
      }
      const [videoResult, audioResult] = results;
      if (videoResult.status !== 'fulfilled' || audioResult.status !== 'fulfilled') {
        throw new Error('Separate-track downloads did not complete');
      }
      videoDownload = videoResult.value;
      audioDownload = audioResult.value;
    } else {
      videoDownload = await downloadVideo();
      audioDownload = await downloadAudio();
    }

    if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

    await progressWrite;
    const totalInputBytes = videoDownload.totalBytes + audioDownload.totalBytes;
    await updateProgress(key, {
      stage: 'mux',
      downloadedBytes: totalInputBytes,
      estimatedBytes: totalInputBytes,
      resumeCapability: 'complete-input',
      validationMethod: 'local-checksums',
    });
    const descriptor = mergeTrackDescriptors([
      await describeDirectFile(videoDownload.file, 'separate-tracks', videoMimeType),
      await describeDirectFile(audioDownload.file, 'separate-tracks', audioMimeType),
    ]);
    const plan = requireExecutablePlan(planMediaProcessing(descriptor, 'media'));
    flowLog('merged.plan', { descriptor, plan });
    if (plan.type === 'passthrough' || plan.type === 'concatenate-fmp4') {
      throw new Error(`Unexpected ${plan.type} plan for separate media tracks`);
    }
    outputOpfsName = await opfsJobName('merged', key, 'out', plan.output.extension);
    await preflightDiskSpace(totalInputBytes);

    const videoJs = await jsfetchInputForOpfs(videoOpfsName);
    videoBlobUrl = videoJs.blobUrl;
    const audioJs = await jsfetchInputForOpfs(audioOpfsName);
    audioBlobUrl = audioJs.blobUrl;

    await executeMuxPlan({
      jobKey: key,
      outputOpfsName,
      plan,
      input: { urls: [videoJs.jsfetchUrl, audioJs.jsfetchUrl] },
      estimatedBytes: totalInputBytes,
    });

    URL.revokeObjectURL(videoBlobUrl);
    URL.revokeObjectURL(audioBlobUrl);
    videoBlobUrl = null;
    audioBlobUrl = null;
    const outputFile = await getOpfsFile(outputOpfsName);
    const delivery = await prepareOutputDelivery({
      signal: abortController.signal,
      jobKey: key,
      file: outputFile,
      opfsName: outputOpfsName,
      plan,
    });
    await discardCompletedHttpInput(videoOpfsName).catch(() => undefined);
    await discardCompletedHttpInput(audioOpfsName).catch(() => undefined);
    flowLog('merged.done', { outputBytes: delivery.artifact.size, output: plan.output });
    return delivery;
  } catch (err) {
    flowLog('merged.failed', { videoUrl: safeUrl(videoUrl), audioUrl: safeUrl(audioUrl), error: errorInfo(err) });
    if (videoBlobUrl) {
      try {
        URL.revokeObjectURL(videoBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (audioBlobUrl) {
      try {
        URL.revokeObjectURL(audioBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (downloadStopIntents.get(key) === 'cancel') {
      await discardCompletedHttpInput(videoOpfsName).catch(() => undefined);
      await discardCompletedHttpInput(audioOpfsName).catch(() => undefined);
    }
    if (outputOpfsName) await removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted && downloadStopIntents.has(key)) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};

export const discardMergedResume = async (key: string): Promise<void> => {
  await Promise.all(
    ['video', 'audio'].map(async tag => discardCompletedHttpInput(await opfsJobName('merged', key, tag, '.bin'))),
  );
};
