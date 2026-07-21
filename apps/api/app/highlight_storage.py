"""하이라이트 원본/결과물용 S3 스토리지 래퍼 (Phase 0 스캐폴딩).

env 로 버킷·리전만 넣으면 동작한다. boto3 는 실제로 쓸 때만 import 하므로,
설정이 안 됐거나 boto3 가 없어도 모듈 import 는 실패하지 않는다(실호출 시점에만 검증).

env:
  HIGHLIGHT_S3_BUCKET         (필수) 원본/결과물 버킷
  HIGHLIGHT_S3_REGION         (선택) 예: ap-northeast-2
  HIGHLIGHT_S3_ENDPOINT_URL   (선택) minio 등 로컬 테스트용
  HIGHLIGHT_S3_OUTPUT_PREFIX  (선택) 결과물 key 접두사, 기본 "highlights/output/"
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    """produce 잡이 의존하는 최소 인터페이스. 테스트는 로컬 구현을 주입한다."""

    def download(self, key: str, dest: Path) -> Path: ...
    def upload(self, path: Path, key: str, content_type: str = "video/mp4") -> str: ...


def output_prefix() -> str:
    return os.getenv("HIGHLIGHT_S3_OUTPUT_PREFIX", "highlights/output/")


class S3Storage:
    """boto3 기반 S3 구현. 클라이언트는 최초 사용 시 lazy 생성한다."""

    def __init__(
        self,
        bucket: str | None = None,
        region: str | None = None,
        endpoint_url: str | None = None,
    ) -> None:
        self.bucket = bucket or os.getenv("HIGHLIGHT_S3_BUCKET", "").strip()
        self.region = region or os.getenv("HIGHLIGHT_S3_REGION", "").strip() or None
        self.endpoint_url = (
            endpoint_url or os.getenv("HIGHLIGHT_S3_ENDPOINT_URL", "").strip() or None
        )
        self._client_obj = None

    @property
    def configured(self) -> bool:
        return bool(self.bucket)

    def _client(self):
        if self._client_obj is None:
            if not self.configured:
                raise RuntimeError(
                    "HIGHLIGHT_S3_BUCKET 이 설정되지 않았습니다. S3 스토리지를 쓰려면 env 를 채우세요."
                )
            try:
                import boto3  # 실제 사용 시점에만 import
            except ImportError as ex:  # pragma: no cover
                raise RuntimeError("boto3 가 설치되어 있지 않습니다 (requirements.txt 확인).") from ex
            kwargs: dict[str, object] = {}
            if self.region:
                kwargs["region_name"] = self.region
            if self.endpoint_url:
                kwargs["endpoint_url"] = self.endpoint_url
            self._client_obj = boto3.client("s3", **kwargs)
        return self._client_obj

    def download(self, key: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        self._client().download_file(self.bucket, key, str(dest))
        return dest

    def upload(self, path: Path, key: str, content_type: str = "video/mp4") -> str:
        self._client().upload_file(
            str(path), self.bucket, key, ExtraArgs={"ContentType": content_type}
        )
        return key

    def presigned_get(self, key: str, expires: int = 3600) -> str:
        """관리자 태깅용 원본 스트리밍 URL 등. 결과물 공유에도 쓸 수 있다."""
        return self._client().generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires,
        )


def default_storage() -> S3Storage:
    """env 기반 기본 S3 스토리지."""
    return S3Storage()
