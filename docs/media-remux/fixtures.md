# Media remux fixture catalog

All media fixtures are generated locally by
`tools/media-remux/generate-fixtures.sh`. They contain only FFmpeg `lavfi`
test video and generated sine waves; no third-party or user media is stored or
redistributed. The generated files live outside the repository by default at
`/tmp/vidsy-web-media-remux/fixtures-full`.

The source generator is the fixture's reproducible source and usage license is
the repository license plus the installed FFmpeg's applicable terms. No
credentials, signed URLs, cookies, or captured request headers are present.

## Catalog

| ID | Generated input facts | Expected plan | Expected output | Special property |
| --- | --- | --- | --- | --- |
| HLS-TS-H264 | 191,948-byte MPEG-TS, H.264 + AAC, 2.021 s | `copy-to-mp4` | MP4, H.264 + AAC | HLS media segment |
| HLS-TS-HEVC | 97,572-byte MPEG-TS, HEVC + AAC, 2.021 s | `copy-to-mp4`, `hvc1` tag | MP4, HEVC + AAC | HLS media segment |
| HLS-FMP4 | 1,334-byte init plus generated `.m4s` segments, H.264 + AAC, 2.042 s concatenated | `concatenate-fmp4` | Valid MP4, H.264 + AAC | Has initialization segment |
| DASH-AV | Generated MPD with separate H.264 video and AAC audio representations | `copy-to-mp4` | MP4, H.264 + AAC | Separate DASH tracks and init segments |
| HTTP-MP4 | 176,756-byte MP4, H.264 + AAC, 2.000 s | `passthrough` | Same validated MP4 facts | Direct file |
| MERGED-AV | 150,848-byte H.264-only MP4 plus 25,631-byte AAC-only M4A, both 2.000 s | `copy-to-mp4` | One MP4 with H.264 + AAC | Separate direct tracks |
| WEBM-VP9 | 105,279-byte WebM, VP9 + Opus, 2.008 s | `copy-to-webm` | WebM, VP9 + Opus | WebM-compatible copy |
| AUDIO-MP3 | Generated AAC track for matrix execution; generated WAV calibrates raw-audio probing | `transcode-audio-to-mp3` | MP3 with one MP3 audio track | Only permitted transcode |
| DRM | Synthetic HLS `SAMPLE-AES`/`KEYFORMAT` and descriptor facts | `unsupported: drm-protected` | Failure before execution | No encrypted payload is stored |
| EMPTY | Zero-byte generated file or response | failure | No artifact or success | Empty body/output |
| TRUNCATED | First 4,096 bytes of HLS-TS-H264 | failure | Independent artifact probe rejects output | Deliberately incomplete segment |
| MISSING-TRACK | Synthetic descriptor or valid output checked against a plan requiring an absent track | `unsupported` or artifact failure | No success | Missing video/audio contract |

## Tolerances

- Stream-copy and passthrough outputs must preserve every required codec and
  track type exactly.
- The independent artifact validator allows a maximum duration drift of 15% or
  2 seconds, whichever is greater, matching the short-fixture and timestamp
  discontinuity tolerance in `output-artifact.ts`.
- Outputs must be non-empty. The matrix also requires a positive independently
  probed duration for successful executable plans.
- Size is not required to be byte-identical after remux because container
  metadata and timestamp normalization differ. The container, track set,
  codec set, duration bound, and structural completeness are authoritative.

## Reproduction

```sh
tools/media-remux/generate-fixtures.sh \
  /tmp/vidsy-web-media-remux/fixtures-full

tools/media-remux/run-matrix.sh
```

`run-matrix.sh` uses the production WebAssembly variant for executable plans
and system `ffprobe` as the independent probe. DRM and missing-track behavior
are included through the planner and artifact suites invoked by the matrix.

