"""하이라이트 생성 오케스트레이션 (Phase 0 스캐폴딩).

S3 원본 key + 구간 목록을 받아: 원본 download → produce(ffmpeg 1-pass) → 결과 upload.
DB·큐를 모른다. 스토리지는 주입받으므로(Storage 프로토콜), 로컬 fake 로 단위 테스트된다.

지금은 API 의 BackgroundTask 로 인라인 호출해도 되고, 나중에 SQS 워커가 그대로
`run_produce()` 를 호출하게 하면 큐 기반으로 옮겨진다(호출부만 교체).
"""

from __future__ import annotations

import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .highlight_produce import (
    INTRO_SEC,
    MERGE_PRESET,
    Segment,
    produce_highlight_from_source,
)
from .highlight_storage import Storage, output_prefix


@dataclass
class ProduceSpec:
    """생성 요청 명세. 원본은 이미 스토리지에 있다고 전제한다."""

    source_key: str
    segments: list[Segment]
    output_key: str | None = None  # 없으면 자동 생성
    intro_key: str | None = None
    intro_duration: float = INTRO_SEC
    preset: str = MERGE_PRESET

    def resolved_output_key(self) -> str:
        if self.output_key:
            return self.output_key
        return f"{output_prefix()}{uuid.uuid4().hex}.mp4"


@dataclass
class ProduceResult:
    output_key: str
    output_bytes: int
    duration_sec: float | None = None
    warnings: list[str] = field(default_factory=list)


def _probe_duration(path: Path) -> float | None:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            check=True, capture_output=True, text=True,
        )
        return float((result.stdout or "").strip())
    except (subprocess.CalledProcessError, ValueError):
        return None


def run_produce(spec: ProduceSpec, storage: Storage, *, workdir: Path | None = None) -> ProduceResult:
    """원본을 내려받아 하이라이트를 만들고 스토리지에 올린다. 결과 메타를 반환.

    workdir 를 주면 그 안에서 작업하고(테스트/재현), 안 주면 임시 디렉토리를 쓴다.
    """
    if not spec.segments:
        raise ValueError("segments 가 비어 있습니다.")

    output_key = spec.resolved_output_key()

    if workdir is not None:
        workdir.mkdir(parents=True, exist_ok=True)
        return _run_in(workdir, spec, storage, output_key)

    with tempfile.TemporaryDirectory(prefix="hl_produce_") as tmp:
        return _run_in(Path(tmp), spec, storage, output_key)


def _run_in(work: Path, spec: ProduceSpec, storage: Storage, output_key: str) -> ProduceResult:
    warnings: list[str] = []

    source = work / "source" / Path(spec.source_key).name
    storage.download(spec.source_key, source)

    intro_path: Path | None = None
    if spec.intro_key:
        try:
            suffix = Path(spec.intro_key).suffix or ".jpg"
            intro_path = work / f"intro{suffix}"
            storage.download(spec.intro_key, intro_path)
        except Exception as ex:  # 인트로 실패는 치명적이지 않다 — 없이 진행
            warnings.append(f"인트로 내려받기 실패, 인트로 없이 진행: {ex}")
            intro_path = None

    out = work / "highlight.mp4"
    produce_highlight_from_source(
        source,
        spec.segments,
        out,
        intro_image=intro_path,
        intro_duration=spec.intro_duration,
        preset=spec.preset,
    )

    storage.upload(out, output_key, content_type="video/mp4")

    return ProduceResult(
        output_key=output_key,
        output_bytes=out.stat().st_size,
        duration_sec=_probe_duration(out),
        warnings=warnings,
    )
