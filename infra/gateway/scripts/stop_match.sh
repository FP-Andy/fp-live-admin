#!/usr/bin/env bash
set -euo pipefail

MATCH_ID="${1:-}"
if [[ -z "$MATCH_ID" ]]; then
  echo "usage: stop_match.sh <match_id>"
  exit 1
fi

PID_FILE="/tmp/ffmpeg-pids/${MATCH_ID}.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "no pid file for ${MATCH_ID}"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" || true
  fi
fi

rm -f "$PID_FILE"
echo "stopped match=${MATCH_ID}"
