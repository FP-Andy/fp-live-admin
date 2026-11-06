#!/usr/bin/env bash
# FPC DB 백업 파일(fpc-db-*.dump, pg_dump -Fc)을 되살린다.
#
# 기본은 "새 이름의 DB"로 복원한다(운영 DB를 덮지 않는다). 내용 확인·일부 행 복구는 이 DB에서
# 하고, 운영 DB 자체를 되돌려야 할 때만 --replace 로 같은 이름에 덮는다.
#
# 사용:
#   fpc-db-restore.sh DUMP_FILE [--container app-postgres] [--user postgres] [--target live_admin_restore_YYYYMMDD]
#   fpc-db-restore.sh DUMP_FILE --target live_admin --replace   # 운영 DB 덮기(아래 순서 먼저)
#
# 운영 DB를 덮기 전에(README "복원" 절):
#   1) 공지 후 쓰기 서비스를 멈춘다: docker compose -f infra/app/docker-compose.yml stop api highlight-render scene-render recording
#   2) 지금 상태도 한 번 더 백업한다: infra/app/backup/fpc-db-backup.sh
#   3) 이 스크립트로 --replace 복원 → 표별 행 수 확인 → 서비스 다시 시작
set -Eeuo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

DUMP=""
CONTAINER="${BACKUP_CONTAINER:-app-postgres}"
DB_USER="${BACKUP_DB_USER:-postgres}"
TARGET=""
REPLACE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --user) DB_USER="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
    *) DUMP="$1"; shift ;;
  esac
done

[ -n "$DUMP" ] && [ -s "$DUMP" ] || { echo "백업 파일을 지정하세요(비어 있지 않은 .dump)" >&2; exit 2; }
TARGET="${TARGET:-live_admin_restore_$(date -u +%Y%m%d_%H%M)}"
case "$TARGET" in *[!a-zA-Z0-9_]*) echo "DB 이름은 영문·숫자·_ 만 씁니다: $TARGET" >&2; exit 2 ;; esac

psql_c() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -v ON_ERROR_STOP=1 -At "$@"; }

echo "검증: pg_restore --list"
docker exec -i "$CONTAINER" pg_restore --list < "$DUMP" > /dev/null

EXISTS="$(psql_c -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET'")"
if [ -n "$EXISTS" ]; then
  if [ "$REPLACE" != 1 ]; then
    echo "DB '$TARGET' 가 이미 있습니다. 덮으려면 --replace 를 붙이세요." >&2
    exit 1
  fi
  echo "기존 DB '$TARGET' 를 지우고 다시 만듭니다(접속 중인 세션은 끊습니다)"
  psql_c -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET' AND pid <> pg_backend_pid()" > /dev/null
  psql_c -d postgres -c "DROP DATABASE \"$TARGET\""
fi
psql_c -d postgres -c "CREATE DATABASE \"$TARGET\""

echo "복원: $(basename "$DUMP") → $TARGET"
# 실패하면 바로 멈춘다(반쯤 복원된 DB 를 정상으로 착각하지 않게).
docker exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$TARGET" --no-owner --exit-on-error < "$DUMP"

echo "표별 행 수 ($TARGET):"
psql_c -d "$TARGET" -F $'\t' -c "
SELECT table_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name"
