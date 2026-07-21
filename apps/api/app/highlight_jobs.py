from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import HighlightJob

HIGHLIGHT_RUNTIME_DIR = Path(os.getenv("HIGHLIGHT_RUNTIME_DIR", "/app/runtime/highlight")).resolve()
DELETE_UPLOAD_AFTER_SUCCESS = os.getenv("HIGHLIGHT_DELETE_UPLOAD_AFTER_SUCCESS", "1") not in {"0", "false", "False"}
# 인트로 사진을 앞에 보여주는 기본 길이(초)와 인트로 앞뒤 페이드 길이(초).
INTRO_SEC = float(os.getenv("HIGHLIGHT_INTRO_SEC", "1.8"))
INTRO_FADE_SEC = float(os.getenv("HIGHLIGHT_INTRO_FADE_SEC", "0.3"))
# 합치기 재인코딩 x264 프리셋. 앱 서버(t3.medium, 2vCPU 버스터블)가 약해서
# ultrafast 로 CPU 부담을 줄여 크레딧 소진 전에 끝낸다. 화질은 crf 로 고정되고
# 파일만 조금 커진다. veryfast 로 되돌리려면 env 로 바꾼다.
MERGE_PRESET = os.getenv("HIGHLIGHT_MERGE_PRESET", "ultrafast")
logger = logging.getLogger(__name__)


class NpEncoder(json.JSONEncoder):
    def default(self, o: object) -> object:
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        return super().default(o)


def ensure_highlight_runtime_dirs() -> None:
    (HIGHLIGHT_RUNTIME_DIR / "uploads").mkdir(parents=True, exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "exports").mkdir(parents=True, exist_ok=True)


def job_dir(job_id: str) -> Path:
    return HIGHLIGHT_RUNTIME_DIR / "jobs" / job_id


def clips_dir(job_id: str) -> Path:
    return job_dir(job_id) / "clips"


def exports_dir() -> Path:
    path = HIGHLIGHT_RUNTIME_DIR / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def upload_dir() -> Path:
    path = HIGHLIGHT_RUNTIME_DIR / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_clip_path(job_id: str, clip_name: str) -> Path:
    if Path(clip_name).name != clip_name:
        raise ValueError("Invalid clip name")
    return clips_dir(job_id) / clip_name


def update_job(db: Session, job_id: str, **kwargs: object) -> HighlightJob | None:
    job = db.get(HighlightJob, job_id)
    if not job:
        return None
    for key, value in kwargs.items():
        setattr(job, key, value)
    job.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return job


