# FPC DB 매일 백업

운영 앱 서버에는 DB 백업이 없었다(2026-11-04 실측). EBS 스냅샷·DLM 권한도 없어서
앱 서버 cron 으로 `pg_dump` 를 떠서 EFS(`runtime/backups/`)에 14일치 둔다.

- 스크립트는 레포에 있고, 서버에서는 **cron 등록만** 한다. 배포가 `git reset --hard` 로
  폴더를 바꾸므로 서버에서 스크립트를 고치면 다음 배포 때 사라진다.
- 저장 위치 `runtime/` 은 `.gitignore` 에 있어 배포의 `git clean -fd` 에 지워지지 않는다.
- 루트 디스크(78% 사용)는 쓰지 않는다. DB 127MB 기준 덤프는 수십 MB × 14개.
- S3 사본은 앱 서버 역할(`fpc-fpa-app`)에 `backups/*` 쓰기 권한이 생긴 뒤에 붙인다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `fpc-db-backup.sh` | `docker exec app-postgres pg_dump -Fc` → 임시 파일 → 검증(크기·`pg_restore --list`·표 데이터 항목) → `fpc-db-YYYYMMDD-HHMM.dump`(UTC) 확정 → 14일 지난 덤프 정리. 실패하면 슬랙 |
| `fpc-db-restore.sh` | 덤프를 **새 이름의 DB**로 복원하고 표별 행 수를 출력. `--replace` 일 때만 같은 이름을 덮는다 |

설정은 환경변수 또는 옵션으로 바꾼다(기본값 = 운영 값). 자세한 목록은 스크립트 머리말.

| 변수 | 기본값 |
|---|---|
| `BACKUP_CONTAINER` (`--container`) | `app-postgres` |
| `BACKUP_DB` / `BACKUP_DB_USER` | `live_admin` / `postgres` |
| `BACKUP_DIR` (`--dir`) | `/home/ubuntu/fp-live-admin/runtime/backups` |
| `BACKUP_RETENTION_DAYS` | `14` |
| `BACKUP_SLACK_WEBHOOK_URL` | 없으면 `SCHEDULE_SLACK_WEBHOOK_URL`. 둘 다 환경에 없으면 `infra/app/.env` 에서 이 두 키만 읽는다 |
| `BACKUP_SLACK_ON_SUCCESS=1` | 성공도 알린다(등록 다음 날 확인할 때만) |

웹훅 주소는 로그·명령줄에 남기지 않는다(curl 에 stdin 설정으로 넘김).

## 서버 등록 (배포 다음, 사람이 한 번)

서버 시계는 **UTC** 다. 04:30 KST = **전날 19:30 UTC**.

```bash
# ubuntu 사용자(docker 그룹)로
crontab -e
# 아래 한 줄 추가
30 19 * * * /home/ubuntu/fp-live-admin/infra/app/backup/fpc-db-backup.sh >> /home/ubuntu/fpc-db-backup.cron.log 2>&1
```

- 05:00 KST 의 `fpc-docker-cleanup.timer` 보다 30분 앞이다. 백업은 이미지·컨테이너를 바꾸지 않아 서로 겹쳐도 문제없다.
- 등록 직후 한 번 손으로 돌려 본다: `BACKUP_SLACK_ON_SUCCESS=1 /home/ubuntu/fp-live-admin/infra/app/backup/fpc-db-backup.sh`
- 다음 날 `ls -l /home/ubuntu/fp-live-admin/runtime/backups/` 와 `fpc-db-backup.log` 를 확인한다.

## 복원

내용 확인·일부 행 복구는 **새 DB로** 복원해서 한다(운영 DB는 그대로).

```bash
cd /home/ubuntu/fp-live-admin
infra/app/backup/fpc-db-restore.sh runtime/backups/fpc-db-20261105-1930.dump --target live_admin_restore
# 끝나면 표별 행 수가 출력된다. 확인 뒤 정리:
docker exec app-postgres psql -U postgres -c 'DROP DATABASE live_admin_restore'
```

운영 DB 자체를 되돌려야 할 때(마지막 수단):

1. 공지하고 경기 없는 시간에 한다.
2. 쓰는 서비스를 멈춘다: `docker compose -f infra/app/docker-compose.yml stop api highlight-render scene-render recording`
3. 지금 상태도 한 번 더 백업한다: `infra/app/backup/fpc-db-backup.sh`
4. 덮어 복원한다: `infra/app/backup/fpc-db-restore.sh runtime/backups/<파일> --target live_admin --replace`
5. 표별 행 수를 확인하고 서비스를 다시 띄운다: `docker compose -f infra/app/docker-compose.yml up -d api highlight-render scene-render recording`

## 로컬 시험 (2026-11-04)

공유 로컬 DB 사본을 일회용 Postgres 16 컨테이너에 넣고, 이 스크립트로 백업 → 다른 일회용 컨테이너에 복원했다.

- 표 32개, 행 14,559개 — 원본과 복원본의 표별 행 수가 모두 같았다.
- 보관 정리: 15일·14일 1시간 지난 파일만 지우고 13일 된 파일은 남겼다. 실패한 실행에서는 아무것도 지우지 않았다.
- 실패(없는 컨테이너·없는 DB·pg_dump 없는 컨테이너): 확정 파일 없음, 임시 파일 삭제, 가짜 웹훅에 실패 메시지 1건씩 도착. 로그에 웹훅 주소 없음.
- 잘린 덤프는 `pg_restore --list` 에서 실패로 걸린다.
