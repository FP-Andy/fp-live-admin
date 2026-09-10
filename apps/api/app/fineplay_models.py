"""FinePlay ↔ FPC 연동 모델 — 영상 왕복(전송)만. 분석 지표(§8)는 제외.

매니페스트(INPUT)에서는 원본을 찾는 데 필요한 것만 파싱하고, 라인업·xFP 컨텍스트 등
분석용 필드는 raw 로 통째 보관해 두었다가 나중에 채운다.
결과(OUTPUT)는 클립 전송 정보(파일 s3Key + 구간)만 담는다 — teamView/playerView 미포함.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# 매니페스트가 알려 주는 원본의 출처. 둘 다 분석 대상이고, 가져오는 길만 다르다.
SOURCE_UPLOAD = "UPLOAD"      # 팀이 올린 파일 — S3 에 있다
SOURCE_YOUTUBE = "YOUTUBE"    # 팀이 링크만 준 것 — 우리가 직접 받아야 한다


@dataclass
class ManifestVideo:
    video_id: str
    s3_key: str = ""
    # 2026-07-27 계약 변경으로 유튜브는 URL 이 그대로 온다(예전엔 저쪽이 S3 로 받아줬다).
    source: str = SOURCE_UPLOAD
    youtube_url: str = ""
    duration_seconds: float | None = None
    resolution: str | None = None

    @property
    def is_youtube(self) -> bool:
        return self.source == SOURCE_YOUTUBE


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


def _parse_video(v: dict[str, Any]) -> ManifestVideo | None:
    """매니페스트의 videos[] 한 줄. 가져올 길이 없으면 None.

    ⚠️ s3Key 만 보고 거르면 **유튜브 신청이 통째로 사라진다.** 유튜브 항목은 s3Key 가
    null 이고, 저쪽이 null 필드를 아예 생략하므로 키 자체가 없을 수도 있다(2026-09-10
    "매니페스트에 영상이 없습니다" 가 이 때문이었다). source 를 먼저 보고, 옛 매니페스트나
    source 가 빠진 경우를 대비해 어느 쪽 값이 들어 있는지로도 판별한다.
    """
    s3_key = str(v.get("s3Key") or "").strip()
    youtube_url = str(v.get("youtubeUrl") or "").strip()
    source = str(v.get("source") or "").strip().upper()
    if not source:
        source = SOURCE_YOUTUBE if youtube_url else SOURCE_UPLOAD
    if source == SOURCE_YOUTUBE and not youtube_url:
        return None
    if source != SOURCE_YOUTUBE and not s3_key:
        return None
    return ManifestVideo(
        video_id=str(v.get("videoId")),
        s3_key=s3_key,
        source=source,
        youtube_url=youtube_url,
        duration_seconds=v.get("durationSeconds"),
        resolution=v.get("resolution"),
    )


def parse_manifest(data: dict[str, Any]) -> Manifest:
    team = data.get("team") or {}
    videos = [
        parsed for parsed in
        (_parse_video(v) for v in (data.get("videos") or []) if isinstance(v, dict))
        if parsed is not None
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