def serialize_job(job: HighlightJob) -> dict[str, Any]:
    metadata = job.job_metadata if isinstance(job.job_metadata, dict) else {}
    progress = metadata.get("progress")
    progress_percent = None
    stage = None
    if isinstance(progress, dict):
        progress_percent = progress.get("percent")
        stage = progress.get("detail") or progress.get("phase")
    elif isinstance(progress, (int, float)):
        progress_percent = progress
    # 내부 파일시스템 경로는 응답에서 제외한다.
    public_metadata = {k: v for k, v in metadata.items() if k != "reference_image_path"}
    return {
        "id": job.id,
        "owner_id": job.owner_id,
        "status": job.status,
        "mode": job.mode,
        "original_filename": job.original_filename,
        "display_name": metadata.get("display_name"),
        "jersey_number": metadata.get("jersey_number"),
        "player_name": metadata.get("player_name"),
        "uniform_color": metadata.get("uniform_color"),
        "has_reference_image": bool(metadata.get("reference_image_path")),
        "source_type": metadata.get("source_type"),
        "source_url": metadata.get("source_url"),
        "export_path": job.export_path,
        "error_message": job.error_message,
        "job_metadata": public_metadata,
        "progress": progress_percent,
        "stage": stage,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


def _json_safe(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(value, cls=NpEncoder))


def _progress_payload(phase: str, percent: int, detail: str | None = None) -> dict[str, Any]:
    return {
        "phase": phase,
        "percent": max(0, min(int(percent), 100)),
        "detail": detail or "",
        "updated_at": datetime.utcnow().isoformat(),
    }


def _update_progress(db: Session, job: HighlightJob, phase: str, percent: int, detail: str | None = None) -> None:
    metadata = dict(job.job_metadata or {})
    metadata["progress"] = _progress_payload(phase, percent, detail)
    updated = update_job(db, job.id, job_metadata=_json_safe(metadata))
    if updated:
        job.job_metadata = updated.job_metadata


def _delete_upload(video_path: str) -> None:
    if not DELETE_UPLOAD_AFTER_SUCCESS:
        return
    try:
        Path(video_path).unlink(missing_ok=True)
    except Exception:
        pass


def probe_video_dimensions(path: Path) -> tuple[int, int]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        width_raw, height_raw = result.stdout.strip().split("x")
        return int(width_raw), int(height_raw)
    except Exception:
        return 0, 0


def make_playback_proxy(src: Path, out: Path, target_h: int = 720) -> bool:
    tmp = out.with_name(f"{out.stem}.tmp{out.suffix}")
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp.unlink(missing_ok=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-vf",
                f"scale=-2:{target_h}",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-an",
                "-movflags",
                "+faststart",
                str(tmp),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        width, height = probe_video_dimensions(tmp)
        if width <= 0 or height <= 0:
            logger.warning("Playback proxy was created but failed validation: %s", tmp)
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(out)
        return True
    except subprocess.CalledProcessError as ex:
        logger.warning("Playback proxy ffmpeg failed: %s", (ex.stderr or ex.stdout or str(ex))[-2000:])
        tmp.unlink(missing_ok=True)
        return False
    except Exception:
        logger.exception("Playback proxy generation failed")
        tmp.unlink(missing_ok=True)
        return False


def create_player_proxy_for_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job or job.mode != "player" or not job.upload_path:
            return
        src = Path(job.upload_path)
        if not src.exists():
            metadata = dict(job.job_metadata or {})
            metadata["proxy_status"] = "error"
            update_job(db, job_id, job_metadata=_json_safe(metadata))
            return
        width, height = probe_video_dimensions(src)
        ok = make_playback_proxy(src, job_dir(job_id) / "proxy.mp4")
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        metadata = dict(job.job_metadata or {})
        metadata.update({
            "video_w": width or metadata.get("video_w", 0),
            "video_h": height or metadata.get("video_h", 0),
            "proxy_file": "proxy.mp4" if ok else None,
            "proxy_status": "done" if ok else "error",
        })
        update_job(db, job_id, job_metadata=_json_safe(metadata))
    finally:
        db.close()


def download_link_for_job(job_id: str) -> None:
    """Download an operator-submitted link into the upload dir via yt-dlp + aria2c."""
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        metadata = dict(job.job_metadata or {})
        url = metadata.get("source_url")
        if not url:
            update_job(db, job_id, status="error", error_message="다운로드할 링크가 없습니다.")
            return
        # Already downloaded.
        if job.upload_path and Path(job.upload_path).exists():
            return

        out_template = str(upload_dir() / f"{job_id}.%(ext)s")
        metadata["progress"] = _progress_payload("downloading", 5, "링크 다운로드 중")
        update_job(db, job_id, status="downloading", job_metadata=_json_safe(metadata))

        cmd = [
            "yt-dlp",
            "-f",
            "bv[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]",
            "--downloader",
            "aria2c",
            "--downloader-args",
            "aria2c:-x 16 -s 16 -k 1M",
            "--merge-output-format",
            "mp4",
            "-o",
            out_template,
            url,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as ex:
            detail = (ex.stderr or ex.stdout or str(ex))[-2000:]
            logger.warning("yt-dlp download failed for %s: %s", job_id, detail)
            update_job(db, job_id, status="error", error_message=f"링크 다운로드 실패: {detail[-300:]}")
            return
        except FileNotFoundError:
            update_job(db, job_id, status="error", error_message="yt-dlp 실행 파일을 찾을 수 없습니다.")
            return

        downloaded = sorted(upload_dir().glob(f"{job_id}.*"))
        downloaded = [p for p in downloaded if not p.name.endswith(".part")]
        if not downloaded:
            update_job(db, job_id, status="error", error_message="다운로드된 파일을 찾을 수 없습니다.")
            return

        final_path = downloaded[0]
        metadata = dict((db.get(HighlightJob, job_id).job_metadata) or {})
        metadata["progress"] = _progress_payload("ready", 100, "다운로드 완료")
        update_job(
            db,
            job_id,
            status="ready",
            upload_path=str(final_path),
            original_filename=final_path.name,
            job_metadata=_json_safe(metadata),
        )
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _ffmpeg_cut(src: Path, out: Path, start: float, duration: float) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", f"{max(0.0, start):.3f}",
                "-i", str(src),
                "-t", f"{max(0.1, duration):.3f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac",
                "-movflags", "+faststart",
                str(out),
            ],
            check=True, capture_output=True, text=True,
        )
        return out.exists()
    except subprocess.CalledProcessError as ex:
        logger.warning("ffmpeg cut failed: %s", (ex.stderr or ex.stdout or str(ex))[-1000:])
        return False
    except Exception:
        logger.exception("ffmpeg cut crashed")
        return False


def cut_clips_for_job(job_id: str, labels: list[float], before: float, after: float) -> None:
    """Cut one clip per label timestamp from the operator's source video."""
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job or not job.upload_path or not Path(job.upload_path).exists():
            update_job(db, job_id, status="error", error_message="원본 영상을 찾을 수 없습니다.")
            return
        src = Path(job.upload_path)
        out_dir = clips_dir(job_id)
        if out_dir.exists():
            shutil.rmtree(out_dir, ignore_errors=True)
        out_dir.mkdir(parents=True, exist_ok=True)

        ordered = sorted(float(x) for x in labels)
        total = len(ordered) or 1
        clip_info: list[dict[str, Any]] = []
        for i, label in enumerate(ordered):
            start = max(0.0, label - float(before))
            end = label + float(after)
            name = f"clip_{i + 1:03d}.mp4"
            metadata = dict((db.get(HighlightJob, job_id).job_metadata) or {})
            metadata["progress"] = _progress_payload("cutting", int(i / total * 100), f"클립 {i + 1}/{len(ordered)} 생성 중")
            update_job(db, job_id, status="processing", job_metadata=_json_safe(metadata))
            if _ffmpeg_cut(src, out_dir / name, start, end - start):
                clip_info.append({"name": name, "start": round(start, 2), "end": round(end, 2), "label": round(label, 2)})

        metadata = dict((db.get(HighlightJob, job_id).job_metadata) or {})
        metadata["clips"] = [c["name"] for c in clip_info]
        metadata["clip_info"] = clip_info
        metadata["progress"] = _progress_payload("clips_ready", 100, "클립 생성 완료")
        update_job(db, job_id, status="clips_ready", clips_dir=str(out_dir), job_metadata=_json_safe(metadata))
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def merge_clips_for_job(job_id: str) -> None:
    """Concatenate the job's current clips (in stored order) into a final export."""
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        metadata = dict(job.job_metadata or {})
        clip_names = metadata.get("clips") or []
        paths = [clips_dir(job_id) / str(n) for n in clip_names]
        paths = [p for p in paths if p.exists()]
        if not paths:
            update_job(db, job_id, status="error", error_message="합칠 클립이 없습니다.")
            return

        metadata["progress"] = _progress_payload("merging", 50, "클립 합치는 중")
        update_job(db, job_id, status="merging", job_metadata=_json_safe(metadata))

        list_file = job_dir(job_id) / "concat.txt"
        list_file.write_text("".join(f"file '{p.as_posix()}'\n" for p in paths))
        export_path = exports_dir() / f"{job_id}_export.mp4"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "concat", "-safe", "0",
                    "-i", str(list_file),
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-c:a", "aac",
                    "-movflags", "+faststart",
                    str(export_path),
                ],
                check=True, capture_output=True, text=True,
            )
        except subprocess.CalledProcessError as ex:
            detail = (ex.stderr or ex.stdout or str(ex))[-300:]
            update_job(db, job_id, status="error", error_message=f"합치기 실패: {detail}")
            return

        metadata = dict((db.get(HighlightJob, job_id).job_metadata) or {})
        metadata["progress"] = _progress_payload("done", 100, "하이라이트 제작 완료")
        update_job(db, job_id, status="done", export_path=str(export_path), job_metadata=_json_safe(metadata))
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _probe_start_time(path: Path) -> float:
    """클립이 원본 타임라인의 어디에서 시작하는지 읽는다.

    브라우저가 `-c copy -copyts` 로 자르기 때문에 클립은 원본 좌표를 그대로 갖고 있고,
    그 값이 곧 ffmpeg 이 실제로 붙잡은 키프레임 위치다.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=start_time",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            check=True, capture_output=True, text=True,
        )
        return float((result.stdout or "0").strip())
    except (subprocess.CalledProcessError, ValueError):
        # 시작점을 못 읽으면 0으로 두어 클립을 통째로 쓴다. 잘못 잘라내는 것보다 낫다.
        return 0.0


def _probe_video_dims(path: Path) -> tuple[int, int, str]:
    """클립의 가로·세로·프레임레이트를 읽는다. 인트로 이미지를 이 규격에 맞춘다.

    r_frame_rate 는 "30000/1001" 같은 분수 문자열이며 fps 필터가 그대로 받는다.
    읽지 못하면 720p/30fps 로 둔다 — 최악의 경우에도 인트로만 조금 어긋날 뿐이다.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            check=True, capture_output=True, text=True,
        )
        lines = [ln.strip() for ln in (result.stdout or "").splitlines() if ln.strip()]
        width = int(lines[0])
        height = int(lines[1])
        fps = lines[2] if len(lines) > 2 else ""
        if not fps or fps in {"0/0", "0"}:
            fps = "30"
        return width, height, fps
    except (subprocess.CalledProcessError, ValueError, IndexError):
        return 1280, 720, "30"


