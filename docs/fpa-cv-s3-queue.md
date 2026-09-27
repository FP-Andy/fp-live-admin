# FPA S3 upload library and analysis queue

## Operator flow

1. Select multiple videos in **영상 트래킹 → 여러 영상 업로드**. Files upload sequentially, with six 32 MiB parts in flight per file. Keep the browser/computer awake until uploads finish.
2. Open each completed upload's **초기 설정**, select the start frame, court, five uniform groups and 13 people. Save with **초기 설정 저장 · 분석 준비**.
3. After preparing the matches, click **준비된 N경기 모두 분석 시작**. A single match can also start from its row. The GPU processes the persistent queue sequentially. The browser/computer may now close.
4. Open completed jobs and repeat checkpoint tagging, substitutions and **검수 반영 · 재연결** as needed; export heatmaps when satisfied. Review data remains in FPC's authenticated database with optimistic version checks.

Preparation also uses the single GPU queue. Finish initialization before starting the batch to avoid waiting behind full analyses. Queued jobs resume after worker restart; a job interrupted while running requires retry. Upload retry retains successful parts while the page remains open; after closing an unfinished transfer, remove that unfinished entry and reselect the file. This release does not implement cross-session multipart resume or multiple GPU workers.

## Storage and deployment

- Bucket: `fpc-fpa-161150463642-us-east-1`, region `us-east-1`, private, public access blocked, SSE-S3 encryption.
- Keys: `fpa-cv/uploads/{upload-id}/source.ext` and `fpa-cv/jobs/{job-id}/{asset}`. API authorizes each upload/job before signing URLs. Browser transfers directly to S3; originals do not transit the app disk.
- EC2 instance profiles `fpc-fpa-app` and `fpc-fpa-gpu`: object read/write/delete/multipart rights only under `fpa-cv/*`, bucket listing restricted to that prefix. Existing unrelated AWS keys remain unchanged. `FPA_CV_INSTANCE_ROLE=1` selects the EC2 role explicitly for this feature.
- Both compose services need `FPA_CV_S3_BUCKET`, `FPA_CV_S3_REGION`, `FPA_CV_INSTANCE_ROLE`. GPU compose additionally retains its existing private IP/runtime/token configuration.
- Browser PUT signing supports `FPA_CV_S3_ACCELERATE=1` after bucket Transfer Acceleration is enabled and verified. Only browser uploads use the accelerated endpoint; GPU transfers and browser GETs retain regional URLs. Upload URLs are signed in batches of six, failed parts retry with fresh signatures, and progress shows measured MB/s/ETA. Existing pages continue using two connections until reopened, but each new part signature can pick up the accelerated endpoint. Do not refresh a page with unfinished uploads.
- Production compose environment files live in `infra/app/.env` and `infra/fpa-worker/.env`.
- S3 CORS permits GET/HEAD/PUT from `https://console.fineludens.kr`, exposes ETag and range headers. Sign with SigV4. Incomplete multipart uploads expire after 3 days; completed inputs/results have no expiry.
- Worker downloads only the active source, verifies S3 outputs before removing heavy local outputs, and releases its source cache after each job. Small preparation/metadata files persist on the existing worker volume. Storage/upload failure retains local outputs; failed jobs can be retried or purged.
- Existing worker-local analyses continue to open through the original gateway. This change does not migrate or alter them, change the YOLO26s model, or change inference settings.
- Soft deletion retains files and review. Permanent deletion removes the run and its S3 outputs; the last analysis also removes its source/preparations, preserving sources shared by another run. Upload-only entries can be removed from the library.

## Verification

`PYTHONPATH=scripts runtime/auth-venv/bin/python -m unittest test_fpa_cv_gateway test_fpa_cv_jobs`

Coverage includes owner isolation, multipart validation/completion idempotence, size mismatch, signed result access, ready/batch states, queue restart, archive failure preservation and cleanup manifests. App and GPU EC2 role smoke checks exercise multipart PUT, completion, HEAD, presigned GET and deletion against the real bucket.
