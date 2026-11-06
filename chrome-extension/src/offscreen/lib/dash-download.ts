import { dashManifestDurationSeconds, jsfetchInputForOpfs, jsfetchInputForUrl, preflightDiskSpace } from './libav-mux';
import { describeDash, describeDirectFile, mergeTrackDescriptors } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, removeOpfs } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `dash-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

// ─── DASH types ───

type DashSegmentInfo = {
  initUrl?: string;
  segmentUrls: string[];
};

type DashTrackSet = {
  video?: DashSegmentInfo;
  audio?: DashSegmentInfo;
};

// ─── DASH parsing ───

const parseIsoDuration = (iso: string): number => {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
};

const child = (element: Element, name: string): Element | undefined =>
  Array.from(element.children).find(value => value.localName === name);
const representationBase = (rep: Element, manifestUrl: string): string => {
  const ancestors: Element[] = [];
  for (let element: Element | null = rep; element; element = element.parentElement) ancestors.unshift(element);
  let url = manifestUrl;
  for (const element of ancestors) {
    const base = child(element, 'BaseURL')?.textContent?.trim();
    if (base) url = new URL(base, url).href;
  }
  return url;
};

const parseDashSegmentTemplate = (
  template: Element,
  rep: Element,
  manifestUrl: string,
): DashSegmentInfo | undefined => {
  const initTpl = template.getAttribute('initialization') ?? '';
  const mediaTpl = template.getAttribute('media') ?? '';
  const repId = rep.getAttribute('id') ?? '';
  const bandwidth = rep.getAttribute('bandwidth') ?? '';
  const startNumber = Number(template.getAttribute('startNumber') ?? '1');

  const replaceTpl = (tpl: string, vars: Record<string, string>) =>
    tpl.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (token, name: string, width?: string) => {
      const value = vars[name];
      if (value === undefined) return token;
      if (!width) return value;
      const digits = Number(width);
      if (digits > 20) throw new Error('Unsupported DASH number padding');
      return value.padStart(digits, '0');
    });
  const tplVars = { RepresentationID: repId, Bandwidth: bandwidth };
  const initUrl = initTpl ? new URL(replaceTpl(initTpl, tplVars), manifestUrl).toString() : undefined;
  const segmentUrls: string[] = [];

  const timeline = template.querySelector('SegmentTimeline');
  if (timeline) {
    let time = 0;
    const entries = Array.from(timeline.querySelectorAll('S'));
    const timescale = Number(template.getAttribute('timescale') ?? '1');
    const periodDuration = parseIsoDuration(
      template.closest('Period')?.getAttribute('duration') ??
        template.closest('MPD')?.getAttribute('mediaPresentationDuration') ??
        '',
    );
    const offset = Number(template.getAttribute('presentationTimeOffset') ?? '0');
    for (const [index, s] of entries.entries()) {
      const t = s.getAttribute('t');
      if (t) time = Number(t);
      const d = Number(s.getAttribute('d') ?? '0');
      const r = Number(s.getAttribute('r') ?? '0');
      const boundary = entries[index + 1]?.getAttribute('t');
      const count =
        r === -1
          ? Math.ceil(
              ((boundary === null || boundary === undefined ? periodDuration * timescale + offset : Number(boundary)) -
                time) /
                d,
            )
          : r + 1;
      if (
        !Number.isSafeInteger(d) ||
        d <= 0 ||
        !Number.isSafeInteger(time) ||
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        count + segmentUrls.length > 100000
      )
        throw new Error('Unsupported or unbounded DASH timeline');
      for (let i = 0; i < count; i++) {
        const url = replaceTpl(mediaTpl, {
          ...tplVars,
          Time: String(time),
          Number: String(segmentUrls.length + startNumber),
        });
        segmentUrls.push(new URL(url, manifestUrl).toString());
        time += d;
      }
    }
  } else {
    const duration = Number(template.getAttribute('duration') ?? '0');
    const timescale = Number(template.getAttribute('timescale') ?? '1');
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timescale) || timescale <= 0) return undefined;
    const period = template.closest('Period');
    const mpd = template.closest('MPD');
    const periodDur = period?.getAttribute('duration') ?? mpd?.getAttribute('mediaPresentationDuration') ?? '';
    const totalSeconds = parseIsoDuration(periodDur);
    if (totalSeconds <= 0) return undefined;
    const segCount = Math.ceil(totalSeconds / (duration / timescale));
    if (!Number.isSafeInteger(segCount) || segCount > 100000) throw new Error('Unbounded DASH segment count');
    for (let i = 0; i < segCount; i++) {
      const url = replaceTpl(mediaTpl, { ...tplVars, Number: String(startNumber + i) });
      segmentUrls.push(new URL(url, manifestUrl).toString());
    }
  }

  return { initUrl, segmentUrls };
};

const parseDashSegmentList = (segList: Element, manifestUrl: string): DashSegmentInfo => {
  const initEl = segList.querySelector('Initialization');
  const initUrl = initEl?.getAttribute('sourceURL')
    ? new URL(initEl.getAttribute('sourceURL')!, manifestUrl).toString()
    : undefined;
  const segmentUrls = Array.from(segList.querySelectorAll('SegmentURL'))
    .map(el => el.getAttribute('media'))
    .filter((u): u is string => Boolean(u))
    .map(u => new URL(u, manifestUrl).toString());
  return { initUrl, segmentUrls };
};

const extractDashSegmentUrls = (
  rep: Element,
  adaptationSet: Element,
  manifestUrl: string,
): DashSegmentInfo | undefined => {
  const template = child(rep, 'SegmentTemplate') ?? child(adaptationSet, 'SegmentTemplate');
  const base = representationBase(rep, manifestUrl);
  if (template) return parseDashSegmentTemplate(template, rep, base);
  const segList = child(rep, 'SegmentList') ?? child(adaptationSet, 'SegmentList');
  if (segList) return parseDashSegmentList(segList, base);
  return undefined;
};

const fetchMpdText = async (manifestUrl: string, signal: AbortSignal): Promise<string> => {
  const res = await fetch(manifestUrl, {
    credentials: 'include',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!res.ok) throw new Error(`Failed to fetch DASH manifest: ${res.status}`);
  return res.text();
};

// Parses BOTH tracks. Only used by the auth-fallback branch — the direct
// path hands the MPD URL to libav and lets it demux natively.
const parseDashSegments = (xml: string, manifestUrl: string): DashTrackSet => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  if (doc.querySelectorAll('Period').length > 1) throw new Error('Multiple DASH periods require separate processing');
  const result: DashTrackSet = {};
  for (const as of Array.from(doc.querySelectorAll('AdaptationSet'))) {
    const contentType =
      as.getAttribute('contentType') ??
      as.getAttribute('mimeType') ??
      child(as, 'Representation')?.getAttribute('mimeType') ??
      '';
    const isVideo = contentType.includes('video');
    const isAudio = contentType.includes('audio');
    if (!isVideo && !isAudio) continue;
    const trackName = isVideo ? 'video' : 'audio';
    if (result[trackName]) continue;

    const reps = Array.from(as.querySelectorAll('Representation'));
    if (reps.length === 0) continue;
    const bestRep = reps.reduce((best, rep) => {
      const bw = Number(rep.getAttribute('bandwidth') ?? '0');
      const bestBw = Number(best.getAttribute('bandwidth') ?? '0');
      return bw > bestBw ? rep : best;
    });

    const segmentInfo = extractDashSegmentUrls(bestRep, as, manifestUrl);
    if (segmentInfo && segmentInfo.segmentUrls.length > 0) {
      result[trackName] = segmentInfo;
    }
  }
  return result;
};

// ─── DASH download ───

export const downloadDashMuxed = async (
  manifestUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
): ReturnType<typeof prepareOutputDelivery> => {
  void fileName;
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  let videoInputOpfs: string | null = null;
  let audioInputOpfs: string | null = null;
  let videoBlobUrl: string | null = null;
  let audioBlobUrl: string | null = null;
  let outputOpfsName: string | null = null;
  try {
    await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });
    // Fetch the MPD once — we need it for duration in both paths and for
    // segment URLs in the auth-fallback path.
    const mpdText = await fetchMpdText(manifestUrl, abortController.signal);
    const durationSeconds = dashManifestDurationSeconds(mpdText);
    let descriptor = describeDash(mpdText, durationSeconds);
    let plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));
    let outputContainer = plan.output.container;
    outputOpfsName = opfsNameFor(key, 'out', outputContainer);
    const useAuthFallback = true; // All representations share the global download budget.

    abortController.signal.throwIfAborted();
    if (!useAuthFallback) {
      // Direct: libav demuxes DASH natively, pulling each representation over
      // jsfetch. DNR rewrites still apply to those sub-fetches.
      const jsfetchUrl = jsfetchInputForUrl(manifestUrl);
      if (plan.type === 'passthrough' || plan.type === 'concatenate-fmp4') {
        throw new Error(`Unexpected ${plan.type} plan for DASH input`);
      }
      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: [jsfetchUrl], formatHint: 'dash' },
        durationSeconds,
      });
    } else {
      // Auth-fallback: parse the MPD, pre-fetch video + audio segments into
      // separate OPFS files, then feed libav two jsfetch:blob inputs.
      const tracks = parseDashSegments(mpdText, manifestUrl);
      if (!tracks.video && !tracks.audio) throw new Error('No tracks found in DASH manifest');

      let totalBytes = 0;

      if (tracks.video) {
        videoInputOpfs = opfsNameFor(key, 'in-video', 'mp4');
        const { totalBytes: vb } = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: videoInputOpfs,
          segments: tracks.video.segmentUrls.map((url, i) => ({ url, sequenceNumber: i })),
          initUrl: tracks.video.initUrl,
          keyHeaders: headers,
          stage: 'download-video',
        });
        totalBytes += vb;
      }
      if (tracks.audio) {
        audioInputOpfs = opfsNameFor(key, 'in-audio', 'mp4');
        const { totalBytes: ab } = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: audioInputOpfs,
          segments: tracks.audio.segmentUrls.map((url, i) => ({ url, sequenceNumber: i })),
          initUrl: tracks.audio.initUrl,
          keyHeaders: headers,
          stage: 'download-audio',
        });
        totalBytes += ab;
      }

      await preflightDiskSpace(totalBytes);

      const videoJsfetch = videoInputOpfs ? await jsfetchInputForOpfs(videoInputOpfs) : null;
      if (videoJsfetch) videoBlobUrl = videoJsfetch.blobUrl;
      const audioJsfetch = audioInputOpfs ? await jsfetchInputForOpfs(audioInputOpfs) : null;
      if (audioJsfetch) audioBlobUrl = audioJsfetch.blobUrl;

      const inputFiles = [
        videoInputOpfs ? await getOpfsFile(videoInputOpfs) : null,
        audioInputOpfs ? await getOpfsFile(audioInputOpfs) : null,
      ].filter((file): file is File => file !== null);
      const inputDescriptors = await Promise.all(inputFiles.map(file => describeDirectFile(file, 'separate-tracks')));
      descriptor = mergeTrackDescriptors(inputDescriptors);
      plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));
      if (plan.type === 'passthrough' || plan.type === 'concatenate-fmp4') {
        throw new Error(`Unexpected ${plan.type} plan for prefetched DASH tracks`);
      }
      if (plan.output.container !== outputContainer) {
        if (outputOpfsName) await removeOpfs(outputOpfsName).catch(() => undefined);
        outputContainer = plan.output.container;
        outputOpfsName = opfsNameFor(key, 'out', outputContainer);
      }
      const inputUrls =
        plan.type === 'transcode-audio-to-mp3'
          ? [audioJsfetch?.jsfetchUrl ?? videoJsfetch!.jsfetchUrl]
          : [videoJsfetch?.jsfetchUrl, audioJsfetch?.jsfetchUrl].filter((url): url is string => Boolean(url));
      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: inputUrls },
        durationSeconds,
        estimatedBytes: plan.type === 'transcode-audio-to-mp3' ? undefined : totalBytes,
      });

      if (videoBlobUrl) URL.revokeObjectURL(videoBlobUrl);
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
      videoBlobUrl = null;
      audioBlobUrl = null;
      if (videoInputOpfs) {
        await removeOpfs(videoInputOpfs).catch(() => undefined);
        videoInputOpfs = null;
      }
      if (audioInputOpfs) {
        await removeOpfs(audioInputOpfs).catch(() => undefined);
        audioInputOpfs = null;
      }
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const delivery = await prepareOutputDelivery({
      jobKey: key,
      file: outputFile,
      opfsName: outputOpfsName,
      plan,
      expectedDurationSeconds: durationSeconds,
    });
    return delivery;
  } catch (err) {
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
    if (videoInputOpfs) await removeOpfs(videoInputOpfs).catch(() => undefined);
    if (audioInputOpfs) await removeOpfs(audioInputOpfs).catch(() => undefined);
    if (outputOpfsName) await removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
