#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_dir="${LIBAVJS_SOURCE_DIR:-"$root_dir/.cache/libav.js"}"
tag="${LIBAVJS_TAG:-v6.8.8.0}"
libav_commit="1b7a07deed8f2fd63e8a7cb761fb50eebb3f31c2"
variant="web-media-remux-cli"
config_file="$root_dir/tools/media-remux/libav-web-media-remux.json"
jsfetch_patch="$root_dir/tools/media-remux/libav-jsfetch-offset.diff"
output_dir="$root_dir/chrome-extension/public/libav"
libav_version="6.8.8.0"
libxml2_version="2.13.8"
libxml2_sha256="277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a"

for command_name in git make node pkg-config; do
  command -v "$command_name" >/dev/null || {
    echo "$command_name is required to build the libav.js variant" >&2
    exit 1
  }
done
command -v emcc >/dev/null || {
  echo "Emscripten 4.0.5 is required; activate it before running this script" >&2
  exit 1
}
emcc_version="$(emcc --version | head -n 1)"
if [[ "$emcc_version" != *"4.0.5"* ]]; then
  echo "Emscripten 4.0.5 is required, got: $emcc_version" >&2
  exit 1
fi

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone --depth 1 --branch "$tag" https://github.com/Yahweasel/libav.js.git "$source_dir"
fi

actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
tag_commit="$(git -C "$source_dir" rev-list -n 1 "$tag")"
if [[ "$tag_commit" != "$libav_commit" ]]; then
  echo "libav.js tag $tag resolved to unexpected commit $tag_commit (expected $libav_commit)" >&2
  exit 1
fi
if [[ "$actual_commit" != "$libav_commit" ]]; then
  echo "libav.js source must be checked out at $tag ($libav_commit), got $actual_commit" >&2
  exit 1
fi

for makefile in "$source_dir/mk/ffmpeg.mk" "$source_dir/mk/ffmpeg.mk.m4"; do
  if ! grep -q -- '--ar=emar' "$makefile"; then
    sed -i.bak 's/--cc=emcc --ranlib=emranlib/--cc=emcc --ar=emar --ranlib=emranlib/' "$makefile"
    rm -f "$makefile.bak"
  fi
done

jsfetch_patch_name="12-jsfetch-offset.diff"
install -m 0644 "$jsfetch_patch" "$source_dir/patches/ffmpeg/$jsfetch_patch_name"
for series_file in "$source_dir/patches/ffmpeg/series8"; do
  if ! grep -qx "$jsfetch_patch_name" "$series_file"; then
    printf '%s\n' "$jsfetch_patch_name" >> "$series_file"
  fi
done

libxml2_archive="$source_dir/build/libxml2-$libxml2_version.tar.xz"
libxml2_source="$source_dir/build/libxml2-$libxml2_version"
install_prefix="$source_dir/build/inst/base"
if [[ ! -f "$libxml2_archive" ]]; then
  curl -L \
    "https://download.gnome.org/sources/libxml2/2.13/libxml2-$libxml2_version.tar.xz" \
    -o "$libxml2_archive"
fi
echo "$libxml2_sha256  $libxml2_archive" | shasum -a 256 -c -
if [[ ! -d "$libxml2_source" ]]; then
  tar -C "$source_dir/build" -xf "$libxml2_archive"
fi
if [[ ! -f "$install_prefix/lib/pkgconfig/libxml-2.0.pc" ]]; then
  mkdir -p "$libxml2_source/build-base"
  (
    cd "$libxml2_source/build-base"
    emconfigure ../configure \
      --prefix="$install_prefix" \
      --host=mipsel-sysv \
      --disable-shared \
      --without-http \
      --without-ftp \
      --without-python \
      --without-lzma \
      --without-zlib \
      --without-iconv \
      CFLAGS="-Oz"
    make install
  )
fi

fragment_dir="$source_dir/configs/fragments/libxml2"
mkdir -p "$fragment_dir"
cat > "$fragment_dir/deps.txt" <<'EOF'
build/inst/@TARGET/lib/pkgconfig/libxml-2.0.pc
EOF
cat > "$fragment_dir/ffmpeg-config.txt" <<'EOF'
--enable-libxml2
EOF
cat > "$fragment_dir/libs.txt" <<'EOF'
build/inst/@TARGET/lib/libxml2.a
EOF
cat > "$fragment_dir/license.js" <<'EOF'
 *
 * ---
 *
 * libxml2:
 *
 * Copyright (C) 1998-2012 Daniel Veillard.
 * All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
EOF

config_json="$(tr -d '\n' < "$config_file")"
(
  cd "$source_dir/configs"
  ./mkconfig.js "$variant" "$config_json"
)

(
  cd "$source_dir"
  make \
    "dist/libav-$libav_version-$variant.mjs" \
    "dist/libav-$libav_version-$variant.wasm.mjs"
)

mkdir -p "$output_dir"
for suffix in mjs wasm.mjs wasm.wasm; do
  install -m 0644 \
    "$source_dir/dist/libav-$libav_version-$variant.$suffix" \
    "$output_dir/libav-$libav_version-$variant.$suffix"
done

echo "Built and installed $variant from libav.js $tag ($actual_commit)"
