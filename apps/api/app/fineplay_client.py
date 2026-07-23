"""FinePlay 내부 연동 API 클라이언트 (§4) — poll / claim / results / heartbeat.

전송 계약만 구현. Base URL·토큰은 env. 엔드포인트 오픈 전이라 실호출은 나중 검증.

env:
  FINEPLAY_API_BASE   기본 https://api.fineplay.kr
  FINEPLAY_API_TOKEN  Bearer 서비스 토큰 (별도 안전 채널로 전달받음)
  FINEPLAY_WORKER_ID  claim 시 보고할 워커 식별자 (기본 fpc-worker-1)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

DEFAULT_BASE = "https://api.fineplay.kr"
_PREFIX = "/api/internal/xfp"


@dataclass
class ClaimResult:
    status_code: int
    manifest: dict[str, Any] | None  # 200 이면 확정 매니페스트, 아니면 None

    @property
    def granted(self) -> bool:
        return self.status_code == 200 and self.manifest is not None

    @property
    def taken(self) -> bool:
        """다른 워커가 이미 선점(409). Backend fix/rse-status-passthrough 배포 전제 —
        그 전 서버는 401(AF)로 둔갑시키므로 배포 전에 돌리면 선점을 인식 못 한다."""
        return self.status_code == 409


class FinePlayClient:
    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        worker_id: str | None = None,
        *,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (base_url or os.getenv("FINEPLAY_API_BASE", DEFAULT_BASE)).rstrip("/")
        self.token = token or os.getenv("FINEPLAY_API_TOKEN", "").strip()
        self.worker_id = worker_id or os.getenv("FINEPLAY_WORKER_ID", "fpc-worker-1").strip()
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _headers(self) -> dict[str, str]:
        if not self.token:
            raise RuntimeError("FINEPLAY_API_TOKEN 이 설정되지 않았습니다.")
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    def _url(self, path: str) -> str:
        return f"{self.base_url}{_PREFIX}{path}"

    def poll_jobs(self, limit: int | None = None, cursor: str | None = None) -> list[dict[str, Any]]:
        """§4-1 GET /jobs — 대기 작업 목록. 실서버는 매니페스트 배열을 그대로 반환(2026-07-23 실호출 확인)."""
        import httpx
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if cursor:
            params["cursor"] = cursor
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.get(self._url("/jobs"), headers=self._headers(), params=params)
            resp.raise_for_status()
            return resp.json()

    def claim(
        self,
        analysis_request_id: int | str,
        *,
        pipeline_version: str,
        lease_seconds: int = 86400,
    ) -> ClaimResult:
        """§4-2 POST /jobs/{id}/claim — 200(확정 매니페스트) / 409(선점됨) / 400·410."""
        import httpx
        body = {
            "fpcWorkerId": self.worker_id,
            "pipelineVersion": pipeline_version,
            "leaseSeconds": lease_seconds,
        }
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(
                self._url(f"/jobs/{analysis_request_id}/claim"),
                headers=self._headers(),
                json=body,
            )
            manifest = resp.json() if resp.status_code == 200 else None
            return ClaimResult(status_code=resp.status_code, manifest=manifest)

    def post_results(self, payload: dict[str, Any]) -> dict[str, Any]:
        """§4-3 POST /analysis-results — 결과 콜백(멱등). 영상은 이미 S3 업로드된 상태."""
        import httpx
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(
                self._url("/analysis-results"), headers=self._headers(), json=payload
            )
            resp.raise_for_status()
            return resp.json() if resp.content else {}

    def heartbeat(
        self, analysis_request_id: int | str, *, lease_seconds: int | None = None
    ) -> dict[str, Any]:
        """§4-4 POST /jobs/{id}/heartbeat — lease 연장 → {leaseExpiresAt}.

        body에 fpcWorkerId 필수(없으면 400 VF, 2026-07-23 확인). leaseSeconds 생략 시 기본 86400.
        """
        import httpx
        body: dict[str, Any] = {"fpcWorkerId": self.worker_id}
        if lease_seconds is not None:
            body["leaseSeconds"] = lease_seconds
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(
                self._url(f"/jobs/{analysis_request_id}/heartbeat"),
                headers=self._headers(),
                json=body,
            )
            resp.raise_for_status()
            return resp.json() if resp.content else {}


def default_client() -> FinePlayClient:
    return FinePlayClient()
