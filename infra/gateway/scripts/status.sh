#!/usr/bin/env bash
set -euo pipefail

PID_DIR="/tmp/ffmpeg-pids"
mkdir -p "$PID_DIR"

is_match_pid() {
  local pid="$1"
  local match_id="$2"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local cmd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmd" == *"ffmpeg"* && "$cmd" == *"/srv/hls/${match_id}/stream.m3u8"* ]]
}

for file in "$PID_DIR"/*.pid; do
  [[ -e "$file" ]] || { echo "no running matches"; exit 0; }
  match_id=$(basename "$file" .pid)
  pid=$(cat "$file")
  if kill -0 "$pid" 2>/dev/null && is_match_pid "$pid" "$match_id"; then
    echo "$match_id RUNNING pid=$pid output=/srv/hls/$match_id/stream.m3u8"
  else
    echo "$match_id STALE pid=$pid"
  fi
done
