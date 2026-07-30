"""FinePlay 연동 워커 — 영상 왕복 오케스트레이션 (전송 전용).

한 작업 처리: S3 원본을 presigned URL 로 ffmpeg 에 직접 입력(-ss fast-seek 로
필요 구간만 range 다운로드) → 클립별 렌더(+썸네일+선택 세로) → highlights/ 업로드
→ 결과 콜백. URL 렌더가 실패한 원본만 통짜 download 로 폴백한다.
클립 렌더는 FINEPLAY_RENDER_CONCURRENCY (기본 2) 개 동시 실행.
어떤 구간을 클립으로 뽑느냐(태깅/AI)는 decide_clips 콜백으로 주입 —
이 모듈은 그 결정을 모른다(분석은 범위 밖).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .fineplay_client import FinePlayClient
from .fineplay_models import (
    ClipOutput,
    ClipSpec,
    Manifest,
    build_result_payload,
    output_key,
    parse_manifest,
)
from .highlight_produce import (
    _probe_has_audio,
    _probe_video_dims,
    extract_thumbnail,
    make_vertical_9x16,
    produce_clip,
)
from .highlight_storage import Storage

# 매니페스트를 받아 렌더할 클립 구간 목록을 정하는 함수(태깅/AI). 범위 밖이라 주입식.
DecideClips = Callable[[Manifest], list[ClipSpec]]

# 동시 렌더 수 — 인코딩이 CPU 바운드라 코어 수에 맞춰 env 로 조절 (t3.medium=2vCPU 기준 2).
RENDER_CONCURRENCY = max(1, int(os.getenv("FINEPLAY_RENDER_CONCURRENCY", "2") or "2"))
# 원본 presigned URL 수명 — 렌더가 길어져도 만료되지 않게 태깅 화면(6시간)과 동일.
SOURCE_URL_EXPIRES = 21600
# 끄면 옛 방식(무조건 통짜 다운로드) — 문제 시 즉시 회귀용.
STREAM_SOURCE = os.getenv("FINEPLAY_STREAM_SOURCE", "1").strip().lower() not in {"0", "false", "off"}


@dataclass
class _SourceInput:
    """클립 렌더가 읽을 원본 하나 — presigned URL 우선, 실패 시 로컬 다운로드 폴백.

    같은 원본을 여러 클립이 병렬로 쓰므로 폴백 다운로드는 락으로 1회만 일어난다.
    """

    s3_key: str
    url: str | None = None
    local: Path | None = None
    has_audio: bool | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def target(self) -> Path | str:
        # url 이 None 이면 생성 시점에 ensure_local 을 거쳤으므로 local 이 항상 있다.
        return self.local if self.local is not None else self.url  # type: ignore[return-value]

    def ensure_local(self, storage: Storage, dest: Path) -> Path:
        """폴백: 원본을 통짜로 내려받는다(원본당 1회)."""
        with self.lock:
            if self.local is None:
                storage.download(self.s3_key, dest)
                self.local = dest
                self.has_audio = None  # 로컬 기준으로 다시 프로브
        return self.local


def _probe_duration(path: Path) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            check=True, capture_output=True, text=True,
        )
        return float((r.stdout or "").strip())
    except (subprocess.CalledProcessError, ValueError):
        return None


def process_job(
    manifest: Manifest,
    clip_specs: list[ClipSpec],
    storage: Storage,
    *,
    pipeline_version: str,
    workdir: Path | None = None,
) -> dict:
    """확정된 매니페스트 + 클립 구간으로 영상을 만들어 올리고 결과 payload 를 반환한다."""
    if workdir is not None:
        workdir.mkdir(parents=True, exist_ok=True)
        return _process_in(workdir, manifest, clip_specs, storage, pipeline_version)
    with tempfile.TemporaryDirectory(prefix="fpc_job_") as tmp:
        return _process_in(Path(tmp), manifest, clip_specs, storage, pipeline_version)


def _process_in(
    work: Path,
    manifest: Manifest,
    clip_specs: list[ClipSpec],
    storage: Storage,
    pipeline_version: str,
) -> dict:
    if not clip_specs:
        return build_result_payload(
            manifest.analysis_request_id, manifest.team_id, [],
            pipeline_version=pipeline_version, status="PARTIAL",
        )

    # 원본은 presigned URL 로 바로 읽는다 — ffmpeg -ss fast-seek 가 range 요청으로
    # 클립 구간만 받아오므로 풀경기 통짜 다운로드가 사라진다. presign 을 못 만드는
    # 스토리지(테스트 로컬 구현 등)나 STREAM_SOURCE off 면 예전처럼 먼저 내려받는다.
    presign = getattr(storage, "presigned_get", None) if STREAM_SOURCE else None
    sources: dict[str, _SourceInput] = {}
    for spec in clip_specs:
        if spec.source_video_id in sources:
            continue
        video = manifest.video_by_id(spec.source_video_id) or manifest.primary_video
        if not video:
            raise RuntimeError(f"원본 영상을 찾을 수 없습니다: {spec.source_video_id}")
        src = _SourceInput(s3_key=video.s3_key)
        if callable(presign):
            try:
                src.url = presign(video.s3_key, expires=SOURCE_URL_EXPIRES)
            except Exception:
                src.url = None
        if src.url is None:
            src.ensure_local(storage, work / "src" / f"{spec.source_video_id}.mp4")
        sources[spec.source_video_id] = src

    # 오디오 유무는 원본당 1회만 프로브 (URL 프로브를 클립마다 반복하지 않게).
    for src in sources.values():
        if src.has_audio is None:
            src.has_audio = _probe_has_audio(src.target)

    def render_one(spec: ClipSpec) -> ClipOutput:
        src = sources[spec.source_video_id]

        local_h = work / f"{spec.clip_id}.mp4"
        try:
            produce_clip(src.target, spec.start, spec.end, local_h, has_audio=src.has_audio)
        except RuntimeError:
            if src.local is not None:
                raise  # 이미 로컬 파일로 렌더하다 실패 — 폴백 없음
            # URL 렌더 실패(만료·네트워크·moov 파싱 등) → 통짜 다운로드 폴백 후 재시도.
            local = src.ensure_local(storage, work / "src" / f"{spec.source_video_id}.mp4")
            if src.has_audio is None:
                src.has_audio = _probe_has_audio(local)
            produce_clip(local, spec.start, spec.end, local_h, has_audio=src.has_audio)

        local_thumb = work / f"{spec.clip_id}_thumb.jpg"
        extract_thumbnail(local_h, local_thumb, at=min(0.5, max(0.0, (spec.end - spec.start) / 2)))

        h_key = output_key(manifest.team_id, manifest.analysis_request_id, spec.clip_id, "horizontal")
        t_key = output_key(manifest.team_id, manifest.analysis_request_id, spec.clip_id, "thumbnail")
        storage.upload(local_h, h_key, "video/mp4")
        storage.upload(local_thumb, t_key, "image/jpeg")

        v_key: str | None = None
        if spec.make_vertical:
            local_v = work / f"{spec.clip_id}_9x16.mp4"
            make_vertical_9x16(local_h, local_v)
            v_key = output_key(manifest.team_id, manifest.analysis_request_id, spec.clip_id, "vertical")
            storage.upload(local_v, v_key, "video/mp4")

        w, h, _ = _probe_video_dims(local_h)
        return ClipOutput(
            clip_id=spec.clip_id,
            source_video_id=spec.source_video_id,
            start=spec.start,
            end=spec.end,
            horizontal_s3_key=h_key,
            thumbnail_s3_key=t_key,
            vertical_s3_key=v_key,
            duration_seconds=_probe_duration(local_h),
            resolution=f"{w}x{h}",
            main_action=spec.main_action,
        )

    # 클립 병렬 렌더 — ffmpeg subprocess 라 GIL 무관, 업로드도 렌더와 자연히 겹친다.
    # 결과는 spec 순서 유지(클립↔씬 순서 매칭이 startTime 정렬 기반이지만 안전하게).
    if RENDER_CONCURRENCY > 1 and len(clip_specs) > 1:
        with ThreadPoolExecutor(max_workers=RENDER_CONCURRENCY) as pool:
            outputs = list(pool.map(render_one, clip_specs))
    else:
        outputs = [render_one(spec) for spec in clip_specs]

    return build_result_payload(
        manifest.analysis_request_id, manifest.team_id, outputs,
        pipeline_version=pipeline_version, status="DONE",
    )


def run_once(
    client: FinePlayClient,
    storage: Storage,
    decide_clips: DecideClips,
    *,
    pipeline_version: str,
    lease_seconds: int = 86400,
) -> dict | None:
    """폴링 1회: 대기 작업 중 하나를 claim → 처리 → 결과 콜백. 처리한 게 없으면 None.

    decide_clips 는 클립 구간을 정하는 주입 함수(태깅/AI). 여기선 전송 흐름만 엮는다.
    """
    data = client.poll_jobs()
    jobs = data if isinstance(data, list) else (data.get("jobs") or [])
    for job in jobs:
        request_id = job.get("analysisRequestId")
        claim = client.claim(request_id, pipeline_version=pipeline_version, lease_seconds=lease_seconds)
        if claim.taken:
            continue  # 다른 워커가 선점 → 다음 작업
        if not claim.granted:
            continue  # 준비 안 됨(400/410) → 건너뜀
        manifest = parse_manifest(claim.manifest or job)
        clip_specs = decide_clips(manifest)
        payload = process_job(manifest, clip_specs, storage, pipeline_version=pipeline_version)
        client.post_results(payload)
        return payload
    return None
