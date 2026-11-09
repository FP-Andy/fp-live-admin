#!/usr/bin/env bash
# FPC DB(live_admin) 매일 백업.
#
# 운영 앱 서버에는 DB 백업이 하나도 없다(2026-11-04 실측). 디스크 스냅샷 권한도 없어서,
# 앱 서버 cron 이 이 스크립트로 pg_dump 를 떠서 EFS(runtime/backups)에 14일치 둔다.
# 루트 디스크는 78% 라 피하고, runtime/ 은 git 밖(.gitignore)이라 배포의 git clean 에도 남는다.
#
# 순서: 덤프(임시 파일) → 검증(크기·pg_restore --list·표 데이터 항목) → 이름 바꿔 확정 → 14일 지난 것 정리.
# 어느 단계든 실패하면 확정 파일을 만들지 않고, 정리도 하지 않으며, 슬랙 웹훅이 있으면 알린다.
#
# 설정(환경변수 또는 같은 이름의 --옵션):
#   BACKUP_CONTAINER       postgres 컨테이너 이름 (기본 app-postgres)
#   BACKUP_DB / BACKUP_DB_USER   (기본 live_admin / postgres)
#   BACKUP_DIR             저장 폴더 (기본 /home/ubuntu/fp-live-admin/runtime/backups)
#   BACKUP_RETENTION_DAYS  보관 일수 (기본 14)
#   BACKUP_SLACK_WEBHOOK_URL  실패 알림. 없으면 SCHEDULE_SLACK_WEBHOOK_URL 을 쓴다.
#                          환경에 없으면 BACKUP_ENV_FILE(기본 infra/app/.env)에서 이 두 키만 읽는다.
#   BACKUP_SLACK_ON_SUCCESS=1  성공도 알린다(배포 다음 날 확인용).
#   BACKUP_LOG_FILE        로그 파일 (기본 $BACKUP_DIR/fpc-db-backup.log)
# 웹훅 주소·DB 비밀번호는 로그·명령줄 어디에도 남기지 않는다.
set -Eeuo pipefail
umask 077
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "옵션: --container NAME --db NAME --user NAME --dir PATH --retention-days N --env-file PATH"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --container) BACKUP_CONTAINER="$2"; shift 2 ;;
    --db) BACKUP_DB="$2"; shift 2 ;;
    --user) BACKUP_DB_USER="$2"; shift 2 ;;
    --dir) BACKUP_DIR="$2"; shift 2 ;;
    --retention-days) BACKUP_RETENTION_DAYS="$2"; shift 2 ;;
    --env-file) BACKUP_ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
done

CONTAINER="${BACKUP_CONTAINER:-app-postgres}"
DB="${BACKUP_DB:-live_admin}"
DB_USER="${BACKUP_DB_USER:-postgres}"
DIR="${BACKUP_DIR:-/home/ubuntu/fp-live-admin/runtime/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
ENV_FILE="${BACKUP_ENV_FILE:-$REPO_ROOT/infra/app/.env}"
HOST_LABEL="${BACKUP_HOST_LABEL:-$(hostname -s 2>/dev/null || echo unknown)}"
case "$RETENTION_DAYS" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS 는 숫자여야 합니다" >&2; exit 2 ;; esac
[ "$RETENTION_DAYS" -ge 1 ] || { echo "BACKUP_RETENTION_DAYS 는 1 이상이어야 합니다" >&2; exit 2; }

STAMP="$(date -u +%Y%m%d-%H%M)"
FINAL="$DIR/fpc-db-$STAMP.dump"
PARTIAL="$DIR/.fpc-db-$STAMP.dump.partial"
LOG_FILE="${BACKUP_LOG_FILE:-$DIR/fpc-db-backup.log}"
STEP="준비"

# tzdata 가 없는 환경에서도 한국 시각을 맞게 적는다(TZ=Asia/Seoul 은 조용히 UTC 로 떨어질 수 있다).
kst_now() { python3 -c 'import datetime as d; print(d.datetime.now(d.timezone(d.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M"))'; }

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [fpc-db-backup] $*"
  printf '%s\n' "$line" >&2
  if [ -d "$(dirname "$LOG_FILE")" ]; then printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true; fi
}

