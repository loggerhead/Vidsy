# Third-party components bundled in this extension

The files named `libav-6.8.8.0-web-media-remux-cli.*` in this directory are
a reproducible WebAssembly build produced from the repository configuration
in `tools/media-remux/`. They bundle the following components:

## Bundled components

- **FFmpeg** (libavformat, libavcodec, libavutil, libswscale, libswresample, etc.)
  — LGPL-2.1-or-later.
  Upstream: https://ffmpeg.org/
  Source: https://ffmpeg.org/releases/

- **libmp3lame** (LAME MP3 encoder 3.100)
  — LGPL-2.1-or-later.
  Upstream: https://lame.sourceforge.io/
  Source: https://lame.sourceforge.io/download.php

- **libopus** (Opus audio codec library)
  — 3-Clause BSD.
  Upstream and source: https://github.com/xiph/opus

- **libxml2** (XML parser 2.13.8)
  — MIT.
  Upstream and source: https://gitlab.gnome.org/GNOME/libxml2

- **libav.js** (compilation toolchain + JS glue; Yahweasel/libav.js 6.8.8.0,
  commit `1b7a07deed8f2fd63e8a7cb761fb50eebb3f31c2`)
  — 2-Clause BSD (glue) / LGPL-2.1 (bundled FFmpeg).
  Upstream: https://github.com/Yahweasel/libav.js
  Source: https://github.com/Yahweasel/libav.js/tree/v6.8.8.0

## License

The FFmpeg and libmp3lame portions are distributed under the terms of the GNU
Lesser General Public License, version 2.1 or later. The full license text is
in `LICENSE.LGPL-2.1` in this directory. libopus and libxml2 retain their
permissive license notices in the generated JavaScript glue.

Under LGPL-2.1 you are entitled to:
- obtain the complete corresponding source code for the bundled libraries
  (see the upstream source URLs above),
- relink the WebAssembly binary against a modified version of any of the
  bundled LGPL libraries.

The `.wasm` binary is installed as a standalone file rather than embedded in
the extension JavaScript, so it can be replaced by a compatible user build.

## Patent note — H.264 and HEVC

This bundle includes H.264 and HEVC parsers used for stream-copy remuxing.
Those standards may be covered by patents in some jurisdictions. Consult
local counsel before distribution. No H.264 or HEVC video encoder or decoder
is included, and the extension does not transcode video.

## Patent note — MP3

The MP3 (MPEG-1/2 Audio Layer III) patents expired worldwide by 2017. No
active patent claims apply to libmp3lame redistribution at this time.

## How to rebuild

Install Emscripten 4.0.5, activate its environment, install `pkg-config`, and
run:

```sh
tools/media-remux/build-libav.sh
```

The script requires Emscripten 4.0.5, pins libav.js tag `v6.8.8.0` and commit
`1b7a07deed8f2fd63e8a7cb761fb50eebb3f31c2`, verifies the libxml2 archive
checksum, applies the documented `jsfetch` offset patch, builds the
`web-media-remux-cli` configuration, and installs the wrapper, WebAssembly
loader, and `.wasm` binary in this directory. The exact enabled formats,
parsers, filters, and sole MP3 encoder are declared in
`tools/media-remux/libav-web-media-remux.json`.
