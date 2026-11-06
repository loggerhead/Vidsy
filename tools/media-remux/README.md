# Live media download diagnostics

## Large-file libav regression

Build the pinned runtime with Emscripten 4.0.5 activated, then test the installed
runtime:

```sh
bash tools/media-remux/build-libav.sh
node tools/media-remux/test-libav-large-offsets.mjs
```

The regression checks the actual WASM import signatures and generated JavaScript
bridge, then runs FFmpeg stream copy against sparse HTTP MP4 files with metadata
beyond 2 GiB, the ATID failure offset, 4 GiB, and 5 GiB. It verifies successful
output, large positive Range offsets, bounded transferred bytes, and absence of
requests at or beyond EOF. The fixture is `.media-test/fixtures/direct.mp4`.
This tests large input positions without allocating or downloading gigabytes;
it does not measure sustained large-file throughput or replay an authenticated
live source.

The Bilibili diagnostic launches a fresh Chrome profile, loads the current WXT
unpacked output from `.output/chrome-mv3`, attaches to the page and Vidsy service worker, and writes a JSONL
trace containing page state, console errors, network requests, detections,
download progress, and the final Chrome download record.
Set `VIDSY_EXTENSION_DIR` only when intentionally validating another unpacked
artifact. The legacy `dist/` directory is not a valid default.

Use Chrome for Testing or Chromium. Branded Google Chrome ignores
`--load-extension` when launched from the command line.

```sh
pnpm zip
CHROME_BIN='/absolute/path/to/Google Chrome for Testing' \
  VIDSY_BILIBILI_AUTO_DOWNLOAD=0 \
  VIDSY_BILIBILI_KEEP_ARTIFACTS=1 \
  node tools/media-remux/run-bilibili-diagnostic.mjs
```

Set `VIDSY_BILIBILI_AUTO_DOWNLOAD=0` to validate that detection produces a
fetchable video track paired with audio and at least one structured variant.
The available quality count varies by account and Bilibili's current player
selection, so it is intentionally not a pass/fail criterion. The default also
clicks the content UI Download button, follows the
stable item id through service-worker progress, and checks the downloaded file
size.

To test an authenticated page, use a dedicated private Chrome profile. Log in
to Bilibili once with that profile, then pass its absolute path through
`VIDSY_BILIBILI_PROFILE`. Do not use a profile that is open in another Chrome
process, and do not commit it; `.e2e-private` is ignored.

```sh
VIDSY_BILIBILI_PROFILE='/absolute/path/to/private/profile' \
  CHROME_BIN='/absolute/path/to/Google Chrome for Testing' \
  node tools/media-remux/run-bilibili-diagnostic.mjs
```

Reports are written under `.e2e-artifacts/<run-id>/events.jsonl`.

## Detection lifecycle invariant

Network capture starts at navigation start, not at page `complete`. Players
can consume their only byte-zero DASH/fMP4 initialization ranges while the
document is still loading. The tab lifecycle therefore gives the replacement
document a new capture generation immediately, queues early response handling
behind old-generation cleanup, and starts DOM-backed content scripts only when
the page is ready. Do not collapse capture readiness and DOM readiness into a
single `isRunning` check.

The fMP4 probe cache is scoped to the same tab lifecycle and must be cleared on
navigation. Otherwise a reload that reuses a signed media URL can never be
probed again. `tab-work-lifecycle.test.ts` is the regression gate for the early
capture/cleanup ordering; the live Bilibili diagnostic is the end-to-end gate.

An fMP4 track's parsed sample entry and handler are also the authority for its
codec and media type. CDN `Content-Type` values such as
`application/octet-stream` are only transport metadata. Whenever detection
learns a new stream-copy codec, keep the descriptor probe, processing
capabilities, planner, and output-artifact validator in sync; a detector-only
codec addition creates a candidate that can never complete a download.

Compact quality badges use conventional rendition tiers (for example,
`1920×1018` is labelled `1080p` and `854×452` is labelled `480p`). Exact coded
dimensions remain available in variant details and must not be rewritten in
the media model.
