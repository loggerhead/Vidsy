# Web media remux release validation

This report records the release evidence for the goal routed by
`docs/goal/00-index.md`. Measurements and validation were run on 2026-08-14.

## Reproducible build

- libav.js: `v6.8.8.0`,
  commit `1b7a07deed8f2fd63e8a7cb761fb50eebb3f31c2`
- Emscripten: `4.0.5`
- libxml2: `2.13.8`, SHA-256
  `277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a`
- Variant: `web-media-remux-cli`
- Configuration: `tools/media-remux/libav-web-media-remux.json`
- Reproducible source patch:
  `tools/media-remux/libav-jsfetch-offset.diff`
- Build command: `tools/media-remux/build-libav.sh`

The build script hard-fails when the Emscripten version, libav.js tag/commit,
or libxml2 checksum differs.

## Functional matrix

`tools/media-remux/run-matrix.sh` passes all 12 required IDs:

`HLS-TS-H264`, `HLS-TS-HEVC`, `HLS-FMP4`, `DASH-AV`, `HTTP-MP4`,
`MERGED-AV`, `WEBM-VP9`, `AUDIO-MP3`, `DRM`, `EMPTY`, `TRUNCATED`, and
`MISSING-TRACK`.

Successful files are probed by system `ffprobe`, independent of the libav.js
instance that produced them. The TypeScript artifact parser separately
validates MP4/fMP4, WebM, and MP3 structure and rejects truncation and required
track loss.

## Production extension E2E

The production `dist/` build was loaded into an isolated Chrome for Testing
profile. A local generic fixture page triggered network detection; the popup
displayed the HLS item; clicking Download ran the production
descriptor/planner/executor; success was recorded only after
`chrome.downloads` reported `complete`.

Result:

- Chrome: Chrome for Testing `151.0.7922.34`
- Detection: generic network HLS, no site-specific branch
- Disk file: 84,684 bytes
- Independent probe: MP4, HEVC video + AAC audio, 2.026667 seconds
- Final extension state: `success`, browser download ID `1`

## Performance and resources

### Method

`tools/media-remux/run-browser-benchmark.mjs` extracts the old production
variant from Git without modifying the worktree, then loads old and new
variants in the same Chrome binary against the same generated H.264 + AAC
MPEG-TS fixture. Five rounds alternate AB/BA order. Every round records cold
and hot runs. Writer callbacks provide first-byte timing; 5 ms sampling and
the Emscripten heap expose peak JS heap delta and WASM heap. Logging inside the
measured path is disabled.

Environment:

- Apple silicon macOS
- Chrome for Testing `151.0.7922.34`
- Input: 191,948-byte H.264 + AAC MPEG-TS, 2.021333 seconds
- Rounds: 5, alternating old/new by round

All values below are median / worst.

| Metric | Old cold | New cold | Old hot | New hot |
| --- | ---: | ---: | ---: | ---: |
| Module load + worker initialization | 24.3 / 29.7 ms | 19.7 / 24.9 ms | 11.4 / 16.8 ms | 10.9 / 12.2 ms |
| LibAV initialization only | 22.8 / 27.1 ms | 17.8 / 23.0 ms | 11.3 / 16.8 ms | 10.8 / 12.2 ms |
| First output byte | 3.6 / 25.5 ms | 1.9 / 17.0 ms | 3.3 / 4.2 ms | 2.0 / 2.5 ms |
| Total H.264 remux | 4.8 / 33.0 ms | 3.0 / 24.0 ms | 4.7 / 6.4 ms | 3.1 / 3.9 ms |
| Peak JS heap delta | 2,404,831 / 2,428,239 B | 2,421,876 / 2,607,671 B | 1,696,978 / 1,716,628 B | 1,572,196 / 1,616,364 B |
| Peak WASM heap | 30,212,096 B | 25,165,824 B | 30,212,096 B | 25,165,824 B |

The hot H.264 median changed from 4.7 ms to 3.1 ms, a 34.0% reduction rather
than a regression. The first cold round includes one-time browser noise for
both variants; medians and alternating order are the release decision inputs.

### Size

Sizes use exact bytes. Gzip uses reproducible `gzip -9 -n`.

| Artifact | Old | New | Difference |
| --- | ---: | ---: | ---: |
| Raw WASM | 4,359,295 B | 3,374,171 B | -985,124 B (-22.6%) |
| Gzipped WASM | 1,649,232 B | 1,319,388 B | -329,844 B (-20.0%) |
| Production extension zip | n/a | 3,507,999 B | 3.35 MiB |

