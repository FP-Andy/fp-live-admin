"""운영자가 만든 카드 템플릿을 내장 템플릿과 같은 모양으로 되살린다.

내장 템플릿(highlight_card_templates.py)은 코드에 박혀 있어 디자인이 새로 생기면 배포가
필요하다. 여기서는 그걸 배포 없이 늘린다 — 배경 그림을 올리고 기존 템플릿의 자리·크기·색을
손본 결과를 이름 붙여 저장하면 드롭다운에 바로 뜬다.

핵심은 **렌더러를 건드리지 않는 것**이다. DB 행을 읽어 내장과 똑같은 CardTemplate 을
만들어 돌려주므로, 그리는 쪽도 설정 화면도 내장인지 사용자 것인지 구별하지 않는다.
"""

from __future__ import annotations

import os
from pathlib import Path

from .highlight_card_templates import (
    DEFAULT_TEMPLATE_ID,
    TEMPLATES,
    CardTemplate,
    get_template,
)
from .models import HighlightCardTemplate

#: 올린 배경 그림을 두는 자리.
CARD_TEMPLATE_DIR = Path(
    os.getenv("HIGHLIGHT_CARD_TEMPLATE_DIR", "/app/runtime/highlight_card_templates")
).resolve()

#: 사용자 템플릿 id 앞에 붙는 말. 내장 id 와 절대 겹치지 않게 한다.
USER_PREFIX = "user:"

BUILTIN_IDS = {t.id for t in TEMPLATES}


def template_dir() -> Path:
    CARD_TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    return CARD_TEMPLATE_DIR


def to_template(row: HighlightCardTemplate) -> CardTemplate:
    """DB 행 → CardTemplate.

    배경은 절대 경로로 넣는다. 렌더러가 `assets/brand / 이름` 으로 합치는데,
    pathlib 은 오른쪽이 절대 경로면 그것을 쓰므로 그대로 동작한다.
    """
    base = get_template(row.base_id)
    boxes = row.boxes if isinstance(row.boxes, dict) else {}
    start_bg = (str(template_dir() / row.start_bg) if row.start_bg else base.start_bg)
    section_bg = (str(template_dir() / row.section_bg) if row.section_bg
                  else base.section_bg)
    return CardTemplate(
        id=f"{USER_PREFIX}{row.id}",
        name=row.name,
        design=base.design,
        start_bg=start_bg,
        section_bg=section_bg,
        start_fields=base.start_fields,
        section_fields=base.section_fields,
        gradient=base.gradient,
        note=row.note or base.note,
        base_color=row.base_color or base.base_color,
        # 배치는 **굽지 않고** 실어 보낸다. 로고 배율은 상자를 키워 흉내낼 수 없다 —
        # 맞춤 단계가 원본보다 키우지 않아서 작은 로고는 꿈쩍하지 않는다.
        boxes={"start": boxes.get("start") or {}, "section": boxes.get("section") or {}},
    )


def user_templates(db) -> list[CardTemplate]:
    """저장된 사용자 템플릿 전부. 만든 순서대로."""
    rows = (
        db.query(HighlightCardTemplate)
        .filter(HighlightCardTemplate.active.is_(True))
        .order_by(HighlightCardTemplate.created_at.asc())
        .all()
    )
    out = []
    for row in rows:
        try:
            out.append(to_template(row))
        except Exception:  # noqa: BLE001 - 한 줄이 깨져도 나머지는 쓸 수 있어야 한다
            continue
    return out


def all_templates(db) -> list[CardTemplate]:
    """드롭다운에 뜰 전부 — 내장 먼저, 그다음 사용자 것."""
    return [*TEMPLATES, *user_templates(db)]


def resolve(db, template_id: str | None) -> CardTemplate:
    """id 로 템플릿을 찾는다. 못 찾으면 내장 기본으로 떨어진다.

    렌더 중에 템플릿이 지워질 수 있다 — 그때도 결과물은 나와야 하므로 예외를 던지지
    않는다. 내장 id 는 DB 를 보지 않고 바로 답한다(렌더가 한 클립마다 부른다).
    """
    key = str(template_id or "").strip()
    if not key or key in BUILTIN_IDS:
        return get_template(key or DEFAULT_TEMPLATE_ID)
    if not key.startswith(USER_PREFIX):
        return get_template(key)
    raw = key[len(USER_PREFIX):]
    try:
        import uuid as _uuid

        row = db.get(HighlightCardTemplate, _uuid.UUID(raw))
    except Exception:  # noqa: BLE001 - id 가 깨졌으면 기본으로
        return get_template(DEFAULT_TEMPLATE_ID)
    if row is None or not row.active:
        return get_template(DEFAULT_TEMPLATE_ID)
    return to_template(row)
