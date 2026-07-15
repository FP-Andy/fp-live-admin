#!/usr/bin/env bash
set -euo pipefail

PID_DIR="/tmp/ffmpeg-pids"
mkdir -p "$PID_DIR"

is_live_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local state
  state=$(awk '/^State:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
  [[ "$state" != "Z" ]] || return 1
}

is_runner_pid() {
  local pid="$1"
  local match_id="$2"
  is_live_pid "$pid" || return 1
  local cmd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmd" == *"/scripts/run_ffmpeg.sh"* && "$cmd" == *"/srv/hls/${match_id}/stream.m3u8"* ]]
}

running_ffmpeg_pid() {
  local runner_pid="$1"
  local match_id="$2"
  local child cmd
  for child in $(pgrep -P "$runner_pid" 2>/dev/null || true); do
    is_live_pid "$child" || continue
    cmd=$(tr '\0' ' ' < "/proc/$child/cmdline" 2>/dev/null || true)
    if [[ "$cmd" == *"ffmpeg"* && "$cmd" == *"/srv/hls/${match_id}/stream.m3u8"* ]]; then
      echo "$child"
      return 0
    fi
  done
  return 1
}

for file in "$PID_DIR"/*.pid; do
  [[ -e "$file" ]] || { echo "no running matches"; exit 0; }
  match_id=$(basename "$file" .pid)
  pid=$(cat "$file")
  if is_runner_pid "$pid" "$match_id"; then
    if ffmpeg_pid=$(running_ffmpeg_pid "$pid" "$match_id"); then
      echo "$match_id RUNNING pid=$ffmpeg_pid runner=$pid output=/srv/hls/$match_id/stream.m3u8"
    else
      echo "$match_id RETRYING pid=$pid output=/srv/hls/$match_id/stream.m3u8"
    fi
  else
    echo "$match_id STALE pid=$pid"
  fi
done
