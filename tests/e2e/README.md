# End-to-end tests

This suite runs with Vitest and Midscene's `PlaywrightAgent` against the built Chromium extension. Tests keep deterministic assertions for titles, DOM state, and downloaded files. Midscene handles visual assertions and the theme/download UI actions.

## Setup

```sh
pnpm install
pnpm --filter @extension/e2e exec playwright install chromium
```

Configure a vision-capable model using Midscene's [model configuration](https://midscenejs.com/model-config). For example:

```sh
export MIDSCENE_MODEL_BASE_URL="https://your-provider.example/v1"
export MIDSCENE_MODEL_API_KEY="your-key"
export MIDSCENE_MODEL_NAME="your-vision-model"
export MIDSCENE_MODEL_FAMILY="your-model-family"
pnpm e2e
```

`pnpm e2e` builds the unpacked extension, then runs the suite. Set `VIDSY_E2E_AI=off` to run only deterministic checks without a model. Set `VIDSY_E2E_HEADED=true` to show Chromium.

The four real-site download cases (Bilibili, X, AcFun, and YouTube) are opt-in because they download media and depend on external sites. To enable them, set `VIDSY_LIVE_DOWNLOAD_E2E=true` and `VIDSY_E2E_DOWNLOAD_DIR` to a dedicated test directory. Each case checks that its completed video file is at least 1 MiB, then deletes that file. Set `VIDSY_KEEP_E2E_ARTIFACTS=1` to leave the downloaded files in that directory for manual inspection. Bilibili requires `VIDSY_E2E_PROFILE_DIR` to point to a dedicated logged-in profile. X accepts either that profile or `VIDSY_E2E_X_COOKIES_FILE`. AcFun runs without login state.

If a site requires login, create a dedicated persistent test profile:

```sh
pnpm build
pnpm e2e:login https://www.bilibili.com/video/BV1j5nj68E48
pnpm e2e:login https://x.com/HiTw93/status/2101676087222964545
# For each command, log in in the browser, then press Enter in the terminal.
VIDSY_E2E_PROFILE_DIR=.e2e-private/profile VIDSY_E2E_HEADED=true \
  VIDSY_E2E_DOWNLOAD_DIR=.e2e-downloads VIDSY_LIVE_DOWNLOAD_E2E=true \
  VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run \
  --config vitest.config.ts specs/live-download-sites.test.ts -t 'Bilibili|X downloads|AcFun'
```

`pnpm e2e:login` defaults to `.e2e-private/profile`; set `VIDSY_E2E_PROFILE_DIR` on both commands if you choose another directory. Keep that profile private and do not run login and tests against it at the same time. A second command using a profile that is still open now fails immediately with the Chromium process ID; close the first browser before retrying.

If Google sign-in is rejected in automated Chromium, copy the request Cookie header from your normal logged-in Chrome session:

1. Open the target X post in Chrome. Open DevTools (`Option` + `Command` + `I`), select **Network**, then reload the page.
2. Select the main `x.com` document request. Under **Headers > Request Headers**, copy only the `cookie` value. It should contain `auth_token=`. Do not use `document.cookie`: it omits HttpOnly cookies.
3. Save the value as `.e2e-private/x-cookies.json` in this repository:

```json
{"cookieHeader":"auth_token=...; ct0=...; ..."}
```

Keep the actual Cookie header on one JSON line. If it contains a double quote or backslash, escape that character for JSON. The file is git-ignored; do not paste its contents into chat or commit it. Close any `pnpm e2e:login` browser using the same profile, then run:

```sh
VIDSY_E2E_X_COOKIES_FILE=.e2e-private/x-cookies.json \
  VIDSY_E2E_DOWNLOAD_DIR=.e2e-downloads VIDSY_LIVE_DOWNLOAD_E2E=true \
  VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run \
  --config vitest.config.ts specs/live-download-sites.test.ts -t 'X downloads'
```

The test imports those cookies into its temporary Chromium profile. Cookie expiry or an X security challenge can still require a fresh copy. To run Bilibili and X together, also set `VIDSY_E2E_PROFILE_DIR` to the Bilibili login profile. Use a profile with the current extension build and keep it closed during the test run.

