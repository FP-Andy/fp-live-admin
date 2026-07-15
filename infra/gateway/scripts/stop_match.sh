#!/usr/bin/env bash
set -euo pipefail

MATCH_ID="${1:-}"
if [[ -z "$MATCH_ID" ]]; then
  echo "usage: stop_match.sh <match_id>"
  exit 1
fi

PID_FILE="/tmp/ffmpeg-pids/${MATCH_ID}.pid"

is_live_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local state
  state=$(awk '/^State:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
  [[ "$state" != "Z" ]] || return 1
  local cmd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmd" == *"/srv/hls/${MATCH_ID}/stream.m3u8"* ]]
}

stop_pid() {
  local pid="$1"
  is_live_pid "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    is_live_pid "$pid" || return 0
  done
  kill -KILL "$pid" 2>/dev/null || true
}

if [[ ! -f "$PID_FILE" ]]; then
  pids=$(pgrep -f "/srv/hls/${MATCH_ID}/stream.m3u8" || true)
  if [[ -z "${pids:-}" ]]; then
    echo "no pid file for ${MATCH_ID}"
    exit 0
  fi
  for pid in $pids; do
    stop_pid "$pid"
  done
  echo "stopped match=${MATCH_ID}"
  exit 0
fi

PID=$(cat "$PID_FILE")
stop_pid "$PID"

pids=$(pgrep -f "/srv/hls/${MATCH_ID}/stream.m3u8" || true)
for pid in $pids; do
  stop_pid "$pid"
done

rm -f "$PID_FILE"
echo "stopped match=${MATCH_ID}"
