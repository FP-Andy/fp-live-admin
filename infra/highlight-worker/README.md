# FHL GPU Worker

FinePlay Highlight 분석은 앱 서버가 직접 실행하지 않고 `highlight-worker`가 `highlight_jobs` 큐를 polling해서 처리한다.

## Required runtime

- GPU EC2: `g4dn.xlarge` 이상 권장
- NVIDIA Container Toolkit 설치
- 앱 서버와 워커가 같은 `/app/runtime/highlight` 파일을 볼 수 있어야 한다. AWS에서는 EFS를 앱 EC2와 GPU EC2에 함께 mount한다.
- 앱 서버의 Postgres가 컨테이너 DB라면 `infra/app/docker-compose.yml`의 `POSTGRES_BIND`를 앱 EC2 private IP로 설정하고, 보안 그룹은 GPU 워커 private IP만 5432 접근 허용한다.
- 모델 파일:
  - `/app/models/best-8.pt`
  - `/app/models/highlight_model.xgb`

## Environment

```bash
DATABASE_URL=postgresql+psycopg2://postgres:postgres@<app-db-private-host>:5432/live_admin
HIGHLIGHT_RUNTIME_HOST_DIR=/mnt/fhl-runtime
HIGHLIGHT_MODELS_HOST_DIR=/opt/fhl-models
```

## Run

```bash
docker compose -f infra/highlight-worker/docker-compose.yml up -d --build
```

The worker processes one job at a time. Scale-out should move the queue from DB polling to SQS before running multiple GPU workers.
