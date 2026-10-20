export type HlsKeyInfo = {
  method: 'AES-128' | 'NONE';
  uri?: string;
  iv?: Uint8Array;
};

export type HlsSegmentInfo = {
  url: string;
  range?: { start: number; end: number };
  keyInfo?: HlsKeyInfo;
  sequenceNumber: number;
};

export type HlsPlaylistResult = {
  segments: HlsSegmentInfo[];
  mapUrl?: string;
  mapRange?: { start: number; end: number };
};

export const parseM3u8Attributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ',' || raw[i] === ' ')) i++;
    if (i >= raw.length) break;
    const eqIdx = raw.indexOf('=', i);
    if (eqIdx < 0) break;
    const key = raw.slice(i, eqIdx).trim();
    i = eqIdx + 1;
    let value: string;
    if (raw[i] === '"') {
      const closeIdx = raw.indexOf('"', i + 1);
      if (closeIdx < 0) {
        value = raw.slice(i + 1);
        i = raw.length;
      } else {
        value = raw.slice(i + 1, closeIdx);
        i = closeIdx + 1;
      }
    } else {
      const commaIdx = raw.indexOf(',', i);
      if (commaIdx < 0) {
        value = raw.slice(i).trim();
        i = raw.length;
      } else {
        value = raw.slice(i, commaIdx).trim();
        i = commaIdx;
      }
    }
    attrs[key] = value;
  }
  return attrs;
};

export const parseHlsPlaylist = (manifestText: string, baseUrl: string): HlsPlaylistResult => {
  const lines = manifestText.split('\n').map(l => l.trim());
  const segments: HlsSegmentInfo[] = [];
  let currentKey: HlsKeyInfo | undefined;
  let mediaSequence = 0;
  let segIndex = 0;
  let mapUrl: string | undefined;
  let mapRange: HlsSegmentInfo['range'];
  let pendingRange: string | undefined;
  let previous: HlsSegmentInfo | undefined;
  const parseRange = (raw: string, priorEnd?: number): NonNullable<HlsSegmentInfo['range']> => {
    const match = raw.match(/^(\d+)(?:@(\d+))?$/);
    const length = Number(match?.[1]);
    const start = match?.[2] === undefined ? (priorEnd === undefined ? NaN : priorEnd + 1) : Number(match[2]);
    const end = start + length - 1;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || length <= 0)
      throw new Error('Invalid HLS byte range or missing prior range offset');
    return { start, end };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseM3u8Attributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs['URI']) {
        const url = new URL(attrs['URI'], baseUrl).toString();
        const range = attrs['BYTERANGE']
          ? parseRange(attrs['BYTERANGE'], url === mapUrl ? mapRange?.end : undefined)
          : undefined;
        if (mapUrl && (url !== mapUrl || JSON.stringify(range) !== JSON.stringify(mapRange)))
          throw new Error('HLS initialization changes require a separate processing period');
        mapUrl = url;
        mapRange = range;
      }
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseM3u8Attributes(line.slice('#EXT-X-KEY:'.length));
      const method = attrs['METHOD']?.toUpperCase();
      if (method === 'NONE') {
        currentKey = { method: 'NONE' };
      } else if (method === 'AES-128') {
        const uri = attrs['URI'];
        let iv: Uint8Array | undefined;
        if (attrs['IV']) {
          const hex = attrs['IV'].replace(/^0x/i, '');
          iv = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
        }
        currentKey = { method: 'AES-128', uri: uri ? new URL(uri, baseUrl).toString() : undefined, iv };
      }
    }

    if (line && !line.startsWith('#')) {
      const url = new URL(line, baseUrl).toString();
      const range = pendingRange
        ? parseRange(pendingRange, previous?.url === url ? previous.range?.end : undefined)
        : undefined;
      previous = {
        url,
        ...(range ? { range } : {}),
        keyInfo: currentKey?.method === 'AES-128' ? { ...currentKey } : undefined,
        sequenceNumber: mediaSequence + segIndex,
      };
      segments.push(previous);
      pendingRange = undefined;
      segIndex++;
    }
  }

  return { segments, mapUrl, mapRange };
};

// Master playlists own the relationship between variants and renditions.
export const parseHlsMaster = (text: string, baseUrl: string) => {
  const lines = text.split('\n').map(line => line.trim());
  const renditions = lines
    .filter(line => line.startsWith('#EXT-X-MEDIA:'))
    .map(line => parseM3u8Attributes(line.slice('#EXT-X-MEDIA:'.length)));
  const variants = lines.flatMap((line, index) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return [];
    const attrs = parseM3u8Attributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const uri = lines.slice(index + 1).find(value => value && !value.startsWith('#'));
    if (!uri) return [];
    const audio = renditions.filter(item => item.TYPE === 'AUDIO' && item['GROUP-ID'] === attrs.AUDIO);
    const selected =
      audio.find(item => item.DEFAULT === 'YES') ?? audio.find(item => item.AUTOSELECT === 'YES') ?? audio[0];
    const [width, height] = (attrs.RESOLUTION ?? '').split('x').map(Number);
    return [
      {
        url: new URL(uri, baseUrl).href,
        bandwidth: Number(attrs.BANDWIDTH) || undefined,
        resolution: width > 0 && height > 0 ? { width, height } : undefined,
        codecs: attrs.CODECS,
        name: attrs.NAME,
        audioUrl: selected?.URI ? new URL(selected.URI, baseUrl).href : undefined,
      },
    ];
  });
  const childUrls = [
    ...new Set([
      ...variants.map(variant => variant.url),
      ...renditions.filter(item => item.URI).map(item => new URL(item.URI, baseUrl).href),
    ]),
  ];
  return { variants, childUrls };
};
