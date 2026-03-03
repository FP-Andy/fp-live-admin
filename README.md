# Live Admin System (SRT/RTMP->HLS Gateway + Match Ops App)

로컬에서 `docker compose`로 즉시 실행 가능하며, VPS 배포(nginx/https 옵션)까지 고려한 구조입니다.

## 1) Repository Layout

- `infra/gateway/`: SRT/RTMP ingest -> HLS origin 게이트웨이 (`nginx` + `nginx-rtmp` + `ffmpeg-runner` + match scripts + manager API)
- `infra/app/`: 앱 스택 compose (`api`, `web`, `postgres`, `nginx` reverse proxy)
- `apps/api/`: FastAPI + SQLAlchemy + Postgres
- `apps/web/`: Next.js 운영 콘솔 (hls.js + Recharts)
- `README.md`: 실행/배포/환경변수/키바인딩/웹훅/확장 가이드

---

## 2) Architecture

- 영상 트래픽 분리:
  - Gateway 서버: SRT 입력 수신 후 경기별 HLS 출력
  - App 서버: UI/API/DB만 처리
- 데이터 흐름:
  1. 운영자가 `/admin/match/[id]`에서 타이머/소유권/레인/xG 입력
  2. API가 state/event 저장
  3. 소유권 segment 종료 및 xG 입력 시 `dominance_bins`를 증분 업데이트
  4. 상태/이벤트 저장 직후 outbox에 webhook enqueue
  5. 백그라운드 워커가 webhook 전송 재시도(지수 백오프)

---

## 3) Local Run: Gateway

```bash
cd infra/gateway
docker compose up -d --build
```

### Match process control (docker exec)

```bash
# start
docker exec gateway-ffmpeg /scripts/start_match.sh match001 "srt://YOUR_SRT_SOURCE"

# status
docker exec gateway-ffmpeg /scripts/status.sh

# stop
docker exec gateway-ffmpeg /scripts/stop_match.sh match001
```

### Gateway manager API (로컬 테스트 예시)

- `POST http://localhost:8090/matches/start` body:
  - SRT: `{ "match_id": "match001", "ingest_protocol": "SRT", "source_url": "srt://..." }`
  - RTMP(push): `{ "match_id": "match001", "ingest_protocol": "RTMP" }`
- `GET  http://localhost:8090/matches/{match_id}/rtmp-info`
  - 중계사 전달값: `server_url`, `stream_key`, `push_url`, `pull_url`
- `GET  http://localhost:8090/matches/status`
- `POST http://localhost:8090/matches/{match_id}/stop`

### RTMP 전달 정보(중계사 공유용)

- 서버(Server URL): `rtmp://<gateway-host>:1935/live`
- 스트림키(Stream Key): `<match_id>`
- 전체 push URL: `rtmp://<gateway-host>:1935/live/<match_id>`

### HLS 확인 (로컬 테스트 예시)

- 플레이리스트: `http://localhost:8080/hls/match001/stream.m3u8`

HLS 설정:

- `hls_time=2`
- `hls_list_size=6`
- `hls_flags=delete_segments+append_list+omit_endlist+independent_segments`
- `hls_delete_threshold=2`

---

## 4) Local Run: App

```bash
cd infra/app
docker compose up -d --build
```

접속 (로컬 테스트):

- 콘솔: `http://localhost:3000/admin/dashboard`
- API health: `http://localhost:3000/health`

### 기본 흐름

1. Dashboard에서 match 생성 (`name`, `ingest protocol(SRT/RTMP)`, `ingest_url(optional)` 입력)
   - API가 gateway manager로 자동 시작 요청 후 `hls_url`을 저장
2. Match 페이지 진입 후 lock 획득
3. 타이머/소유권/레인/xG 조작
4. 도미넌스 차트/이벤트/웹훅 outbox 상태 확인

---

## 5) Key Bindings

- 타이머
  - `Space`: Start/Pause
  - `R`: Reset
- 소유권
  - `Q` 또는 `ArrowLeft`: HOME
  - `W` 또는 `ArrowRight`: AWAY
- 팀 선택
  - `1`: HOME
  - `2`: AWAY
- 공격 레인
  - `A`: LEFT 선택
  - `S`: CENTER 선택
  - `D`: RIGHT 선택
  - `Enter`: 선택된 lane 이벤트 1건 기록

---

## 6) API Spec

### Matches / Lock

- `POST /api/matches`
  - body:
    - SRT: `{ "name": "M1", "ingest_protocol": "SRT", "ingest_url": "srt://...", "metadata": {} }`
    - RTMP(push): `{ "name": "M1", "ingest_protocol": "RTMP", "metadata": {} }`
- `POST /api/matches/{match_id}/stream/srt`
  - body: `{ "srt_url": "srt://..." }`
- `POST /api/matches/{match_id}/stream`
  - body:
    - SRT: `{ "ingest_protocol": "SRT", "ingest_url": "srt://..." }`
    - RTMP(push): `{ "ingest_protocol": "RTMP" }`