def merge_manual_clips_for_job(job_id: str) -> None:
    """수동 태깅 클립들을 정확한 지점으로 다듬어 하나로 합친다.

    브라우저는 키프레임 경계까지만 자를 수 있어 클립 앞쪽에 최대 한 GOP 만큼 여유가 붙는다.
    각 클립의 start_time 과 요청 구간의 차이가 그 여유분이므로, 입력마다 -ss/-t 를 걸고
    concat 필터로 묶어 재인코딩 한 번에 다듬기와 합치기를 동시에 처리한다.
    """
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        metadata = dict(job.job_metadata or {})
        clip_info = metadata.get("clip_info") or []
        if not clip_info:
            update_job(db, job_id, status="error", error_message="합칠 클립이 없습니다.")
            return

        metadata["progress"] = _progress_payload("merging", 30, "클립 다듬고 합치는 중")
        update_job(db, job_id, status="merging", job_metadata=_json_safe(metadata))

        # 먼저 쓸 수 있는 클립만 (경로·오프셋·길이) 로 모은다. 인트로 이미지를
        # 클립 해상도에 맞추려면 클립 하나의 규격을 먼저 알아야 하기 때문이다.
        clips_to_use: list[tuple[Path, float, float]] = []
        for info in clip_info:
            path = clips_dir(job_id) / str(info.get("name", ""))
            if not path.exists():
                continue
            try:
                req_start = float(info["requested_start"])
                req_end = float(info["requested_end"])
            except (KeyError, TypeError, ValueError):
                continue
            duration = req_end - req_start
            if duration <= 0:
                continue
            offset = max(0.0, req_start - _probe_start_time(path))
            clips_to_use.append((path, offset, duration))

        used = len(clips_to_use)
        if used == 0:
            update_job(db, job_id, status="error", error_message="유효한 클립이 없습니다.")
            return

        # 인트로 이미지가 있으면 클립 앞에 정지영상(무음) 세그먼트로 붙인다.
        intro_name = str(metadata.get("intro_image") or "").strip()
        intro_path = clips_dir(job_id) / intro_name if intro_name else None
        try:
            intro_dur = float(metadata.get("intro_duration") or INTRO_SEC)
        except (TypeError, ValueError):
            intro_dur = INTRO_SEC
        has_intro = bool(intro_path) and intro_path.exists() and intro_dur > 0
        if has_intro:
            iw, ih, ifps = _probe_video_dims(clips_to_use[0][0])

        args: list[str] = ["ffmpeg", "-y"]
        # 인트로 입력은 맨 앞에 둬 클립 입력 인덱스가 그 뒤로 밀리게 한다.
        if has_intro:
            args += ["-loop", "1", "-t", f"{intro_dur:.3f}", "-i", str(intro_path)]
            args += [
                "-f", "lavfi", "-t", f"{intro_dur:.3f}",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            ]
            clip_base = 2
        else:
            clip_base = 0

        for path, offset, duration in clips_to_use:
            args += ["-ss", f"{offset:.3f}", "-t", f"{duration:.3f}", "-i", str(path)]

        # 클립 사이는 하드컷이다(페이드 없음). concat 필터는 모든 입력이 같은 스트림
        # 구성을 가져야 하는데 원본이 하나라 클립들의 코덱·해상도는 항상 동일하다.
        # 인트로가 붙을 때만 이미지를 그 규격에 맞추고 앞뒤로 부드럽게 페이드한다.
        chains: list[str] = []
        segments: list[tuple[str, str]] = []

        if has_intro:
            ifade = INTRO_FADE_SEC
            # 이미지를 클립 해상도·fps·SAR·픽셀포맷에 맞추고, 처음에 검정에서 페이드인만 한다.
            # 끝에는 페이드아웃하지 않아 인트로가 밝게 유지되다 첫 클립으로 바로 하드컷된다
            # (인트로→클립 사이 검정 구간 없음). 인트로 오디오는 무음이라 그대로 통과시킨다.
            chains.append(
                f"[0:v]scale={iw}:{ih}:force_original_aspect_ratio=decrease,"
                f"pad={iw}:{ih}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={ifps},format=yuv420p,"
                f"fade=t=in:st=0:d={ifade:.3f}[vintro]"
            )
            segments.append(("[vintro]", "[1:a]"))

        for k in range(used):
            idx = clip_base + k
            if has_intro:
                # 인트로와 규격을 맞추려 SAR·픽셀포맷만 통일한다(페이드는 걸지 않는다).
                chains.append(f"[{idx}:v]setsar=1,format=yuv420p[v{idx}]")
                segments.append((f"[v{idx}]", f"[{idx}:a]"))
            else:
                # 필터 없이 원본 스트림을 그대로 concat 한다.
                segments.append((f"[{idx}:v]", f"[{idx}:a]"))

        n_seg = len(segments)
        concat_inputs = "".join(v + a for v, a in segments)
        # 인트로가 없으면 전처리 체인이 비어 있다. 그때 앞에 세미콜론이 붙지 않게 한다.
        prefix = ";".join(chains)
        filter_complex = (f"{prefix};" if prefix else "") + (
            f"{concat_inputs}concat=n={n_seg}:v=1:a=1[v][a]"
        )
        export_path = exports_dir() / f"{job_id}_export.mp4"
        args += [
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", MERGE_PRESET, "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            str(export_path),
        ]

        try:
            subprocess.run(args, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as ex:
            detail = (ex.stderr or ex.stdout or str(ex))[-300:]
            update_job(db, job_id, status="error", error_message=f"합치기 실패: {detail}")
            return

        metadata = dict((db.get(HighlightJob, job_id).job_metadata) or {})
        metadata["progress"] = _progress_payload("done", 100, "하이라이트 제작 완료")
        update_job(
            db, job_id,
            status="done",
            export_path=str(export_path),
            job_metadata=_json_safe(metadata),
        )
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def run_analysis_for_job(job_id: str, yolo_model: object, xgb_model: object | None = None) -> None:
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        if job.mode == "operator":
            # Operator jobs are processed inline by the API, not by AI analysis.
            return
        update_job(
            db,
            job_id,
            status="processing",
            error_message=None,
            job_metadata=_json_safe({
                **(job.job_metadata or {}),
                "progress": _progress_payload("starting", 1, "작업 준비 중"),
            }),
        )

        if yolo_model is None:
            update_job(db, job_id, status="error", error_message="YOLO 모델이 로드되지 않았습니다.")
            return
        if not job.upload_path or not Path(job.upload_path).exists():
            update_job(db, job_id, status="error", error_message="업로드된 영상 파일을 찾을 수 없습니다.")
            return

        metadata = job.job_metadata or {}
        highlight_count = int(metadata.get("highlight_count", 40))
        if job.mode == "player":
            _run_player_detection(db, job, yolo_model)
        elif job.mode == "log_ai":
            _run_log_analysis(db, job, yolo_model, xgb_model, highlight_count)
        else:
            _run_ai_analysis(db, job, yolo_model, xgb_model, highlight_count)
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _run_player_detection(db: Session, job: HighlightJob, yolo_model: object) -> None:
    import pandas as pd

    from .player_clip_extract import compute_possession_events, run_player_detection

    if not job.upload_path:
        update_job(db, job.id, status="error", error_message="업로드된 영상 파일을 찾을 수 없습니다.")
        return

    src = Path(job.upload_path)
    out_dir = job_dir(job.id)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = run_player_detection(
        str(src),
        str(out_dir),
        yolo_model,
        progress_cb=lambda percent, stage: _update_progress(db, job, "detecting_player", percent, stage),
    )
    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    det_df = pd.read_csv(out_dir / result.detection_file)
    events = compute_possession_events(det_df, result.fps)
    width, height = probe_video_dimensions(src)

    metadata = {
        **(job.job_metadata or {}),
        "mode": "player",
        "fps": result.fps,
        "detection_file": result.detection_file,
        "video_file": src.name,
        "n_frames": result.n_frames,
        "n_player_tracks": result.n_player_tracks,
        "video_w": width,
        "video_h": height,
        "proxy_file": None,
        "proxy_status": None,
        "events": events,
        "clips": [],
        "selected": {},
        "message": result.message,
        "progress": _progress_payload("done", 100, "개인클립 탐지 완료"),
    }
    update_job(
        db,
        job.id,
        status="done",
        clips_dir=str(clips_dir(job.id)),
        job_metadata=_json_safe(metadata),
    )


def _run_ai_analysis(
    db: Session,
    job: HighlightJob,
    yolo_model: object,
    xgb_model: object | None,
    highlight_count: int,
) -> None:
    from .highlight_pipeline import CLIP_DURATION_AFTER, CLIP_DURATION_BEFORE, run_highlight_pipeline

    out_dir = str(clips_dir(job.id))
    result = run_highlight_pipeline(
        video_path=str(job.upload_path),
        output_dir=out_dir,
        yolo_model=yolo_model,
        xgb_model=xgb_model,
        highlight_count=highlight_count,
        progress_callback=lambda payload: _update_progress(
            db,
            job,
            str(payload.get("phase") or "processing"),
            int(payload.get("percent") or 0),
            str(payload.get("detail") or ""),
        ),
    )

    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    fps_val = float(result.fps or 30.0)
    clip_files = [Path(p).name for p in (result.clip_paths or [])]
    clip_scores_by_name: dict[str, float] = {}
    clip_features_by_name: dict[str, str] = {}
    clip_feature_stats_by_name: dict[str, dict] = {}
    clip_timestamps: dict[str, dict] = {}

    frames = result.highlight_frames or []
    feats = result.clip_features or []
    feat_stats = result.clip_feature_stats or {}
    scores = result.clip_scores or {}

    for i, name in enumerate(clip_files):
        frame = frames[i] if i < len(frames) else None
        if frame is not None:
            anchor_sec = frame / fps_val
            clip_timestamps[name] = {
                "start": round(max(0.0, anchor_sec - CLIP_DURATION_BEFORE), 1),
                "end": round(anchor_sec + CLIP_DURATION_AFTER, 1),
            }
            clip_scores_by_name[name] = scores.get(frame, 0.0)
            if frame in feat_stats:
                clip_feature_stats_by_name[name] = feat_stats[frame]
        if i < len(feats):
            clip_features_by_name[name] = feats[i]

    metadata = {
        **(job.job_metadata or {}),
        "progress": _progress_payload("done", 100, "하이라이트 추출 완료"),
        "clips": clip_files,
        "selected": {},
        "clip_scores": clip_scores_by_name,
        "clip_features": clip_features_by_name,
        "clip_feature_stats": clip_feature_stats_by_name,
        "clip_timestamps": clip_timestamps,
        "message": result.message,
    }
    _delete_upload(str(job.upload_path))
    update_job(db, job.id, status="done", upload_path=None, clips_dir=out_dir, job_metadata=_json_safe(metadata))


def _run_log_analysis(
    db: Session,
    job: HighlightJob,
    yolo_model: object,
    xgb_model: object | None,
    highlight_count: int,
) -> None:
    from .highlight_pipeline import (
        CLIP_DURATION_AFTER,
        CLIP_DURATION_BEFORE,
        LOG_CLIP_AFTER,
        LOG_CLIP_BEFORE,
        LOG_CLIP_MINUTE_SPAN,
        run_log_pipeline,
    )

    metadata = job.job_metadata or {}
    out_dir = str(clips_dir(job.id))
    result = run_log_pipeline(
        video_path=str(job.upload_path),
        log_data=metadata.get("log_data", []),
        second_half_start_sec=float(metadata.get("second_half_start_sec", 0.0)),
        output_dir=out_dir,
        target_count=highlight_count,
        yolo_model=yolo_model,
        xgb_model=xgb_model,
        progress_callback=lambda payload: _update_progress(
            db,
            job,
            str(payload.get("phase") or "processing"),
            int(payload.get("percent") or 0),
            str(payload.get("detail") or ""),
        ),
    )

    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    fps_val = float(result.fps or 30.0)
    clip_files = [Path(p).name for p in (result.clip_paths or [])]
    clip_timestamps: dict[str, dict] = {}

    for item in result.events or []:
        if item.get("source") == "log":
            name = item["clip"]
            video_sec = float(item.get("video_sec", 0))
            clip_timestamps[name] = {
                "start": round(max(0.0, video_sec - LOG_CLIP_MINUTE_SPAN - LOG_CLIP_BEFORE), 1),
                "end": round(video_sec + LOG_CLIP_AFTER, 1),
            }

    log_clip_names = set(clip_timestamps.keys())
    ai_names = [name for name in clip_files if name not in log_clip_names]
    ai_frames = result.highlight_frames or []
    for i, name in enumerate(ai_names):
        frame = ai_frames[i] if i < len(ai_frames) else None
        if frame is not None:
            anchor_sec = frame / fps_val
            clip_timestamps[name] = {
                "start": round(max(0.0, anchor_sec - CLIP_DURATION_BEFORE), 1),
                "end": round(anchor_sec + CLIP_DURATION_AFTER, 1),
            }

    merged_metadata = {
        **metadata,
        "progress": _progress_payload("done", 100, "하이라이트 추출 완료"),
        "clips": clip_files,
        "selected": {},
        "clip_scores": result.clip_scores,
        "clip_features": result.clip_features,
        "clip_feature_stats": result.clip_feature_stats,
        "clip_timestamps": clip_timestamps,
        "events": result.events,
        "message": result.message,
    }
    _delete_upload(str(job.upload_path))
    update_job(db, job.id, status="done", upload_path=None, clips_dir=out_dir, job_metadata=_json_safe(merged_metadata))


def delete_job_files(job: HighlightJob) -> None:
    path = job_dir(job.id)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    if job.upload_path:
        try:
            Path(job.upload_path).unlink(missing_ok=True)
        except Exception:
            pass
    if job.export_path:
        try:
            Path(job.export_path).unlink(missing_ok=True)
        except Exception:
            pass
