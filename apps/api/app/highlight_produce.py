"""서버사이드 하이라이트 생성 (Phase 0).

이상적 아키텍처의 핵심: 브라우저에서 자르고 클립을 업로드하는 대신, 원본 하나와
구간 목록만 받아 **서버에서 ffmpeg 한 번**으로 컷+머지+인코딩을 끝낸다.

  - 같은 원본을 구간마다 `-ss/-t` 로 여러 번 입력한다. `-ss` 를 `-i` 앞에 두면
    키프레임까지 fast-seek 하고, accurate_seek(기본 on) + 재인코딩이라 프레임 정확하다.
  - 인트로 사진(선택)은 맨 앞에 정지영상(무음)으로 붙이고 페이드인만 준다.
  - 클립 사이는 하드컷. 인트로/페이드/프리셋 정책은 highlight_jobs 의 합치기와 동일.

이 모듈은 DB·S3 를 모른다. 로컬 파일 경로만 다뤄서 단위 테스트가 쉽다.
S3 연동(원본 download → produce → 결과 upload)은 이 위에 얇게 얹는다.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# highlight_jobs 와 같은 env 키를 읽어 정책을 일치시킨다(모듈 결합은 피한다).
INTRO_SEC = float(os.getenv("HIGHLIGHT_INTRO_SEC", "1.8"))
INTRO_FADE_SEC = float(os.getenv("HIGHLIGHT_INTRO_FADE_SEC", "0.3"))
MERGE_PRESET = os.getenv("HIGHLIGHT_MERGE_PRESET", "ultrafast")
MERGE_CRF = os.getenv("HIGHLIGHT_MERGE_CRF", "23")


@dataclass
class Segment:
    """원본 타임라인 기준 하이라이트 구간(초)."""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def _probe_video_dims(path: Path) -> tuple[int, int, str]:
    """원본의 가로·세로·프레임레이트. 인트로 이미지를 이 규격에 맞춘다.

    r_frame_rate 는 "30000/1001" 같은 분수라 fps 필터가 그대로 받는다.
    읽지 못하면 720p/30fps 로 둔다.
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


def build_produce_args(
    source: Path,
    segments: list[Segment],
    out_path: Path,
    *,
    intro_image: Path | None = None,
    intro_duration: float = INTRO_SEC,
    preset: str = MERGE_PRESET,
    crf: str = MERGE_CRF,
) -> list[str]:
    """단일 원본 + 구간들로 컷+머지 ffmpeg 인자를 만든다.

    유효한 구간이 없으면 ValueError. 반환값은 subprocess 로 그대로 실행 가능한 argv.
    """
    valid = [s for s in segments if s.duration > 0]
    if not valid:
        raise ValueError("유효한 구간이 없습니다 (end > start 인 구간 필요).")

    has_intro = bool(intro_image) and intro_image.exists() and intro_duration > 0
    if has_intro:
        iw, ih, ifps = _probe_video_dims(source)

    args: list[str] = ["ffmpeg", "-y"]

    # 인트로 입력을 맨 앞에 둬 구간 입력 인덱스가 그 뒤로 밀리게 한다.
    if has_intro:
        args += ["-loop", "1", "-t", f"{intro_duration:.3f}", "-i", str(intro_image)]
        args += [
            "-f", "lavfi", "-t", f"{intro_duration:.3f}",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        ]
        clip_base = 2
    else:
        clip_base = 0

    # 같은 원본을 구간마다 fast-seek 로 입력한다. -ss 가 -i 앞이라 accurate_seek 로 정확.
    for seg in valid:
        args += ["-ss", f"{seg.start:.3f}", "-t", f"{seg.duration:.3f}", "-i", str(source)]

    chains: list[str] = []
    segs: list[tuple[str, str]] = []

    if has_intro:
        ifade = INTRO_FADE_SEC
        chains.append(
            f"[0:v]scale={iw}:{ih}:force_original_aspect_ratio=decrease,"
            f"pad={iw}:{ih}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={ifps},format=yuv420p,"
            f"fade=t=in:st=0:d={ifade:.3f}[vintro]"
        )
        segs.append(("[vintro]", "[1:a]"))

    n = len(valid)
    for k in range(n):
        idx = clip_base + k
        if has_intro:
            # 인트로와 규격을 맞춘다(하드컷이라 페이드는 없음).
            chains.append(f"[{idx}:v]setsar=1,format=yuv420p[v{idx}]")
            segs.append((f"[v{idx}]", f"[{idx}:a]"))
        else:
            segs.append((f"[{idx}:v]", f"[{idx}:a]"))

    n_seg = len(segs)
    concat_inputs = "".join(v + a for v, a in segs)
    prefix = ";".join(chains)
    filter_complex = (f"{prefix};" if prefix else "") + (
        f"{concat_inputs}concat=n={n_seg}:v=1:a=1[v][a]"
    )

    args += [
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-c:a", "aac",
        "-movflags", "+faststart",
        str(out_path),
    ]
    return args


def produce_highlight_from_source(
    source: Path,
    segments: list[Segment],
    out_path: Path,
    **opts: object,
) -> Path:
    """원본에서 하이라이트를 만들어 out_path 에 쓴다. 실패 시 RuntimeError."""
    args = build_produce_args(source, segments, out_path, **opts)  # type: ignore[arg-type]
    _run(args, "하이라이트 생성 실패")
    return out_path


def produce_clip(source: Path, start: float, end: float, out_path: Path, *, preset: str = MERGE_PRESET, crf: str = MERGE_CRF) -> Path:
    """단일 구간을 하나의 클립으로 렌더한다(인트로/워터마크 없음). FinePlay 계약의 클립 단위 산출용."""
    return produce_highlight_from_source(
        source, [Segment(start, end)], out_path, intro_image=None, preset=preset, crf=crf
    )


def extract_thumbnail(video: Path, out_path: Path, at: float = 0.5) -> Path:
    """클립에서 대표 프레임 한 장을 뽑아 썸네일(jpg)로 저장한다. FinePlay 계약상 썸네일은 필수."""
    args = [
        "ffmpeg", "-y",
        "-ss", f"{max(0.0, at):.3f}", "-i", str(video),
        "-frames:v", "1", "-q:v", "2",
        str(out_path),
    ]
    _run(args, "썸네일 생성 실패")
    return out_path


def make_vertical_9x16(video: Path, out_path: Path, *, preset: str = MERGE_PRESET, crf: str = MERGE_CRF) -> Path:
    """가로 클립을 9:16(1080x1920) 세로로 만든다. 소스를 채우도록 확대 후 중앙 크롭.

    소장/다운로드용 세로 클립(FinePlay 계약의 verticalS3Key, 선택 산출물).
    """
    vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
    args = [
        "ffmpeg", "-y", "-i", str(video),
        "-vf", vf,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-c:a", "aac", "-movflags", "+faststart",
        str(out_path),
    ]
    _run(args, "세로 클립 생성 실패")
    return out_path


def _run(args: list[str], err_prefix: str) -> None:
    try:
        subprocess.run(args, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as ex:
        detail = (ex.stderr or ex.stdout or str(ex))[-500:]
        raise RuntimeError(f"{err_prefix}: {detail}") from ex