- `GET /api/matches/{match_id}/stream/rtmp-info`
- `GET /api/matches`
- `GET /api/matches/{match_id}`
- `DELETE /api/matches/{match_id}?stop_stream=true`
- `POST /api/matches/{match_id}/lock/acquire`
  - body: `{ "user_id": "analyst-1", "admin_takeover": false }`
- `POST /api/matches/{match_id}/lock/release`
  - body(optional): `{ "user_id": "analyst-1", "admin_takeover": false }`

### State / Events

- `POST /api/matches/{match_id}/state`
  - body: `{ state_id, clock_ms, running, possession_team, selected_team, attack_lr, user_id? }`
- `POST /api/matches/{match_id}/events/attack_lane`
  - body: `{ event_id, clock_ms?, team, lane, user_id? }`
- `POST /api/matches/{match_id}/events/xg`
  - body: `{ event_id, clock_ms?, team, xg, user_id? }`

### Query

- `GET /api/matches/{match_id}/summary`
- `GET /api/matches/{match_id}/dominance?bin_seconds=180`
- `GET /api/outbox`

### Broadcast Partner API (`/api/v1`)

- OpenAPI draft: `docs/openapi/broadcast-v1.yaml`
- `GET /api/v1/matches`
- `GET /api/v1/matches/{match_id}`
- `GET /api/v1/matches/{match_id}/summary`
- `GET /api/v1/matches/{match_id}/events?since=<ISO_DATETIME>&limit=200`
- `GET /api/v1/matches/{match_id}/dominance?bin_seconds=180`
- `GET /api/v1/matches/{match_id}/timeline/possession`
- `POST /api/v1/webhooks/subscriptions`
  - body: `{ "callback_url":"https://partner.example/hook", "events":["STATE","EVENT"], "secret":"optional", "active":true }`
- `GET /api/v1/webhooks/subscriptions`
- `DELETE /api/v1/webhooks/subscriptions/{subscription_id}`
- 인증:
  - `PARTNER_API_KEY`가 설정된 경우 `/api/v1/*` 요청에 `X-API-Key` 헤더 필수

---

## 7) Domain Logic Summary

### Timer

- 클라이언트에서 `performance.now()` 기반으로 drift 최소화
- 1초 간격으로 state 저장
- `running=false`면 시간 증가 없음

### Possession (segment)

- possession team 변경 시:
  - 기존 open segment 종료 (`end_ms=current_clock`)
  - 새 팀 open segment 시작 (`start_ms=current_clock`)
- `NONE` 구간은 점유율 분모 제외
- summary에서 `home_pct = home_ms / (home_ms+away_ms)`

### Attack lane (event)

- lane은 연속 구간이 아니라 입력 이벤트 단위로 저장
- 팀별 lane 비중은 이벤트 카운트 기반(`LEFT/CENTER/RIGHT` count ratio)

### Dominance bins (incremental)

- bin 크기 고정: `180000ms (3분)`
- possession segment 종료 시, 해당 segment와 겹치는 bin들만 누적 업데이트
- xG event 저장 시, 해당 bin의 home/away xG 누적 업데이트
- `dominance = clamp(0.6*poss_balance + 0.4*xg_balance, -1, 1)`

---

## 8) Webhook + Outbox

환경변수 (`infra/app/docker-compose.yml`):

- `WEBHOOK_STATE_URL` (optional)
- `WEBHOOK_EVENT_URL` (optional)
- `WEBHOOK_SECRET` (optional, HMAC-SHA256 -> `X-Webhook-Signature`)
- `PARTNER_API_KEY` (optional, set 시 `/api/v1/*`에 `X-API-Key` required)
- `OUTBOX_RETRY_MAX` (default `10`)
- `OUTBOX_RETRY_BASE_SECONDS` (default `5`)
- `OUTBOX_RETRY_MAX_DELAY_SECONDS` (default `300`)

동작:

- state/event 저장 성공 -> outbox enqueue
- webhook subscription(`POST /api/v1/webhooks/subscriptions`)에 등록된 endpoint들로 fan-out 전송
- 워커가 전송 성공 시 outbox row 삭제
- 실패 시 `attempts++`, `next_attempt_at`를 지수 백오프(+jitter)로 재설정
- `4xx(429 제외)`는 non-retryable로 처리

Webhook 서명 헤더:

- `X-Webhook-Id`: outbox delivery id (uuid)
- `X-Webhook-Event`: `STATE` or `EVENT`
- `X-Webhook-Timestamp`: unix epoch seconds
- `X-Webhook-Signature`: `sha256=<hex(hmac(secret, "<timestamp>.<raw_json_payload>"))>`

### Example payload

State:

```json
{
  "kind": "STATE",
  "state_id": "uuid",
  "idempotency_key": "same-as-state_id",
  "match_id": "uuid",
  "clock_ms": 12345,
  "running": true,
  "possession_team": "HOME",
  "selected_team": "HOME",
  "attack_lr": "L2R",
  "created_at": "2026-02-28T00:00:00"
}
```

