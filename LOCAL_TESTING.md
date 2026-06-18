# 로컬 테스트 가이드 (Local Testing)

> 이 문서는 Git에 커밋되지 않는 개인용 메모입니다 (`.gitignore`에 포함).
> 공식 실행/배포 가이드는 `README.md`를 참고하세요.

## 0. 사전 준비

- Docker / Docker Compose 설치 (Docker Desktest 권장)
- 포트 사용 가능 여부 확인: `80`, `443`, `3000`(web), `5432`(postgres), `8080`/`8090`/`1935`(gateway)

```bash
# 충돌 포트 확인
lsof -i :443 -i :3000 -i :5432
```

---

## 1. 앱 스택 (api + web + postgres + nginx)

가장 자주 쓰는 기본 흐름. 콘솔 UI/API/DB를 한 번에 띄운다.

> ⚠️ **최초 1회 필수**: nginx는 443에서 `console.fineludens.kr` 인증서를 요구한다.
> 로컬엔 실제 인증서가 없어 nginx가 crash loop(`cannot load certificate`)에 빠지고
> `https://127.0.0.1` 접속이 막힌다. 아래로 self-signed 인증서를 만들어두면 해결된다.
> (`certbot/conf/`는 `.gitignore`라 인증서 파일은 깃에 올라가지 않으므로 각자 생성한다.)

```bash
# infra/app 에서 1회 실행 — 로컬용 self-signed 인증서 생성
cd infra/app
CERTDIR=certbot/conf/live/console.fineludens.kr
mkdir -p "$CERTDIR"
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$CERTDIR/privkey.pem" -out "$CERTDIR/fullchain.pem" \
  -subj "/CN=console.fineludens.kr" \
  -addext "subjectAltName=DNS:console.fineludens.kr,DNS:localhost,IP:127.0.0.1"
```

```bash
cd infra/app
docker compose up -d --build

# 상태 확인
docker compose ps
docker compose logs -f api      # api 로그
docker compose logs -f web      # web 로그
```

### 접속 URL (self-signed https 권장)

- 로그인: <https://127.0.0.1/login>
- FLA dashboard: <https://127.0.0.1/admin/dashboard>
- FPA live logger: <https://127.0.0.1/admin/fpa/live>
- FCM workspace: <https://127.0.0.1/admin/fcm/workspace>
- API health: <https://127.0.0.1/health>

> ⚠️ self-signed 인증서 경고는 로컬 테스트에서 "계속 진행" 허용.
> `http://127.0.0.1:3000/...` 보다 `https://127.0.0.1/...` 사용을 권장한다.

### 종료 / 초기화

```bash
docker compose down          # 컨테이너만 내림 (DB 데이터 유지)
docker compose down -v       # pg_data 볼륨까지 삭제 (DB 완전 초기화)
```

---

## 2. 환경 변수 (.env)

`infra/app/docker-compose.yml`은 `${VAR:-default}` 형태라 `.env` 없이도 뜬다.
로컬에서 특정 기능을 테스트할 때만 `infra/app/.env`를 만들어 덮어쓴다.
(`.env*`는 `.gitignore`로 커밋되지 않음)

자주 쓰는 키:

| 변수 | 용도 | 로컬 기본/팁 |
| --- | --- | --- |
| `GATEWAY_API_BASE` | gateway manager 주소 | `http://host.docker.internal:8090` |
| `POSTGRES_BIND` | postgres 바인딩 IP | 로컬은 `127.0.0.1` (기본) |
| `OPERATOR_ACCESS_KEY` / `_HASH` | 오퍼레이터 로그인 키 | 로컬 테스트용 키 직접 지정 |
| `SUPERADMIN_ACCESS_KEY` / `_HASH` | 슈퍼어드민 로그인 키 | 로컬 테스트용 키 직접 지정 |
| `HIGHLIGHT_WORKER_CONTROL_URL` | 하이라이트 워커 제어 | 로컬은 보통 비워둠 |
| `MEDIA_CONTROL_URL` | media EC2 제어 Lambda | 로컬은 보통 비워둠 |

