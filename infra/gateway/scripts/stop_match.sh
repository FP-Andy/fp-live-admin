#!/usr/bin/env bash
set -euo pipefail

MATCH_ID="${1:-}"
if [[ -z "$MATCH_ID" ]]; then
  echo "usage: stop_match.sh <match_id>"
  exit 1
fi

PID_FILE="/tmp/ffmpeg-pids/${MATCH_ID}.pid"

is_match_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local cmd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmd" == *"ffmpeg"* && "$cmd" == *"/srv/hls/${MATCH_ID}/stream.m3u8"* ]]
}

if [[ ! -f "$PID_FILE" ]]; then
  pids=$(pgrep -f "/srv/hls/${MATCH_ID}/stream.m3u8" || true)
  if [[ -z "${pids:-}" ]]; then
    echo "no pid file for ${MATCH_ID}"
    exit 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
  echo "stopped match=${MATCH_ID}"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null && is_match_pid "$PID"; then
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" || true
  fi
fi

pids=$(pgrep -f "/srv/hls/${MATCH_ID}/stream.m3u8" || true)
for pid in $pids; do
  kill "$pid" 2>/dev/null || true
done

rm -f "$PID_FILE"
echo "stopped match=${MATCH_ID}"