The 3.35 MiB package is below the commonly reviewed 10 MiB guidance and far
below the Chrome Web Store upload ceiling. More importantly, all executable
code, including the WASM and loaders, is packaged locally; no remotely hosted
code is fetched or executed.

### Temporary storage

For the benchmark fixture, direct `jsfetch` writes only the 177,035-byte
output, a 0.922x output/input temporary ratio. Authenticated prefetch paths
hold input plus output until handoff, approximately 1.922x for the same
fixture. No additional input-sized JS heap copy is introduced.

## Failure injection

| Required failure | Evidence |
| --- | --- |
| Playlist 401/403/404/416/5xx | `hls-request.test.ts` |
| Init/media/direct response 401/403/404/416/5xx | shared `assertSuccessfulResponse` and `response-validation.test.ts` |
| Empty response/output | matrix `EMPTY`, `assertNonEmptyOutput` |
| Content-Length mismatch | `assertCompleteResponse` tests empty and short bodies |
| Segment mid-stream disconnect | stream reader error propagates through worker cleanup; short declared bodies are rejected by `assertCompleteResponse` |
| OPFS space exhaustion | `opfs.test.ts` injects `QuotaExceededError`; size does not advance |
| Worker terminate/message corruption | worker error handlers reject and clear every pending RPC; `pending-worker-jobs.test.ts` |
| LibAV non-zero exit | `output-validation.test.ts`; matrix empty/truncated paths |
| `onwrite` stall | `opfs.test.ts` injects a zero-byte write and expects a stable failure |
| Truncated output | matrix `TRUNCATED`; `output-artifact.test.ts` |
| Browser download interrupted | `browser-download-state.test.ts`; only `complete` is success |
| Cleanup delayed/duplicated | `blob-cleanup.test.ts` proves idempotent one-time removal |
| Cleanup message lost | `opfs-gc.test.ts` proves startup orphan recovery |

All these paths terminate as failure/cancel or deferred cleanup. None can
create a success history entry before artifact validation and browser
`complete`.

## Architecture and security audit

- `MediaDescriptor` facts come from manifest metadata, initialization/media
  probes, or content type—not hostnames or URL codec tokens.
- `planMediaProcessing` is the only codec/container decision authority.
- Worker messages carry structured executable plans and input descriptors,
  never caller-provided FFmpeg argument arrays.
- Video plans are stream-copy only. MP3 is the sole transcode path.
- Artifact validation is independent of the production WASM.
- Production build contains only `web-media-remux-cli`; the old variant and
  temporary spike message endpoint are absent.
- No runtime fallback returns to an old media path.
- Download logging recursively strips URL credentials/query/fragment, request
  headers, cookies, authorization, referer/origin, tokens, and blob URLs.
  Worker logs report only plan type, input count/format, output container,
  byte counts, exit code, and error class.

## Licensing and release review

`chrome-extension/public/libav/NOTICE.md`, `LICENSE.LGPL-2.1`, and the generated
loader cover FFmpeg, libav.js, LAME, Opus, libxml2, and Emscripten glue. The
NOTICE documents source locations, replacement/relinking, the pinned rebuild,
and H.264/HEVC patent considerations. The production zip includes NOTICE,
LGPL text, wrapper, loader, and WASM.

The release owner must still make the jurisdiction-specific HEVC patent and
store-listing decision; this engineering validation does not provide legal
advice.

## Release gates

- Required 12-case matrix: pass
- Focused TypeScript tests: pass, 48/48
- Chrome extension and storage type checks: pass
- Production monorepo build: pass
- Production zip: pass
- Generic HEVC extension E2E: pass
- H.264 performance budget: pass, no >15% stable regression
- Package/memory budget: pass, both raw/gzip WASM and WASM heap decreased
- Sensitive logging and architecture scan: pass
- Full monorepo `pnpm type-check`: blocked by pre-existing
  `packages/ui` unresolved `@/lib/components/*` and `@/lib/utils` aliases as
  consumed by `pages/content-runtime`, `pages/new-tab`, and
  `pages/side-panel`, plus the existing side-panel `MediaSettings` storage
  type drift; the goal-related Chrome extension and storage packages pass
  independently.

