#!/usr/bin/env bash
set -euo pipefail

MATCH_ID="${1:-}"
INPUT_URL="${2:-}"

if [[ -z "$MATCH_ID" || -z "$INPUT_URL" ]]; then
  echo "usage: start_match.sh <match_id> <input_url>"
  exit 1
fi

if [[ ! "$MATCH_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "invalid match_id"
  exit 1
fi

PID_DIR="/tmp/ffmpeg-pids"
OUT_DIR="/srv/hls/${MATCH_ID}"
PID_FILE="${PID_DIR}/${MATCH_ID}.pid"
LOG_FILE="${OUT_DIR}/ffmpeg.log"

mkdir -p "$PID_DIR" "$OUT_DIR"

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "match ${MATCH_ID} already running with pid ${PID}"
    exit 0
  fi
fi

nohup ffmpeg -hide_banner -loglevel warning -nostdin \
  -fflags +genpts -i "$INPUT_URL" \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -g 50 -keyint_min 50 -sc_threshold 0 \
  -c:a aac -ar 48000 -b:a 128k \
  -f hls \
  -hls_time 2 \
  -hls_list_size 180 \
  -hls_flags append_list+omit_endlist+independent_segments \
  -hls_segment_filename "${OUT_DIR}/seg_%06d.ts" \
  "${OUT_DIR}/stream.m3u8" \
  >"$LOG_FILE" 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"
echo "started match=${MATCH_ID} pid=${PID}"
