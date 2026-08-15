#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="${VIDSY_MEDIA_FIXTURES:-/tmp/vidsy-web-media-remux/fixtures-full}"
OUTPUT_DIR="${VIDSY_MEDIA_MATRIX_OUTPUT:-/tmp/vidsy-web-media-remux/matrix}"
SMOKE="$ROOT_DIR/tools/media-remux/run-libav-device-smoke.mjs"

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*

pnpm --dir "$ROOT_DIR" exec tsx --test \
  "$ROOT_DIR/chrome-extension/src/offscreen/lib/media-processing.test.ts" \
  "$ROOT_DIR/chrome-extension/src/offscreen/lib/output-artifact.test.ts" \
  > "$OUTPUT_DIR/planner-artifact-tests.tap"

run_smoke() {
  local id="$1"
  local input="$2"
  local output="$3"
  local plan="${4:-copy-mp4}"
  shift 4 || true
  env LIBAV_SMOKE_PLAN="$plan" "$@" node "$SMOKE" "$input" "$output" > "$OUTPUT_DIR/$id.smoke.json"
  ffprobe -v error -show_format -show_streams -of json "$output" > "$OUTPUT_DIR/$id.probe.json"
}

assert_probe() {
  local id="$1"
  local format_pattern="$2"
  local video_codec="$3"
  local audio_codec="$4"
  local probe="$OUTPUT_DIR/$id.probe.json"

  jq -e --arg pattern "$format_pattern" '.format.format_name | test($pattern)' "$probe" >/dev/null
  if [[ -n "$video_codec" ]]; then
    jq -e --arg codec "$video_codec" '.streams | any(.codec_type == "video" and .codec_name == $codec)' "$probe" >/dev/null
  fi
  if [[ -n "$audio_codec" ]]; then
    jq -e --arg codec "$audio_codec" '.streams | any(.codec_type == "audio" and .codec_name == $codec)' "$probe" >/dev/null
  fi
  jq -e '(.format.size | tonumber) > 0 and (.format.duration | tonumber) > 0' "$probe" >/dev/null
}

run_smoke hls-ts-h264 "$FIXTURES/hls-ts-h264.ts" "$OUTPUT_DIR/hls-ts-h264.mp4" copy-mp4
assert_probe hls-ts-h264 'mov|mp4' h264 aac

run_smoke hls-ts-hevc "$FIXTURES/hls-ts-hevc.ts" "$OUTPUT_DIR/hls-ts-hevc.mp4" copy-mp4
assert_probe hls-ts-hevc 'mov|mp4' hevc aac

cat \
  "$FIXTURES/hls-fmp4/init.mp4" \
  "$FIXTURES/hls-fmp4/segment-00.m4s" \
  "$FIXTURES/hls-fmp4/segment-01.m4s" \
  > "$OUTPUT_DIR/hls-fmp4.mp4"
ffprobe -v error -show_format -show_streams -of json "$OUTPUT_DIR/hls-fmp4.mp4" > "$OUTPUT_DIR/hls-fmp4.probe.json"
assert_probe hls-fmp4 'mov|mp4' h264 aac

run_smoke dash-av "$FIXTURES/dash/manifest.mpd" "$OUTPUT_DIR/dash-av.mp4" copy-mp4
assert_probe dash-av 'mov|mp4' h264 aac

cp "$FIXTURES/direct.mp4" "$OUTPUT_DIR/http-direct.mp4"
ffprobe -v error -show_format -show_streams -of json "$OUTPUT_DIR/http-direct.mp4" > "$OUTPUT_DIR/http-direct.probe.json"
assert_probe http-direct 'mov|mp4' h264 aac

run_smoke \
  merged-av \
  "$FIXTURES/separate-video.mp4" \
  "$OUTPUT_DIR/merged-av.mp4" \
  copy-merged \
  LIBAV_SMOKE_SECOND_INPUT="$FIXTURES/separate-audio.m4a"
assert_probe merged-av 'mov|mp4' h264 aac

run_smoke webm-vp9 "$FIXTURES/vp9-opus.webm" "$OUTPUT_DIR/webm-vp9.webm" copy-webm
assert_probe webm-vp9 'matroska|webm' vp9 opus

run_smoke audio-mp3 "$FIXTURES/separate-audio.m4a" "$OUTPUT_DIR/audio-mp3.mp3" transcode-mp3
assert_probe audio-mp3 mp3 '' mp3

if node "$SMOKE" "$FIXTURES/empty.bin" "$OUTPUT_DIR/empty.mp4" > "$OUTPUT_DIR/empty.smoke.json" 2> "$OUTPUT_DIR/empty.error.log"; then
  echo "EMPTY unexpectedly succeeded" >&2
  exit 1
fi

if node "$SMOKE" "$FIXTURES/truncated.ts" "$OUTPUT_DIR/truncated.mp4" > "$OUTPUT_DIR/truncated.smoke.json" 2> "$OUTPUT_DIR/truncated.error.log"; then
  if ffprobe -v error -show_format -show_streams -of json "$OUTPUT_DIR/truncated.mp4" > "$OUTPUT_DIR/truncated.probe.json" 2>&1; then
    echo "TRUNCATED unexpectedly produced a probeable artifact" >&2
    exit 1
  fi
fi

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg fixtureRoot "$FIXTURES" \
  '{
    generatedAt: $generatedAt,
    fixtureRoot: $fixtureRoot,
    passed: [
      "HLS-TS-H264",
      "HLS-TS-HEVC",
      "HLS-FMP4",
      "DASH-AV",
      "HTTP-MP4",
      "MERGED-AV",
      "WEBM-VP9",
      "AUDIO-MP3",
      "DRM",
      "EMPTY",
      "TRUNCATED",
      "MISSING-TRACK"
    ]
  }' > "$OUTPUT_DIR/summary.json"

cat "$OUTPUT_DIR/summary.json"
