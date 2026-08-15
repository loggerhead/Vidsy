#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="${1:-"$root_dir/tools/media-remux/fixtures/generated"}"

command -v ffmpeg >/dev/null || {
  echo "ffmpeg is required to generate media-remux fixtures" >&2
  exit 1
}
command -v ffprobe >/dev/null || {
  echo "ffprobe is required to inspect media-remux fixtures" >&2
  exit 1
}

mkdir -p "$fixture_dir"
mkdir -p "$fixture_dir/hls-fmp4" "$fixture_dir/dash"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=1000:sample_rate=48000:duration=2' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 \
  -c:a aac -b:a 96k -f mpegts \
  "$fixture_dir/hls-ts-h264.ts"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=1200:sample_rate=48000:duration=2' \
  -c:v libx265 -preset ultrafast \
  -x265-params 'log-level=error:keyint=24:min-keyint=24:no-scenecut=1' \
  -pix_fmt yuv420p -c:a aac -b:a 96k -f mpegts \
  "$fixture_dir/hls-ts-hevc.ts"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=1400:sample_rate=48000:duration=2' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 \
  -c:a aac -b:a 96k -hls_time 1 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$fixture_dir/hls-fmp4/segment-%02d.m4s" \
  "$fixture_dir/hls-fmp4/playlist.m3u8"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=1600:sample_rate=48000:duration=2' \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 \
  -c:a aac -b:a 96k -seg_duration 1 -use_template 1 -use_timeline 1 \
  -adaptation_sets 'id=0,streams=v id=1,streams=a' \
  -f dash "$fixture_dir/dash/manifest.mpd"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=1800:sample_rate=48000:duration=2' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 \
  -c:a aac -b:a 96k "$fixture_dir/direct.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 -an \
  "$fixture_dir/separate-video.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'sine=frequency=2000:sample_rate=48000:duration=2' \
  -vn -c:a aac -b:a 96k "$fixture_dir/separate-audio.m4a"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=2' \
  -f lavfi -i 'sine=frequency=2200:sample_rate=48000:duration=2' \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 350k \
  -c:a libopus -b:a 96k "$fixture_dir/vp9-opus.webm"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'sine=frequency=2400:sample_rate=48000:duration=2' \
  -c:a pcm_s16le "$fixture_dir/audio-source.wav"

head -c 4096 "$fixture_dir/hls-ts-h264.ts" > "$fixture_dir/truncated.ts"
: > "$fixture_dir/empty.bin"

for fixture in \
  "$fixture_dir"/*.ts \
  "$fixture_dir"/*.mp4 \
  "$fixture_dir"/*.m4a \
  "$fixture_dir"/*.webm \
  "$fixture_dir"/*.wav; do
  ffprobe -v error \
    -show_entries format=format_name,duration,size \
    -show_entries stream=index,codec_name,codec_type,codec_tag_string \
    -of json "$fixture" > "$fixture.probe.json"
done

echo "Generated fixtures in $fixture_dir"