The HEVC remux case replaces the former standalone `run-extension-e2e.mjs`. It prepares an HLS TS fixture at `.media-test/fixtures/hls-ts-hevc.ts` (or under `VIDSY_MEDIA_FIXTURES`) and requires `ffmpeg` and `ffprobe` on `PATH`. Enable it with `VIDSY_MEDIA_REMUX_E2E=true`. Its downloaded output is checked for HEVC video and AAC audio, then removed unless `VIDSY_KEEP_E2E_ARTIFACTS=1`; `VIDSY_EXTENSION_E2E_OUTPUT` copies it to a requested path. `VIDSY_EXTENSION_DIR` can target another unpacked build.

The former Firefox command has been removed. Midscene's Playwright web integration recommends Chromium for CDP features, and Playwright's extension fixture loads unpacked extensions in Chromium. Firefox extension coverage needs a separate supported adapter before it can run in this suite.


## Download regression checks

`pnpm --filter chrome-extension test` prepares deterministic media under `.media-test/` before running unit tests. Preparation requires `ffmpeg` and `ffprobe`; it no longer depends on files from an earlier `/tmp` session. You can also run `node tools/media-remux/prepare-test-media.mjs` from the repository root. The generated native outputs are inputs for container-validation tests, not proof of libav or browser acceptance.

Run the production extension pipeline and HEVC checks with:

```sh
pnpm build
VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true \
  pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts \
  specs/download-pipeline.test.ts specs/media-remux.test.ts
```

The pipeline suite checks HTTP, HLS, DASH, separate audio/video, real popup pause/retry and side-panel resume, Range resume, ignored-Range fallback, cancellation, configured concurrency, same-CDN credential isolation, cross-origin credential forwarding, background recovery and terminal record cleanup. Background recovery checks that a global marker disappears after stopping the worker, rather than assuming a CDP stop command succeeded. One boundary case injects latency before the real browser downloads query to make artifact pause/resume deterministic; it does not replace the returned browser result.

Additional HLS orchestration checks run with:

```sh
node --import tsx --experimental-test-module-mocks --test \
  chrome-extension/src/offscreen/lib/hls-download.test.mjs \
  chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs
```

Paused tasks retain their resume data. “Clear finished” removes succeeded, failed and cancelled runtime/progress entries; explicitly removing a paused entry first cancels it and releases its files. Download history remains separate. New downloads use fresh request IDs; resume/retry reuse the persisted selected source and audio pair.

Byte-range resume requires a matching strong ETag, file size and range layout; otherwise the download safely starts again. Authenticated downloads run exclusively while their headers may be required; public downloads use the configured concurrency. Unencrypted HLS parts stage on disk with an eight-part dispatch window; encrypted parts have an explicit 32 MiB per-part buffer limit.

The queue uses a Chrome alarm to retry an unknown executor outcome after 30 seconds, including when the service worker has suspended. Missing native download records become explicit failures and release their queue slots. Download-list entries stay until explicitly cleared; completed command snapshots are released. History changes from popup, side panel and options all go through one background writer.

HTTP Range resume also covers separate video/audio tracks. A native-save pause retains the completed OPFS artifact; resume starts a new local browser copy and does not refetch the source. HLS/DASH fetches restart when there is no verified per-resource checkpoint. A background restart retains the offscreen worker and its checkpoints. Losing the offscreen worker discards those checkpoints, so reconciliation restarts source fetching. A full browser restart or extension reload clears the session queue; startup GC removes orphaned files.

HLS byte-range playlists retain initialization and segment offsets and reject incorrect Range responses; implicit offsets follow [RFC 8216 section 4.3.2.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.2). Unknown-length descriptor probes consume at most 256 KiB before cancelling the body. The browser tests cover exact single-resource HLS assembly, ignored initialization ranges, and authenticated DASH with inherited BaseURL and a finite negative-repeat timeline. Changing HLS initialization sections and multiple DASH periods are explicitly rejected by the prefetch path, rather than silently producing partial output.
