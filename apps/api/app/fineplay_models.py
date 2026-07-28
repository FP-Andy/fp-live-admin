"""FinePlay ↔ FPC 연동 모델 — 영상 왕복(전송)만. 분석 지표(§8)는 제외.

매니페스트(INPUT)에서는 원본을 찾는 데 필요한 것만 파싱하고, 라인업·xFP 컨텍스트 등
분석용 필드는 raw 로 통째 보관해 두었다가 나중에 채운다.
결과(OUTPUT)는 클립 전송 정보(파일 s3Key + 구간)만 담는다 — teamView/playerView 미포함.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ManifestVideo:
    video_id: str
    s3_key: str
    duration_seconds: float | None = None
    resolution: str | None = None


@dataclass
class Manifest:
    analysis_request_id: int | str
    team_id: int | str | None
    videos: list[ManifestVideo]
    raw: dict[str, Any] = field(default_factory=dict)

    def video_by_id(self, video_id: str) -> ManifestVideo | None:
        return next((v for v in self.videos if str(v.video_id) == str(video_id)), None)

    @property
    def primary_video(self) -> ManifestVideo | None:
        return self.videos[0] if self.videos else None


def parse_manifest(data: dict[str, Any]) -> Manifest:
    team = data.get("team") or {}
    videos = [
        ManifestVideo(
            video_id=str(v.get("videoId")),
            s3_key=str(v.get("s3Key") or ""),
            duration_seconds=v.get("durationSeconds"),
            resolution=v.get("resolution"),
        )
        for v in (data.get("videos") or [])
        if v.get("s3Key")
    ]
    return Manifest(
        analysis_request_id=data.get("analysisRequestId"),
        team_id=team.get("teamId"),
        videos=videos,
        raw=data,
    )


@dataclass
class ClipSpec:
    """무엇을 렌더할지: 원본 영상 안의 한 구간. 어떤 구간이냐(태깅/AI)는 이 모듈 밖의 관심사."""

    source_video_id: str
    start: float
    end: float
    clip_id: str  # fpcClipId (멱등 키). 파일명·결과 매칭에 동일 사용.
    main_action: str | None = None
    make_vertical: bool = False


@dataclass
class ClipOutput:
    clip_id: str
    source_video_id: str
    start: float
    end: float
    horizontal_s3_key: str
    thumbnail_s3_key: str
    vertical_s3_key: str | None = None
    duration_seconds: float | None = None
    resolution: str | None = None
    main_action: str | None = None

    def to_result_clip(self) -> dict[str, Any]:
        """결과 콜백(§6-2)의 clips[] 한 항목. 분석 지표(teamView/playerView)는 비워 둔다."""
        video: dict[str, Any] = {
            "horizontalS3Key": self.horizontal_s3_key,
            "thumbnailS3Key": self.thumbnail_s3_key,
        }
        if self.vertical_s3_key:
            video["verticalS3Key"] = self.vertical_s3_key
        if self.duration_seconds is not None:
            video["durationSeconds"] = round(self.duration_seconds, 3)
        if self.resolution:
            video["resolution"] = self.resolution
        clip: dict[str, Any] = {
            # 서버 인입 DTO 는 clipKey 만 읽는다(fpcClipId 는 무시됨). 편집룸 등
            # 콘솔 내부 코드가 fpcClipId 를 읽고 있어 당분간 둘 다 보낸다.
            "clipKey": self.clip_id,
            "fpcClipId": self.clip_id,
            "sourceVideoId": self.source_video_id,
            "startTime": round(self.start, 3),
            "endTime": round(self.end, 3),
            "highlightVideo": video,
        }
        if self.main_action:
            clip["mainAction"] = self.main_action
        return clip


def build_result_payload(
    analysis_request_id: int | str,
    team_id: int | str | None,
    clips: list[ClipOutput],
    *,
    pipeline_version: str,
    status: str = "DONE",
) -> dict[str, Any]:
    """analysis-results 콜백 body (전송 전용). status: DONE / PARTIAL / FAILED."""
    return {
        "analysisRequestId": analysis_request_id,
        "teamId": team_id,
        "pipelineVersion": pipeline_version,
        "status": status,
        "clips": [c.to_result_clip() for c in clips],
    }


def output_key(team_id: int | str | None, request_id: int | str, clip_id: str, kind: str = "horizontal") -> str:
    """§6-1 키 규칙: highlights/{teamId}/{requestId}/{clipId}[...]."""
    base = f"highlights/{team_id}/{request_id}/{clip_id}"
    if kind == "horizontal":
        return f"{base}.mp4"
    if kind == "vertical":
        return f"{base}_9x16.mp4"
    if kind == "thumbnail":
        return f"{base}_thumb.jpg"
    raise ValueError(f"알 수 없는 kind: {kind}")
