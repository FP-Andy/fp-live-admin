#!/usr/bin/env bash
set -uo pipefail

INPUT_URL="${1:-}"
OUTPUT_PLAYLIST="${2:-}"
LOG_FILE="${3:-}"

if [[ -z "$INPUT_URL" || -z "$OUTPUT_PLAYLIST" || -z "$LOG_FILE" ]]; then
  echo "usage: run_ffmpeg.sh <input_url> <output_playlist> <log_file>"
  exit 1
fi

OUT_DIR="$(dirname "$OUTPUT_PLAYLIST")"
FFMPEG_VIDEO_MODE="${FFMPEG_VIDEO_MODE:-copy}"
FFMPEG_AUDIO_MODE="${FFMPEG_AUDIO_MODE:-copy}"
HLS_TIME="${HLS_TIME:-2}"
HLS_LIST_SIZE="${HLS_LIST_SIZE:-8}"
HLS_DELETE_THRESHOLD="${HLS_DELETE_THRESHOLD:-1}"
HLS_FLAGS="${HLS_FLAGS:-delete_segments+independent_segments+omit_endlist+temp_file}"

mkdir -p "$OUT_DIR"
touch "$LOG_FILE"

while true; do
  VIDEO_ARGS=(-c:v copy)
  if [[ "$FFMPEG_VIDEO_MODE" != "copy" ]]; then
    VIDEO_ARGS=(-c:v libx264 -preset veryfast -tune zerolatency -g 50 -keyint_min 50 -sc_threshold 0)
  fi

  AUDIO_ARGS=(-c:a copy)
  if [[ "$FFMPEG_AUDIO_MODE" == "aac" ]]; then
    AUDIO_ARGS=(-c:a aac -ar 48000 -b:a 128k)
  elif [[ "$FFMPEG_AUDIO_MODE" == "none" ]]; then
    AUDIO_ARGS=(-an)
  elif [[ "$FFMPEG_AUDIO_MODE" != "copy" ]]; then
    printf '%s invalid FFMPEG_AUDIO_MODE=%s; expected copy, aac, or none\n' "$(date -Iseconds)" "$FFMPEG_AUDIO_MODE" >>"$LOG_FILE"
    exit 1
  fi

  ffmpeg -hide_banner -loglevel warning -nostdin \
    -fflags +genpts \
    -thread_queue_size 2048 \
    -analyzeduration 32M -probesize 32M \
    -i "$INPUT_URL" \
    -map 0:v:0 -map 0:a? \
    "${VIDEO_ARGS[@]}" \
    "${AUDIO_ARGS[@]}" \
    -f hls \
    -hls_time "$HLS_TIME" \
    -hls_list_size "$HLS_LIST_SIZE" \
    -hls_delete_threshold "$HLS_DELETE_THRESHOLD" \
    -hls_allow_cache 0 \
    -hls_flags "$HLS_FLAGS" \
    -hls_segment_filename "${OUT_DIR}/seg_%06d.ts" \
    "$OUTPUT_PLAYLIST" \
    >>"$LOG_FILE" 2>&1

  exit_code=$?
  printf '%s ffmpeg exited code=%s for %s; retrying in 1s\n' "$(date -Iseconds)" "$exit_code" "$OUTPUT_PLAYLIST" >>"$LOG_FILE"
  sleep 1
done
