#!/usr/bin/env bash
set -euo pipefail

PID_DIR="/tmp/ffmpeg-pids"
mkdir -p "$PID_DIR"

for file in "$PID_DIR"/*.pid; do
  [[ -e "$file" ]] || { echo "no running matches"; exit 0; }
  match_id=$(basename "$file" .pid)
  pid=$(cat "$file")
  if kill -0 "$pid" 2>/dev/null; then
    echo "$match_id RUNNING pid=$pid output=/srv/hls/$match_id/stream.m3u8"
  else
    echo "$match_id STALE pid=$pid"
  fi
done
