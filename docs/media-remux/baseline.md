# Media remux baseline

This report freezes the baseline required by `docs/goal/03-execution-plan.md`.
The fixtures are generated locally from FFmpeg test sources and contain no
third-party or user media.

## Environment

- Date: 2026-08-14
- Host: Apple silicon macOS
- Node.js: 22.19.0
- pnpm: 10.11.0
- System FFmpeg and ffprobe: 8.1.2
- libav.js: 6.8.8.0
- Production variant: `h264-aac-mp3-cli`
- Production WASM size: 4,359,295 bytes

The baseline variant embeds an FFmpeg configuration that includes HLS,
MPEG-TS, MP4, Matroska/WebM, AAC, H.264, MP3, `jsfetch`, and the H.264
MP4-to-Annex-B bitstream filter. It does not enable an HEVC parser or decoder.
It also includes the OpenH264 video encoder even though production remux does
not need video encoding.

## Reproduction

```sh
tools/media-remux/generate-fixtures.sh /tmp/vidsy-media-remux-fixtures

node tools/media-remux/run-libav-baseline.mjs \
  /tmp/vidsy-media-remux-fixtures/hls-ts-h264.ts \
  /tmp/vidsy-h264-baseline.mp4

node tools/media-remux/run-libav-baseline.mjs \
  /tmp/vidsy-media-remux-fixtures/hls-ts-hevc.ts \
  /tmp/vidsy-hevc-baseline.mp4
```

Probe outputs are obtained with the independent system `ffprobe`, not the
libav.js instance that produced the file:

```sh
ffprobe -v error \
  -show_entries format=format_name,duration,size \
  -show_entries stream=index,codec_name,codec_type,codec_tag_string \
  -of json /tmp/vidsy-h264-baseline.mp4
```

## Results

| Fixture | Input bytes | libav exit | Output bytes | Independent probe |
| --- | ---: | ---: | ---: | --- |
| H.264 + AAC MPEG-TS | 191,948 | 0 | 177,051 | MP4, H.264 `avc1`, AAC `mp4a`, 2.026667 s |
| HEVC + AAC MPEG-TS | 97,572 | -28 | 0 | No recognizable output |

The HEVC failure is stable and reports `dimensions not set` followed by
`Could not write header`. This reproduces the goal's representative failure:
the command returns a non-zero code and leaves a zero-byte MP4.

## Baseline limitations

The repository did not previously contain a licensed offline fixture matrix or
a media processing harness. Phase 0 therefore starts with generated H.264 and
HEVC MPEG-TS fixtures. The remaining fMP4 HLS, DASH, direct MP4, merged A/V,
WebM, MP3, DRM, truncated, and missing-track fixtures are added by the complete
validation harness rather than claimed as established by this initial report.
