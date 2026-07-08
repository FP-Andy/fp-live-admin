# Manual Production Deploy

This project uses a manually triggered GitHub Actions workflow for production deploys.

Workflow:

- `.github/workflows/deploy-production.yml`
- Trigger: GitHub Actions > Deploy Production > Run workflow
- Deploy branch: `main`
- Required input: `confirm=deploy-production`
- Runner: self-hosted `live-admin-app` with `production` label

## Required GitHub Setup

The app server already runs a repository self-hosted runner as a systemd service.

Current runner:

- Service: `actions.runner.FP-Andy-fp-live-admin.live-admin-app.service`
- Labels: `self-hosted`, `Linux`, `X64`, `live-admin-app`, `production`

Create or keep a GitHub Environment named `production` if reviewer approval is desired.

Recommended protection:

- Required reviewer: Andy
- Deployment branches: `main` only

No SSH deploy key secrets are required for the current app deploy workflow because the job runs directly on the production app server.

## Server Requirements

The runner service user needs permission to run:

```bash
cd /home/ubuntu/fp-live-admin
git fetch origin main
git reset --hard origin/main
git clean -fd
git checkout -B main origin/main
docker compose -f infra/app/docker-compose.yml build api web
docker compose -f infra/app/docker-compose.yml up -d api web
```

## Usage

1. Merge or push the commit to `main`.
2. Open GitHub Actions.
3. Select `Deploy Production`.
4. Click `Run workflow`.
5. Select branch `main`.
6. Type `deploy-production` in the `confirm` field.
7. Run the workflow.
8. Confirm Docker build, container restart, and health check in the workflow logs.

## Safety Behavior

If the production server worktree has uncommitted changes, the workflow saves a snapshot before syncing:

- `/home/ubuntu/deploy-backups/<deploy-id>/status.txt`
- `/home/ubuntu/deploy-backups/<deploy-id>/worktree.patch`
- `/home/ubuntu/deploy-backups/<deploy-id>/index.patch`
- `/home/ubuntu/deploy-backups/<deploy-id>/untracked.txt`

Then it force-syncs the app server repo to `origin/main`.

Health checks:

- Internal API: `http://127.0.0.1:8000/health`
- External app: `https://console.fineludens.kr/health`
