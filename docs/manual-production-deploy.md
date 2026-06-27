# Manual Production Deploy

This project uses a manually triggered GitHub Actions workflow for production deploys.

Workflow:

- `.github/workflows/manual-production-deploy.yml`
- Trigger: GitHub Actions > Manual Production Deploy > Run workflow
- Protection: GitHub `production` Environment reviewers

## Required GitHub Setup

Create a GitHub Environment named `production`.

Recommended protection:

- Required reviewer: Andy
- Deployment branches: `main` and approved release branches only

Add these Environment secrets:

| Secret | Description |
| --- | --- |
| `PROD_DEPLOY_KEY` | Private SSH key for the deploy user |
| `PROD_APP_HOST` | Public hostname or IP for the app server |
| `PROD_APP_USER` | SSH user on the app server |
| `PROD_APP_PATH` | Absolute repository path on the app server |
| `PROD_HIGHLIGHT_WORKER_HOST` | Hostname or private IP for the highlight worker server |
| `PROD_HIGHLIGHT_WORKER_USER` | SSH user on the highlight worker server |
| `PROD_HIGHLIGHT_WORKER_PATH` | Absolute repository path on the highlight worker server |

The highlight worker secrets are only required when `deploy_highlight_worker` is selected.

## Server Requirements

The deploy SSH user needs permission to run:

```bash
git fetch origin --prune
git checkout <deploy-ref>
git pull --ff-only origin <deploy-ref>
docker compose -f infra/app/docker-compose.yml up -d --build api web nginx
docker compose -f infra/highlight-worker/docker-compose.yml up -d --build
```

If the worker server is reachable only through the app server, the workflow uses the app server as a `ProxyJump`.

## Usage

1. Merge or push the commit to deploy.
2. Open GitHub Actions.
3. Select `Manual Production Deploy`.
4. Click `Run workflow`.
5. Set `branch` to the branch or tag to deploy.
6. Keep `deploy_app` enabled.
7. Enable `deploy_highlight_worker` only when worker code or worker dependencies changed.
8. Wait for the `production` Environment approval.
9. Confirm the health check and compose status in the workflow logs.

## Safety Behavior

The workflow stops if the production server worktree has uncommitted changes.

Resolve that state manually before rerunning:

```bash
git status --short
```

The workflow does not force-reset production code.
