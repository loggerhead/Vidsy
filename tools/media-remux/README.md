# Live media download diagnostics

The Bilibili diagnostic launches a fresh Chrome profile, loads the unpacked
extension, attaches to the page and Vidsy service worker, and writes a JSONL
trace containing page state, console errors, network requests, detections,
download progress, and the final Chrome download record.

Use Chrome for Testing or Chromium. Branded Google Chrome ignores
`--load-extension` when launched from the command line.

```sh
pnpm zip
CHROME_BIN='/absolute/path/to/Google Chrome for Testing' \
  VIDSY_BILIBILI_AUTO_DOWNLOAD=0 \
  VIDSY_BILIBILI_KEEP_ARTIFACTS=1 \
  node tools/media-remux/run-bilibili-diagnostic.mjs
```

Set `VIDSY_BILIBILI_AUTO_DOWNLOAD=0` to validate detection and variant count
first. The default also clicks the content UI Download button, follows the
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
