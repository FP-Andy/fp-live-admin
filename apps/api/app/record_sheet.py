"""SUFA 경기기록지(xlsx)에서 라인업을 뽑아낸다.

시트 한 장이 한 경기이고, 좌우로 홈/어웨이가 나뉜 고정 서식이다.
    홈    A=배번/위치  B=이름  C=교체(시간/이름)
    어웨이 K=배번/위치  L=이름  M=교체(시간/이름)
    팀명은 10행, 헤더는 13행, 선수는 14행부터 빈 줄까지.

실제 기록지에서 마주친 표기들을 그대로 처리한다.
    "45/GK"             배번/포지션
    "허재원 ©", "장윤서c"  주장 표기 — 이름에서 떼어낸다
    "17'(66김시우)"       교체 (분, 들어온 선수 배번+이름)
    "50' (14김시원)"      괄호 앞 공백
    "50+3'(...)"         추가시간
    한 셀에 줄바꿈으로 교체 2건
"""
from __future__ import annotations

import io
import re
import unicodedata
from typing import Any

import openpyxl

TEAM_ROW = 10
FIRST_PLAYER_ROW = 14
# 배번열, 이름열, 교체열, 팀명열
SIDES: dict[str, tuple[int, int, int, int]] = {
    "home": (1, 2, 3, 1),
    "away": (11, 12, 13, 11),
}
SUB_RE = re.compile(r"(\d+(?:\+\d+)?)\s*'\s*\(\s*(\d+)\s*([^)]*?)\s*\)")


def _nfc(value: Any) -> str:
    """macOS·엑셀을 오가며 자모 분해(NFD)된 한글이 섞여 들어온다. 비교 전에 합친다."""
    return unicodedata.normalize("NFC", str(value or "")).strip()


def _clean_name(raw: Any) -> tuple[str, bool]:
    """이름에서 주장 표기를 떼고 (이름, 주장여부)."""
    s = _nfc(raw)
    captain = bool(re.search(r"[©ⓒ]|(?<=[가-힣])c$|\(C\)$", s, re.I))
    s = re.sub(r"\s*[©ⓒ]\s*$", "", s)
    s = re.sub(r"(?<=[가-힣])c$", "", s)
    s = re.sub(r"\s*\(C\)\s*$", "", s, flags=re.I)
    return s.strip(), captain


def _parse_subs(raw: Any) -> list[dict]:
    out = []
    for m in SUB_RE.finditer(_nfc(raw)):
        minute, _, added = m.group(1).partition("+")
        out.append({
            "minute": int(minute),
            "added": int(added) if added else 0,
            "inNumber": m.group(2),
            "inName": _nfc(m.group(3)),
        })
    return out


def _parse_side(ws, side: str) -> dict:
    col_no, col_name, col_sub, col_team = SIDES[side]
    team = _nfc(ws.cell(TEAM_ROW, col_team).value)
    formation = ""
    fm = re.search(r"\(([^)]*\d[^)]*)\)\s*$", team)
    if fm:
        formation = fm.group(1)
        team = team[: fm.start()].strip()

    players: list[dict] = []
    for r in range(FIRST_PLAYER_ROW, ws.max_row + 1):
        cell_no = ws.cell(r, col_no).value
        cell_nm = ws.cell(r, col_name).value
        if not cell_no and not cell_nm:
            if players:
                break                      # 명단 끝
            continue
        raw_no = _nfc(cell_no)
        m = re.match(r"^\s*(\d+)\s*/\s*(.+?)\s*$", raw_no)
        number, position = (m.group(1), _nfc(m.group(2))) if m else (raw_no, "")
        name, captain = _clean_name(cell_nm)
        if not name or not number:
            continue
        players.append({
            "jerseyNumber": number,
            "name": name,
            "position": position,
            "captain": captain,
            "subs": _parse_subs(ws.cell(r, col_sub).value),
        })
    return {"team": team, "formation": formation, "players": players}


def parse_sheet(ws) -> dict:
    return {
        "matchNo": _nfc(ws.cell(7, 2).value),
        "date": _nfc(ws.cell(7, 5).value),
        "venue": _nfc(ws.cell(8, 5).value),
        "home": _parse_side(ws, "home"),
        "away": _parse_side(ws, "away"),
    }


def parse_workbook(file_bytes: bytes) -> list[dict]:
    """기록지 전체를 시트 목록으로 돌려준다. 서식이 다른 시트는 건너뛰지 않고 표시한다."""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=False)
    except Exception as exc:  # noqa: BLE001 - 업로드 파일이라 원인이 다양하다
        raise ValueError(f"엑셀 파일을 열 수 없습니다: {exc}") from exc

    out: list[dict] = []
    for name in wb.sheetnames:
        try:
            parsed = parse_sheet(wb[name])
        except Exception as exc:  # noqa: BLE001
            out.append({"sheet": name, "error": str(exc)[:200]})
            continue
        parsed["sheet"] = name
        parsed["usable"] = bool(
            parsed["home"]["players"] and parsed["away"]["players"]
        )
        out.append(parsed)
    return out
