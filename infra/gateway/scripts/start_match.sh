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
PLAYLIST_PATH="${OUT_DIR}/stream.m3u8"
RUNNER_SCRIPT="/scripts/run_ffmpeg.sh"

mkdir -p "$PID_DIR" "$OUT_DIR"

is_runner_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local state
  state=$(awk '/^State:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
  [[ "$state" != "Z" ]] || return 1
  local cmd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmd" == *"/scripts/run_ffmpeg.sh"* && "$cmd" == *"/srv/hls/${MATCH_ID}/stream.m3u8"* ]]
}

# The PID file tracks the runner, which owns and reaps its ffmpeg child.
existing_pid=$(pgrep -f "/srv/hls/${MATCH_ID}/stream.m3u8" | head -n1 || true)
if [[ -n "${existing_pid:-}" ]] && is_runner_pid "$existing_pid"; then
  echo "$existing_pid" > "$PID_FILE"
  echo "match ${MATCH_ID} already running with pid ${existing_pid}"
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null && is_runner_pid "$PID"; then
    echo "match ${MATCH_ID} already running with pid ${PID}"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Clean previous HLS artifacts so each new attach starts from a fresh playlist.
rm -f "${OUT_DIR}/stream.m3u8" "${OUT_DIR}/seg_"*.ts "${OUT_DIR}/ffmpeg.log"

if [[ ! -x "$RUNNER_SCRIPT" ]]; then
  echo "runner script missing: $RUNNER_SCRIPT"
  exit 1
fi

nohup "$RUNNER_SCRIPT" "$INPUT_URL" "$PLAYLIST_PATH" "$LOG_FILE" >/dev/null 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"
echo "started match=${MATCH_ID} pid=${PID}"
