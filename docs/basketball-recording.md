# Basketball stream recordings

- Create a basketball match using `스트리밍 녹화 + 경기 기록`, then copy the RTMP server/key from its recording panel.
- Each match gets a private random stream key, reused when recording is re-armed. Existing linked CUSTOM keys are preserved. OBS: H.264 + AAC, 2-second keyframes. Each game has an independent key and archive.
- Basketball match control exposes server/key and a TCP receiver readiness check directly. Its dashboard does not use the football HLS worker's STOPPED status for basketball recording. Re-preparing a waiting session re-requests media startup without replacing the session or key.
- Basketball FLA → Media (`/admin/basketball/media`) lists paged reception states, latest archived frames, key copying and recording/download controls. The web UI normalizes the known stream DNS alias to the same fixed RTMP address advertised by football (`rtmp://3.227.35.90:1935/live`); unknown/custom addresses are preserved.
- Recording is independent of the match clock. End explicitly with `녹화 종료·저장`. Continuous sessions are limited to 12 hours; up to three captures are admitted, with two-stream validation as the deployment acceptance check.
- Closed ~30-second MP4 parts upload to private S3 `prelaunch/recordings/{match}/{session}/`. Local files are removed only after remote byte-size verification and an fsynced manifest.
- The latest saved frame is extracted from closed video, not by a second live decoder. UI polls every 10 seconds; first preview normally appears after the first ~30-second part closes.
- Disconnects/timestamp resets open a new take under the same recording. Missing incoming video cannot be reconstructed. Saved duration counts received parts, not wall-clock downtime.
- Stop finalizes the last part and builds one fragmented MP4 via bounded S3 multipart upload, without a full-length local output or re-encoding. Individual parts remain available if merging fails (for example, incompatible sender codec changes). `저장 재시도` retries pending uploads and assembly.
- Upload outages retain local parts and retry while capture continues. A 768 MiB disk reserve stops capture before disk exhaustion; start requires 1 GiB free. Original parts remain for retry. Protect the `recording_data` volume: it contains the durable manifest and unuploaded video.
- Authentication reuses revocable FPC sessions; mutations require the assigned operator or an administrator. URLs for downloads are time-limited S3 redirects. No public storage ACLs.

## Isolated deployment

`recording` is a separate service using `Dockerfile.recording`. It shares existing session/match tables read-only. It never imports `app.main` or starts API video-render workers. No DB migration or broadcast API schema changes.

1. Build `recording` and `web` only.
2. Start with `docker compose -f infra/app/docker-compose.yml up -d --no-deps --no-build recording web`.
3. Validate nginx config and reload (do not recreate nginx/API/RTMP containers).
4. Verify existing API container ID/start time and full OpenAPI hash unchanged; check active renderer jobs.
5. Verify `/api/recordings/...` is 401 without a session and authenticated controls work.

Starting a recording idempotently starts the existing media EC2 through its control service. Recording never shuts the media server down. Operators should not manually stop the media server during capture.

## Validation

`PYTHONPATH=apps/api python -m unittest discover -s apps/api/tests -p test_recording.py -v`

FFmpeg integration tests exercise actual segmented MP4, JPEG extraction, full MP4 muxing, upload failure preservation/retry, duplicate-start safety, restart recovery, concurrency limit and HTTP authorization/cross-match checks. Use a separate synthetic stream and remove only its test objects after live acceptance QA.

## 광각 조각의 시간

새 녹화는 조각별 첫 데이터가 수신 서버의 파일에 나타난 시각을 별도로 기록한다. 코트사이드 프레임 선택의 광각 조각 목록과 화면 아래에 한국 시간으로 표시한다. 서버가 짧은 간격으로 관찰한 수신 시각이므로 송출 경로 지연과 관찰 간격이 포함되며 카메라 내부 시각을 확정하지 않는다. 중계와 같은 순간은 기존처럼 화면의 동작을 비교해 직접 확정한다. 기존 녹화에는 해당 기록이 없어 미기록으로 표시하며 세션 생성·업로드 시각으로 대체하지 않는다.
