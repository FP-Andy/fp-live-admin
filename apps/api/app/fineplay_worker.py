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
from .scoreboard import board_placement, render_scoreboard_file
from .watermark import (
    DEFAULT_OPACITY as WM_DEFAULT_OPACITY,
    DEFAULT_POS_X as WM_DEFAULT_POS_X,
    DEFAULT_POS_Y as WM_DEFAULT_POS_Y,
    DEFAULT_SIZE_PCT as WM_DEFAULT_SIZE_PCT,
    mark_placement,
    render_watermark_file,
)

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
    youtube_path: Callable[[str], Path] | None = None,
    overlay: dict | None = None,
) -> dict:
    """확정된 매니페스트 + 클립 구간으로 영상을 만들어 올리고 결과 payload 를 반환한다.

    youtube_path 는 유튜브 원본의 로컬 파일 자리를 알려 주는 함수다. 유튜브 영상은
    S3 에 없어서 presign 할 키가 없고, 대신 미리 받아 둔 파일을 그대로 읽는다.

    overlay 는 클립에 새길 점수판·로고 설정이다({"scoreboard": {...}, "watermark": {...}}).
    없으면 아무것도 얹지 않는다(종전과 같다).
    """
    if workdir is not None:
        workdir.mkdir(parents=True, exist_ok=True)
        return _process_in(workdir, manifest, clip_specs, storage, pipeline_version,
                           youtube_path, overlay)
    with tempfile.TemporaryDirectory(prefix="fpc_job_") as tmp:
        return _process_in(Path(tmp), manifest, clip_specs, storage, pipeline_version,
                           youtube_path, overlay)


def _process_in(
    work: Path,
    manifest: Manifest,
    clip_specs: list[ClipSpec],
    storage: Storage,
    pipeline_version: str,
    youtube_path: Callable[[str], Path] | None = None,
    overlay: dict | None = None,
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
        if video.is_youtube:
            # 유튜브 원본은 미리 받아 둔 로컬 파일을 읽는다. presign 도 폴백 다운로드도
            # 걸 데가 없으므로(S3 키가 아예 없다) 여기서 자리를 못 박는다.
            if youtube_path is None:
                raise RuntimeError(
                    f"유튜브 원본을 읽을 수 없습니다(경로 미지정): {spec.source_video_id}"
                )
            local = youtube_path(video.video_id)
            if not local.exists() or local.stat().st_size == 0:
                raise RuntimeError(
                    f"유튜브 원본이 아직 없습니다: {video.video_id} — 먼저 받아야 합니다."
                )
            src.local = local
            sources[spec.source_video_id] = src
            continue
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

    # ── 오버레이(점수판·로고) ────────────────────────────────────────────
    # 수동 하이라이트와 같은 그림을 클립마다 새긴다. 클립은 각자 따로 나가므로 점수는
    # '그 클립 시점의 점수' 다 — 클립 안에서 골이 나면 그 지점에서 바뀐다.
    overlay_dir = work / "overlay"
    _sb_cache: dict[tuple[int, int], Path] = {}
    _overlay_geom: dict[str, object] = {}

    def _prepare_overlay(sample: Path | str) -> None:
        """첫 클립 규격으로 자리와 로고를 한 번만 정한다."""
        if _overlay_geom or not overlay:
            return
        vw, vh, _ = _probe_video_dims(sample)
        _overlay_geom["w"] = vw
        _overlay_geom["h"] = vh
        board = overlay.get("scoreboard") or {}
        if board.get("enabled"):
            bw, _bh, bx, by = board_placement(
                vw, vh,
                float(board.get("size_pct") or 24.33),
                float(board.get("pos_x") or 0),
                float(board.get("pos_y") or 0),
                with_logo=False,
            )
            _overlay_geom["board"] = (bw, bx, by)
        mark = overlay.get("watermark") or {}
        if mark.get("enabled"):
            mw, _mh, mx, my = mark_placement(
                vw, vh,
                float(mark.get("size_pct") or WM_DEFAULT_SIZE_PCT),
                float(mark.get("pos_x") or WM_DEFAULT_POS_X),
                float(mark.get("pos_y") or WM_DEFAULT_POS_Y),
            )
            try:
                _overlay_geom["mark"] = (
                    render_watermark_file(overlay_dir / "wm.png", mw,
                                          float(mark.get("opacity") or WM_DEFAULT_OPACITY)),
                    mx, my,
                )
            except (OSError, ValueError):
                pass   # 로고를 못 그리면 로고만 빼고 계속한다

    def _board_png(score: tuple[int, int]) -> Path:
        cached = _sb_cache.get(score)
        if cached is None:
            board = (overlay or {}).get("scoreboard") or {}
            bw = _overlay_geom["board"][0]  # type: ignore[index]
            cached = render_scoreboard_file(
                overlay_dir / f"sb_{score[0]}_{score[1]}.png",
                str(board.get("home_name") or ""), str(board.get("away_name") or ""),
                score[0], score[1], bw,
                board.get("home_color"), board.get("away_color"), None,
            )
            _sb_cache[score] = cached
        return cached

    def _overlays_for(spec: ClipSpec) -> list[dict]:
        if not overlay or not _overlay_geom:
            return []
        marks: list[dict] = []
        if "board" in _overlay_geom and spec.score_before and spec.score_after:
            _bw, bx, by = _overlay_geom["board"]        # type: ignore[misc]
            before = tuple(spec.score_before)
            after = tuple(spec.score_after)
            length = max(0.0, spec.end - spec.start)
            at = spec.goal_at
            if before == after or at is None or at <= 0 or at >= length:
                # 클립 안에서 점수가 바뀌지 않는다 — 한 장이면 된다.
                marks.append({"path": _board_png(after if before == after else before),
                              "x": bx, "y": by})
            else:
                # 태깅한 그 순간 점수가 오른다. 마지막 구간은 gte 로 열어 둔다 —
                # between 은 끝 프레임이 부동소수 오차로 넘어가면 판이 한 프레임 사라진다.
                marks.append({"path": _board_png(before), "x": bx, "y": by,
                              "enable": f"lt(t,{at:.3f})"})
                marks.append({"path": _board_png(after), "x": bx, "y": by,
                              "enable": f"gte(t,{at:.3f})"})
        if "mark" in _overlay_geom:
            wm_path, mx, my = _overlay_geom["mark"]      # type: ignore[misc]
            marks.append({"path": wm_path, "x": mx, "y": my})
        return marks

    def render_one(spec: ClipSpec) -> ClipOutput:
        src = sources[spec.source_video_id]

        local_h = work / f"{spec.clip_id}.mp4"
        _prepare_overlay(src.target)
        marks = _overlays_for(spec)
        try:
            produce_clip(src.target, spec.start, spec.end, local_h,
                         has_audio=src.has_audio, overlays=marks)
        except RuntimeError:
            if src.local is not None:
                raise  # 이미 로컬 파일로 렌더하다 실패 — 폴백 없음
            # URL 렌더 실패(만료·네트워크·moov 파싱 등) → 통짜 다운로드 폴백 후 재시도.
            local = src.ensure_local(storage, work / "src" / f"{spec.source_video_id}.mp4")
            if src.has_audio is None:
                src.has_audio = _probe_has_audio(local)
            produce_clip(local, spec.start, spec.end, local_h,
                         has_audio=src.has_audio, overlays=marks)

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
