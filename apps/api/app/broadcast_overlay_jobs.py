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
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import requests

from .db import SessionLocal
from .models import BroadcastOverlayProject


OUTPUT_PREFIX = "broadcast-overlays/output"
OVERLAY_WIDTH = 900  # 1920px output 기준 좌하단 안전 영역
OVERLAY_MARGIN = 40


@dataclass(frozen=True)
class OverlayPlacement:
    """Visible frame bounds inside the transparent 1920×1080 capture."""

    crop_width: int = 1920
    crop_height: int = 1080
    crop_x: int = 0
    crop_y: int = 0
    output_width: int = OVERLAY_WIDTH
    x: str = str(OVERLAY_MARGIN)
    y: str = f"H-h-{OVERLAY_MARGIN}"


# Possession and xG comparison were designed as wide, lower-third cards.
# Crop away the transparent canvas around their frame and centre the actual
# design rather than shrinking a 1920px artboard into the lower-left corner.
_OVERLAY_PLACEMENTS: dict[str, OverlayPlacement] = {
    "possession": OverlayPlacement(
        crop_width=1295, crop_height=182, crop_x=312, crop_y=720,
        output_width=1295, x="(W-w)/2", y="H-h-74",
    ),
    "xg-comparison": OverlayPlacement(
        crop_width=1380, crop_height=418, crop_x=270, crop_y=340,
        output_width=1380, x="(W-w)/2", y="H-h-74",
    ),
}


def _overlay_placement(asset_type: str) -> OverlayPlacement:
    return _OVERLAY_PLACEMENTS.get(asset_type, OverlayPlacement())


def _download_url(url: str, target: Path) -> None:
    if not url.startswith(("https://", "http://")):
        raise ValueError("다운로드 URL이 올바르지 않습니다.")
    target.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=(30, 3600)) as response:
        response.raise_for_status()
        with target.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)


def _upload_video(url: str, source: Path) -> None:
    if not url.startswith(("https://", "http://")):
        raise ValueError("업로드 URL이 올바르지 않습니다.")
    with source.open("rb") as body:
        response = requests.put(
            url,
            data=body,
            headers={"Content-Type": "video/mp4"},
            timeout=(30, 3600),
        )
    response.raise_for_status()


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
        if not project.source_download_url or not project.output_upload_url or not project.output_s3_key:
            raise ValueError("렌더용 저장소 URL이 없습니다. 렌더를 다시 요청하세요.")
        if project.first_half_video_start_sec is None or project.second_half_video_end_sec is None:
            raise ValueError("전반 시작과 후반 종료 지점을 지정하세요.")

        source = work / "source" / (project.source_filename or "source.mp4")
        _download_url(project.source_download_url, source)

        extract_start = max(0.0, float(project.first_half_video_start_sec))
        extract_end = max(extract_start + .1, float(project.second_half_video_end_sec) + 5.0)
        duration = extract_end - extract_start
        items = sorted(
            [row for row in (project.overlay_items or []) if isinstance(row, dict)],
            key=lambda row: float(row.get("start_sec") or 0),
        )

        assets: list[tuple[dict, Path, Path]] = []
        for index, item in enumerate(items):
            # Preserve the designer-authored transparent frame as well as the
            # changing data asset.  Both PNGs have a transparent 1920×1080
            # canvas, so the recorded video remains visible outside the frame.
            background_url = str(item.get("background_url") or "").strip()
            asset_url = str(item.get("asset_url") or "").strip()
            if not background_url or not asset_url:
                raise ValueError("프레임과 에셋 PNG가 모두 필요합니다. 시각화를 다시 삽입하세요.")
            background = work / "assets" / f"{index:03d}-frame.png"
            asset = work / "assets" / f"{index:03d}-asset.png"
            _download_url(background_url, background)
            _download_url(asset_url, asset)
            assets.append((item, background, asset))
        if not assets:
            raise ValueError("렌더할 Broadcast 프레임·에셋이 없습니다. 시각화를 다시 삽입하세요.")

        args = ["ffmpeg", "-y", "-ss", f"{extract_start:.3f}", "-t", f"{duration:.3f}", "-i", str(source)]
        for _item, background, asset in assets:
            args += ["-loop", "1", "-i", str(background), "-loop", "1", "-i", str(asset)]
        has_audio = _has_audio(source)
        silent_index: int | None = None
        if not has_audio:
            # Input 0 is the source, then each overlay contributes a frame
            # input and a dynamic asset input before the silent-audio source.
            silent_index = len(assets) * 2 + 1
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
        for index, (item, _background, _asset) in enumerate(assets, start=1):
            start = max(0.0, float(item.get("start_sec") or 0) - extract_start)
            end = min(duration, float(item.get("end_sec") or 0) - extract_start)
            if end <= start:
                continue
            placement = _overlay_placement(str(item.get("asset_type") or ""))
            background_input = 1 + (index - 1) * 2
            asset_input = background_input + 1
            frame = f"[frame{index}]"
            data = f"[data{index}]"
            overlay = f"[ov{index}]"
            output = f"[v{index}]"
            crop = f"crop={placement.crop_width}:{placement.crop_height}:{placement.crop_x}:{placement.crop_y}"
            chains.append(f"[{background_input}:v]format=rgba,{crop},scale={placement.output_width}:-2{frame}")
            chains.append(f"[{asset_input}:v]format=rgba,{crop},scale={placement.output_width}:-2{data}")
            chains.append(f"{frame}{data}overlay=0:0:format=auto{overlay}")
            chains.append(
                f"{current}{overlay}overlay=x={placement.x}:y={placement.y}:"
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
        return output, str(project.output_s3_key)
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
            db = SessionLocal()
            try:
                project = db.get(BroadcastOverlayProject, project_uuid)
                if not project or not project.output_upload_url:
                    raise ValueError("결과 업로드 URL이 없습니다. 렌더를 다시 요청하세요.")
                _upload_video(project.output_upload_url, output)
            finally:
                db.close()
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