Event (XG):

```json
{
  "kind": "EVENT",
  "event_id": "uuid",
  "idempotency_key": "same-as-event_id",
  "match_id": "uuid",
  "type": "XG",
  "clock_ms": 45000,
  "team": "HOME",
  "xg": 0.12,
  "created_at": "2026-02-28T00:00:00"
}
```

---

## 9) Test Scenario (MVP)

1. Gateway 실행 + match 시작
2. App 실행 + match 생성 시 ingest 설정 입력(자동 HLS 변환 연결)
3. match 페이지에서:
   - `Space` Start
   - `Q` 5초
   - `W` 5초
   - `Pause`
   - 기대: 점유율 HOME/AWAY 약 50/50
4. `1`(HOME) -> `A` 3초 -> `S` 2초
   - 기대: HOME LEFT 약 60%, CENTER 약 40%
5. xG `HOME 0.12` 입력
   - 기대: 해당 3분 bin `home_xg` 증가 + dominance 변동
6. webhook URL을 정상 endpoint로 설정해 수신 확인
7. 실패 URL로 설정해 outbox 재시도/`last_error` 확인

---

## 10) VPS Deployment Guide

권장: 서버 2대 분리

- `gateway` 서버: `infra/gateway` 실행
- `app` 서버: `infra/app` 실행

### Gateway VPS

```bash
cd infra/gateway
docker compose up -d --build
```

방화벽: `8080` 또는 외부 nginx에서 프록시

### App VPS

```bash
cd infra/app
WEBHOOK_STATE_URL=https://receiver.example.com/state \
WEBHOOK_EVENT_URL=https://receiver.example.com/event \
WEBHOOK_SECRET=your_secret \
GATEWAY_API_BASE=http://GATEWAY_SERVER_IP:8090 \
docker compose up -d --build
```

### HTTPS 옵션 (host nginx + certbot)

호스트 nginx 예시:

```nginx
server {
  listen 80;
  server_name app.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}
```

```bash
sudo certbot --nginx -d app.example.com
```

Gateway도 동일하게 `stream.example.com`으로 구성 가능:

```nginx
server {
  listen 80;
  server_name stream.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
  }
}
```

---

## 11) Scale / Ops Notes

- 현재 목표(동시 5경기 + 분석관 10명)에서 앱 폴링 1초는 충분
- write 권한은 operator lock으로 단일화
- 영상 트래픽은 gateway로만 처리하여 app 서버 부하 분리
- 향후 확장:
  - API 수평 확장 + 외부 Redis 락
  - Outbox 전용 worker 분리
  - SSE/WebSocket 전환

---

## 12) Broadcaster Handoff (중계사 전달용)

아래 항목을 중계사에 전달하면 됩니다.

1. Base URL
   - App API: `https://<APP_HOST>` (또는 `http://<APP_IP>:3000`)
2. 인증
   - 헤더: `X-API-Key: <PARTNER_API_KEY>` (서버에 `PARTNER_API_KEY` 설정 시)
3. 핵심 Pull API
   - `GET /api/v1/matches`
   - `GET /api/v1/matches/{match_id}`
   - `GET /api/v1/matches/{match_id}/summary`
   - `GET /api/v1/matches/{match_id}/events?since=<ISO_DATETIME>&limit=200`
   - `GET /api/v1/matches/{match_id}/dominance?bin_seconds=180`
   - `GET /api/v1/matches/{match_id}/timeline/possession`
4. Webhook 구독
   - `POST /api/v1/webhooks/subscriptions`
   - body:
     - `{ "callback_url":"https://partner.example/webhook", "events":["STATE","EVENT"], "secret":"<shared_secret>", "active":true }`
5. Webhook 검증
   - 헤더:
     - `X-Webhook-Id`
     - `X-Webhook-Event`
     - `X-Webhook-Timestamp`
     - `X-Webhook-Signature`
   - 서명:
     - `sha256=<hex(hmac(secret, "<timestamp>.<raw_json_payload>"))>`

테스트 예시:

```bash
BASE_URL="http://<APP_IP>:3000"
API_KEY="<PARTNER_API_KEY>"
MATCH_ID="<MATCH_ID>"

curl -sS "$BASE_URL/api/v1/matches" \
  -H "X-API-Key: $API_KEY"

curl -sS "$BASE_URL/api/v1/matches/$MATCH_ID/events?limit=50" \
  -H "X-API-Key: $API_KEY"
```
  - Postgres index/partition 고도화

---

## 12) Important Paths

- Gateway compose: `infra/gateway/docker-compose.yml`
- Gateway scripts: `infra/gateway/scripts/start_match.sh`, `stop_match.sh`, `status.sh`
- App compose: `infra/app/docker-compose.yml`
- API app: `apps/api/app/main.py`
- Web app: `apps/web/app/admin/match/[id]/page.tsx`
