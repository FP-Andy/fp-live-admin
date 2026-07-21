"""FinePlay 연동 워커 — 영상 왕복 오케스트레이션 (전송 전용).

한 작업 처리: S3 원본 download → 클립별 렌더(+썸네일+선택 세로) → highlights/ 업로드
→ 결과 콜백. 어떤 구간을 클립으로 뽑느냐(태깅/AI)는 decide_clips 콜백으로 주입 —
이 모듈은 그 결정을 모른다(분석은 범위 밖).
"""

from __future__ import annotations

import subprocess
import tempfile
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
    _probe_video_dims,
    extract_thumbnail,
    make_vertical_9x16,
    produce_clip,
)
from .highlight_storage import Storage

# 매니페스트를 받아 렌더할 클립 구간 목록을 정하는 함수(태깅/AI). 범위 밖이라 주입식.
DecideClips = Callable[[Manifest], list[ClipSpec]]


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

    # 필요한 원본만 한 번씩 내려받는다 (여러 클립이 같은 원본을 공유).
    sources: dict[str, Path] = {}
    for spec in clip_specs:
        if spec.source_video_id in sources:
            continue
        video = manifest.video_by_id(spec.source_video_id) or manifest.primary_video
        if not video:
            raise RuntimeError(f"원본 영상을 찾을 수 없습니다: {spec.source_video_id}")
        dest = work / "src" / f"{spec.source_video_id}.mp4"
        storage.download(video.s3_key, dest)
        sources[spec.source_video_id] = dest

    outputs: list[ClipOutput] = []
    for spec in clip_specs:
        src = sources[spec.source_video_id]

        local_h = work / f"{spec.clip_id}.mp4"
        produce_clip(src, spec.start, spec.end, local_h)

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
        outputs.append(ClipOutput(
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
        ))

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
    jobs = client.poll_jobs().get("jobs") or []
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
