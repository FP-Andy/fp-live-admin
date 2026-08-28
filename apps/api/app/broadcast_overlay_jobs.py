"""Offline Broadcast-overlay video renderer.

This runs on the FHL worker, never in the live FLA API process.  A job trims
the recorded source to the operator's first-half-start through full-time +5s
range, then composites only the transparent Broadcast data PNG at the chosen
video time.  The Broadcast background image is intentionally not used here:
the source match video remains visible behind every graphic.
"""

from __future__ import annotations

import subprocess
import tempfile
import urllib.request
from pathlib import Path
from uuid import UUID

from .db import SessionLocal
from .highlight_storage import default_storage
from .models import BroadcastOverlayProject


OUTPUT_PREFIX = "broadcast-overlays/output"
OVERLAY_WIDTH = 900  # 1920px output 기준 좌하단 안전 영역
OVERLAY_MARGIN = 40


def _download_public_asset(url: str, target: Path) -> None:
    if not url.startswith(("https://", "http://")):
        raise ValueError("Broadcast 에셋 URL이 올바르지 않습니다.")
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=90) as response, target.open("wb") as out:
        out.write(response.read())


def _has_audio(source: Path) -> bool:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0", str(source),
        ],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and bool((result.stdout or "").strip())


def _render_project(project_id: UUID, work: Path) -> tuple[Path, str]:
    db = SessionLocal()
    try:
        project = db.get(BroadcastOverlayProject, project_id)
        if not project:
            raise ValueError("오버레이 프로젝트를 찾을 수 없습니다.")
        if not project.source_s3_key:
            raise ValueError("원본 영상이 업로드되지 않았습니다.")
        if project.first_half_video_start_sec is None or project.second_half_video_end_sec is None:
            raise ValueError("전반 시작과 후반 종료 지점을 지정하세요.")

        source = work / "source" / (project.source_filename or "source.mp4")
        storage = default_storage()
        if not storage.configured:
            raise ValueError("HIGHLIGHT_S3_BUCKET 이 설정되지 않았습니다.")
        storage.download(project.source_s3_key, source)

        extract_start = max(0.0, float(project.first_half_video_start_sec))
        extract_end = max(extract_start + .1, float(project.second_half_video_end_sec) + 5.0)
        duration = extract_end - extract_start
        items = sorted(
            [row for row in (project.overlay_items or []) if isinstance(row, dict)],
            key=lambda row: float(row.get("start_sec") or 0),
        )

        assets: list[tuple[dict, Path]] = []
        for index, item in enumerate(items):
            # Only the transparent asset layer is composed.  The static
            # background layer belongs to standalone Broadcast delivery, not
            # recorded-video overlay.
            asset_url = str(item.get("asset_url") or "").strip()
            if not asset_url:
                continue
            asset = work / "assets" / f"{index:03d}.png"
            _download_public_asset(asset_url, asset)
            assets.append((item, asset))
        if not assets:
            raise ValueError("렌더할 투명 Broadcast 에셋이 없습니다. 시각화를 다시 삽입하세요.")

        args = ["ffmpeg", "-y", "-ss", f"{extract_start:.3f}", "-t", f"{duration:.3f}", "-i", str(source)]
        for _item, asset in assets:
            args += ["-loop", "1", "-i", str(asset)]
        has_audio = _has_audio(source)
        silent_index: int | None = None
        if not has_audio:
            silent_index = len(assets) + 1
            args += [
                "-f", "lavfi", "-t", f"{duration:.3f}",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            ]

        # All deliverables are normalised to full-HD.  Every transparent PNG
        # retains its authored aspect ratio and is fixed to the lower-left
        # presentation safe area; enable times are relative to the trimmed
        # output, while the editor stores absolute source-video seconds.
        chains = [
            "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
            "pad=1920:1080:(ow-iw)/2:(oh-ih),setsar=1,format=yuv420p[v0]"
        ]
        current = "[v0]"
        for index, (item, _asset) in enumerate(assets, start=1):
            start = max(0.0, float(item.get("start_sec") or 0) - extract_start)
            end = min(duration, float(item.get("end_sec") or 0) - extract_start)
            if end <= start:
                continue
            overlay = f"[ov{index}]"
            output = f"[v{index}]"
            chains.append(f"[{index}:v]format=rgba,scale={OVERLAY_WIDTH}:-2{overlay}")
            chains.append(
                f"{current}{overlay}overlay=x={OVERLAY_MARGIN}:y=H-h-{OVERLAY_MARGIN}:"
                f"enable='between(t,{start:.3f},{end:.3f})':eof_action=pass{output}"
            )
            current = output

        output = work / "broadcast-overlay.mp4"
        args += ["-filter_complex", ";".join(chains), "-map", current]
        if has_audio:
            args += ["-map", "0:a?", "-c:a", "aac"]
        else:
            args += ["-map", f"{silent_index}:a", "-c:a", "aac"]
        args += [
            "-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
        ]
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "FFmpeg 렌더 실패")[-1200:])
        return output, f"{OUTPUT_PREFIX}/{project.id}/broadcast-overlay.mp4"
    finally:
        db.close()


def run_broadcast_overlay_render(project_id: str) -> None:
    """Worker entrypoint: render and publish one queued project."""
    project_uuid = UUID(project_id)
    db = SessionLocal()
    try:
        project = db.get(BroadcastOverlayProject, project_uuid)
        if not project:
            return
        project.status = "rendering"
        project.error_message = None
        db.commit()
    finally:
        db.close()

    try:
        with tempfile.TemporaryDirectory(prefix="broadcast_overlay_") as raw:
            output, output_key = _render_project(project_uuid, Path(raw))
            storage = default_storage()
            storage.upload(output, output_key, content_type="video/mp4")
        db = SessionLocal()
        try:
            project = db.get(BroadcastOverlayProject, project_uuid)
            if project:
                project.status = "done"
                project.output_s3_key = output_key
                project.error_message = None
                db.commit()
        finally:
            db.close()
    except Exception as exc:
        db = SessionLocal()
        try:
            project = db.get(BroadcastOverlayProject, project_uuid)
            if project:
                project.status = "error"
                project.error_message = str(exc)[-2000:]
                db.commit()
        finally:
            db.close()
