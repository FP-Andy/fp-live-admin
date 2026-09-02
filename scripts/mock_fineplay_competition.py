"""대회 인입(competition-results) 목 수신부 — 콘솔 송신부를 혼자 테스트하기 위한 개발용 서버.

FinePlay 백엔드(Java)를 띄우지 않고도 콘솔의 "🏆 대회 인입 전송" 버튼을 끝까지 눌러볼 수
있게, 실제 수신부(FpcCompetitionResultController + CompetitionPayloadValidator)와 같은
판정을 파이썬으로 재현한다:

  - Authorization: Bearer <FPC_SERVICE_TOKEN> 불일치 → 401
  - 참조 무결성 위반 → 400 {"errors": [...]}
  - status == "FAILED"  → 200 {"accepted": true}
  - 그 외              → 501 (계약 통과·저장 준비 중)  ← 실제 수신부의 현재 상태

받은 payload 는 --dump 디렉터리에 fpcMatchId 별로 저장해 눈으로 확인할 수 있다.

    python3 scripts/mock_fineplay_competition.py            # 0.0.0.0:8099
    python3 scripts/mock_fineplay_competition.py --port 9000 --token my-token

콘솔 쪽에서는 infra/app/.env 에 아래 2줄을 넣고 `docker compose up -d --force-recreate api`:
    FINEPLAY_API_BASE=http://host.docker.internal:8099
    FINEPLAY_API_TOKEN=local-fpc-dev-token
"""

from __future__ import annotations

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PATH = "/api/internal/xfp/competition-results"


def validate(payload: dict) -> list[str]:
    """CompetitionPayloadValidator 와 같은 규칙 — 선언되지 않은 ID 를 가리키는 참조를 막는다."""
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["본문이 비어 있습니다."]
    if not str((payload.get("match") or {}).get("fpcMatchId") or "").strip():
        errors.append("match.fpcMatchId 는 필수입니다(멱등키).")
    if not str((payload.get("competition") or {}).get("fpcCompetitionId") or "").strip():
        errors.append("competition.fpcCompetitionId 는 필수입니다.")

    team_ids: set[str] = set()
    player_ids: set[str] = set()
    teams = payload.get("teams") or []
    if not teams:
        errors.append("teams 는 비어 있을 수 없습니다.")
    for i, t in enumerate(teams):
        tid = str(t.get("fpcTeamId") or "").strip()
        if not tid:
            errors.append(f"teams[{i}].fpcTeamId 는 필수입니다.")
        elif tid in team_ids:
            errors.append(f"teams[{i}].fpcTeamId 가 중복입니다: {tid}")
        else:
            team_ids.add(tid)
        if not str(t.get("name") or "").strip():
            errors.append(f"teams[{i}].name 은 필수입니다.")
        for j, p in enumerate(t.get("players") or []):
            pid = str(p.get("fpcPlayerId") or "").strip()
            if not pid:
                errors.append(f"teams[{i}].players[{j}].fpcPlayerId 는 필수입니다.")
            elif pid in player_ids:
                errors.append(f"teams[{i}].players[{j}].fpcPlayerId 가 중복입니다: {pid}")
            else:
                player_ids.add(pid)

    clip_keys: set[str] = set()
    for i, c in enumerate(payload.get("clips") or []):
        key = str(c.get("clipKey") or "").strip()
        if not key:
            errors.append(f"clips[{i}].clipKey 는 필수입니다.")
        elif key in clip_keys:
            errors.append(f"clips[{i}].clipKey 가 중복입니다: {key}")
        else:
            clip_keys.add(key)
        ctid = str(c.get("fpcTeamId") or "").strip()
        if not ctid:
            errors.append(f"clips[{i}].fpcTeamId 는 필수입니다.")
        elif ctid not in team_ids:
            errors.append(f"clips[{i}].fpcTeamId 가 teams 에 없습니다: {ctid}")
        for j, ip in enumerate(c.get("involvedPlayers") or []):
            ipid = str(ip.get("fpcPlayerId") or "").strip()
            if not ipid:
                errors.append(f"clips[{i}].involvedPlayers[{j}].fpcPlayerId 는 필수입니다.")
            elif ipid not in player_ids:
                errors.append(
                    f"clips[{i}].involvedPlayers[{j}].fpcPlayerId 가 teams.players 에 없습니다: {ipid}"
                )
    for i, pr in enumerate(payload.get("playerProfiles") or []):
        prid = str(pr.get("fpcPlayerId") or "").strip()
        if not prid:
            errors.append(f"playerProfiles[{i}].fpcPlayerId 는 필수입니다.")
        elif prid not in player_ids:
            errors.append(f"playerProfiles[{i}].fpcPlayerId 가 teams.players 에 없습니다: {prid}")
    return errors


def summarize(payload: dict) -> str:
    teams = payload.get("teams") or []
    players = sum(len(t.get("players") or []) for t in teams)
    clips = payload.get("clips") or []
    involved = sum(len(c.get("involvedPlayers") or []) for c in clips)
    return (
        f"팀 {len(teams)} · 선수 {players} · 클립 {len(clips)} "
        f"· 클립출연 {involved} · 프로필 {len(payload.get('playerProfiles') or [])}"
    )


def make_handler(token: str, dump_dir: Path | None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt, *args):  # 기본 접근로그는 죽이고 우리 로그만 남긴다
            pass

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != PATH:
                self._send(404, {"message": f"unknown path {self.path}"})
                return
            auth = self.headers.get("Authorization") or ""
            if auth != f"Bearer {token}":
                print(f"  401 토큰 불일치: {auth[:24]!r}")
                self._send(401, {"message": "invalid service token"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError as exc:
                self._send(400, {"errors": [f"JSON 파싱 실패: {exc}"]})
                return

            mid = str((payload.get("match") or {}).get("fpcMatchId") or "unknown")
            print(f"\n[POST] fpcMatchId={mid}  {summarize(payload)}")
            if dump_dir:
                dump_dir.mkdir(parents=True, exist_ok=True)
                out = dump_dir / f"{mid.replace('/', '_').replace(':', '_')}.json"
                out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"  저장: {out}")

            errors = validate(payload)
            if errors:
                for e in errors:
                    print(f"  ✗ {e}")
                self._send(400, {"accepted": False, "errors": errors})
                return
            if str(payload.get("status") or "").upper() == "FAILED":
                print("  → 200 accepted(FAILED)")
                self._send(200, {"accepted": True, "fpcMatchId": mid})
                return
            print("  → 501 계약 통과 · 저장 준비 중(실제 수신부와 동일)")
            self._send(
                501,
                {
                    "accepted": False,
                    "message": "계약 검증은 통과했습니다. 인입 저장은 준비 중입니다(스키마 확정 대기).",
                    "fpcMatchId": mid,
                },
            )

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--token", default=os.getenv("FPC_SERVICE_TOKEN", "local-fpc-dev-token"))
    ap.add_argument("--dump", default="", help="받은 payload 를 저장할 디렉터리(기본: 저장 안 함)")
    args = ap.parse_args()

    handler = make_handler(args.token, Path(args.dump) if args.dump else None)
    server = HTTPServer((args.host, args.port), handler)
    print(f"목 수신부 대기 중 — http://{args.host}:{args.port}{PATH}")
    print(f"토큰: {args.token}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료")


if __name__ == "__main__":
    main()