예시 `infra/app/.env`:

```bash
OPERATOR_ACCESS_KEY=local-operator
SUPERADMIN_ACCESS_KEY=local-admin
GATEWAY_API_BASE=http://host.docker.internal:8090
```

변경 후에는 재기동:

```bash
docker compose up -d
```

---

## 3. Gateway 스택 (SRT/RTMP → HLS) — 스트리밍 테스트 시에만

영상 입력/HLS 출력을 직접 확인할 때만 띄운다. 앱 스택만으로 콘솔 UI는 동작한다.

```bash
cd infra/gateway
docker compose up -d --build
```

매치 프로세스 제어:

```bash
# start (SRT 소스)
docker exec gateway-ffmpeg /scripts/start_match.sh match001 "srt://YOUR_SRT_SOURCE"
# status
docker exec gateway-ffmpeg /scripts/status.sh
# stop
docker exec gateway-ffmpeg /scripts/stop_match.sh match001
```

Manager API (로컬):

- `POST http://localhost:8090/matches/start`
  - SRT: `{ "match_id": "match001", "ingest_protocol": "SRT", "source_url": "srt://..." }`
  - RTMP: `{ "match_id": "match001", "ingest_protocol": "RTMP" }`
- `GET  http://localhost:8090/matches/status`
- `GET  http://localhost:8090/matches/{match_id}/rtmp-info`
- HLS 확인: `http://localhost:8080/hls/match001/stream.m3u8`

RTMP push (중계사 공유값):

- Server URL: `rtmp://<gateway-host>:1935/live`
- Stream Key: `<match_id>`

---

## 4. Highlight Worker (FHL) — GPU 분석 테스트 시에만

하이라이트 분석은 앱이 직접 돌리지 않고 워커가 `highlight_jobs` 큐를 polling한다.
GPU(NVIDIA Container Toolkit) + 모델 파일이 있어야 의미 있는 테스트가 가능하므로,
로컬에서는 보통 생략하고 작업 enqueue/상태 흐름만 앱 스택에서 확인한다.

```bash
docker compose -f infra/highlight-worker/docker-compose.yml up -d --build
```

필요 env (`infra/highlight-worker/` 참고):

```bash
DATABASE_URL=postgresql+psycopg2://postgres:postgres@<app-db-private-host>:5432/live_admin
HIGHLIGHT_RUNTIME_HOST_DIR=/mnt/fhl-runtime
HIGHLIGHT_MODELS_HOST_DIR=/opt/fhl-models
```

모델 파일: `/app/models/best-8.pt`, `/app/models/highlight_model.xgb`
워커는 한 번에 1개 job만 처리한다.

---

## 5. 기본 동작 점검 체크리스트

1. `infra/app` 기동 → <https://127.0.0.1/health> 200 확인
2. <https://127.0.0.1/login> 로그인 (로컬 키로)
3. Dashboard에서 match 생성 (name / ingest protocol / ingest_url)
4. Match 페이지에서 lock 획득 → 타이머/소유권/레인/xG 조작
5. `Export Match Data`로 CSV 다운로드 확인
6. 오퍼레이터 흐름: 업로드 → my-clips → admin process-list 진행 상태 확인

---

## 6. 자주 쓰는 디버깅 명령

```bash
# 컨테이너 상태
docker compose -f infra/app/docker-compose.yml ps

# api 컨테이너 셸 진입
docker exec -it app-api sh

# postgres 접속
docker exec -it app-postgres psql -U postgres -d live_admin

# 전체 로그 tail
docker compose -f infra/app/docker-compose.yml logs -f
```

---

## 7. 정리 (clean up)

```bash
cd infra/app      && docker compose down
cd infra/gateway  && docker compose down
docker compose -f infra/highlight-worker/docker-compose.yml down

# DB까지 초기화하려면
cd infra/app && docker compose down -v
```