# .env 를 source 하지 않는다(값에 & ; 같은 문자가 있다). 필요한 키 한 줄만 읽는다.
env_file_value() {
  local key="$1"
  [ -r "$ENV_FILE" ] || return 0
  { grep -E "^${key}=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
  return 0
}

webhook_url() {
  local url="${BACKUP_SLACK_WEBHOOK_URL:-${SCHEDULE_SLACK_WEBHOOK_URL:-}}"
  [ -n "$url" ] || url="$(env_file_value BACKUP_SLACK_WEBHOOK_URL)"
  [ -n "$url" ] || url="$(env_file_value SCHEDULE_SLACK_WEBHOOK_URL)"
  printf '%s' "$url"
}

notify_slack() {
  local message="$1" url payload
  url="$(webhook_url)"
  if [ -z "$url" ]; then log "슬랙 웹훅이 설정되지 않아 알림을 건너뜁니다"; return 0; fi
  payload="$(MESSAGE="$message" python3 -c 'import json, os; print(json.dumps({"text": os.environ["MESSAGE"]}))')"
  # 주소는 명령줄(ps)에 보이지 않게 curl 설정으로 stdin 에 넘기고, curl 오류 문구도 버린다.
  if printf 'url = "%s"\n' "$url" | curl -K - -fsS -m 10 -o /dev/null \
       -H 'Content-Type: application/json' --data-binary "$payload" 2>/dev/null; then
    log "슬랙 알림 보냄"
  else
    log "슬랙 알림 전송 실패(웹훅 주소·네트워크 확인)"
  fi
}

on_error() {
  local code=$?
  trap - ERR
  rm -f "$PARTIAL" "$PARTIAL.list" 2>/dev/null || true
  log "실패: 단계='$STEP' 종료코드=$code"
  notify_slack "FPC DB 백업 실패 (${HOST_LABEL})
- 단계: ${STEP}
- 대상: ${CONTAINER} / ${DB}
- 시각: $(kst_now) KST
- 로그: ${LOG_FILE}"
  exit "$code"
}
trap on_error ERR

STEP="백업 폴더 준비"
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true

# 같은 시각에 두 번 돌지 않게 한다(수동 실행과 cron 이 겹치는 경우).
STEP="중복 실행 잠금"
exec 8>"$DIR/.fpc-db-backup.lock"
if command -v flock >/dev/null 2>&1; then
  flock -n 8
else
  log "flock 이 없어 잠금 없이 진행합니다"
fi

log "시작: $CONTAINER/$DB → $FINAL"

# 실패할 수 있는 명령은 $(...) 안에 두지 않는다. errtrace(-E) 때문에 하위 셸에서도 ERR 이
# 잡혀 알림이 두 번 나간다.
STEP="컨테이너 확인"
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$RUNNING" = "true" ]

STEP="pg_dump"
# -T 없이 실행해야 바이너리 출력이 깨지지 않는다. 덤프는 한 트랜잭션 스냅샷이라 서비스 중에도 일관된다.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" -Fc > "$PARTIAL"

STEP="검증: 파일 크기"
SIZE="$(wc -c < "$PARTIAL" | tr -d ' ')"
[ "$SIZE" -gt 0 ]

STEP="검증: pg_restore --list"
docker exec -i "$CONTAINER" pg_restore --list < "$PARTIAL" > "$PARTIAL.list"
TABLE_DATA="$(grep -c ' TABLE DATA ' "$PARTIAL.list" || true)"
rm -f "$PARTIAL.list"
[ "$TABLE_DATA" -gt 0 ]

STEP="확정"
mv -f "$PARTIAL" "$FINAL"
chmod 600 "$FINAL"
log "완료: $(basename "$FINAL") ${SIZE} bytes, 표 데이터 ${TABLE_DATA}개"

# 정리는 오늘 백업이 성공한 뒤에만 한다. 백업이 며칠 연달아 실패해도 옛 파일은 남는다.
STEP="보관 기간 정리"
PRUNED=0
while IFS= read -r -d '' old; do
  [ "$old" = "$FINAL" ] && continue
  rm -f -- "$old"
  log "정리: $(basename "$old") (${RETENTION_DAYS}일 경과)"
  PRUNED=$((PRUNED + 1))
done < <(find "$DIR" -maxdepth 1 -type f -name 'fpc-db-*.dump' -mmin +"$((RETENTION_DAYS * 24 * 60))" -print0)
# 중간에 끊겨 남은 임시 파일도 하루 지나면 지운다.
find "$DIR" -maxdepth 1 -type f -name '.fpc-db-*.dump.partial' -mmin +1440 -delete
KEPT="$(find "$DIR" -maxdepth 1 -type f -name 'fpc-db-*.dump' | wc -l | tr -d ' ')"
log "보관 ${KEPT}개, 이번에 정리 ${PRUNED}개"

if [ "${BACKUP_SLACK_ON_SUCCESS:-0}" = "1" ]; then
  notify_slack "FPC DB 백업 완료 (${HOST_LABEL}) — $(basename "$FINAL"), ${SIZE} bytes, 보관 ${KEPT}개"
fi
