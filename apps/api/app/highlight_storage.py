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

    def delete_object(self, key: str) -> None:
        """보관비 정리용 — 제작이 끝난 사전 작업 원본 등을 지운다."""
        self._client().delete_object(Bucket=self.bucket, Key=key)

    def presigned_put(self, key: str, expires: int = 3600, content_type: str = "video/mp4") -> str:
        """브라우저 직접 업로드용 — 사전 작업 풀영상처럼 큰 파일을 서버 경유 없이 올린다."""
        return self._client().generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=expires,
        )

    # --- 멀티파트 업로드 ---
    # 단일 PUT 은 연결 1개라 회선을 다른 트래픽과 나눠 쓰면 그대로 주저앉고, 5GB 한도도 있다.
    # 파트를 나눠 브라우저가 병렬로 올리고, 시작/완료/중단만 서버가 서명한다.

    def create_multipart(self, key: str, content_type: str = "video/mp4") -> str:
        res = self._client().create_multipart_upload(
            Bucket=self.bucket, Key=key, ContentType=content_type
        )
        return str(res["UploadId"])

    def presigned_upload_part(
        self, key: str, upload_id: str, part_number: int, expires: int = 21600
    ) -> str:
        return self._client().generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "UploadId": upload_id,
                "PartNumber": part_number,
            },
            ExpiresIn=expires,
        )

    def complete_multipart(self, key: str, upload_id: str, parts: list[dict]) -> str:
        """parts = [{"part_number": 1, "etag": "\"...\""}, ...] — 순서·ETag 가 맞아야 한다."""
        ordered = sorted(parts, key=lambda p: int(p["part_number"]))
        self._client().complete_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={
                "Parts": [
                    {"PartNumber": int(p["part_number"]), "ETag": str(p["etag"])} for p in ordered
                ]
            },
        )
        return key

    def abort_multipart(self, key: str, upload_id: str) -> None:
        """중단 — 안 지우면 올라간 파트가 계속 과금된다."""
        self._client().abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)


def default_storage() -> S3Storage:
    """env 기반 기본 S3 스토리지."""
    return S3Storage()
