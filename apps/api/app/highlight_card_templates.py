"""하이라이트 카드 템플릿 명세.

카드는 대회마다 시안이 다르다. 스폰서로 들어가는 대회는 그쪽 템플릿을 써야 하고,
그 템플릿은 **고칠 수 있는 항목이 우리 것과 다르다** — 라운드가 없을 수도, 로고가
넷일 수도, 같은 팀명이라도 자리와 글꼴이 다르다.

그래서 카드를 '배경 그림 + 항목 명세' 한 덩어리로 둔다. 렌더러는 항목을 코드에 박지
않고 이 명세를 훑어 그리고, 설정 화면도 이 명세를 받아 칸을 만든다. 새 템플릿을
들일 때 하는 일은 **배경 PNG 두 장과 아래 CardTemplate 한 덩어리를 더하는 것**뿐이다
— 렌더러도 화면도 건드리지 않는다.

좌표·크기는 전부 그 템플릿의 시안 규격(design) 안에서의 절대값이다. 출력 크기가
달라도 다 그린 뒤 한 번에 맞추므로 시안과 어긋날 수 없다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 글꼴 파일 — assets/fonts 안의 이름.
GIANTS = "Giants-Bold.ttf"
WANTED = "WantedSans-ExtraBold.otf"


@dataclass(frozen=True)
class CardField:
    """카드에서 **고칠 수 있는** 항목 하나.

    여기 없는 것은 전부 고정이다 — 배경 그림에 이미 그려져 있고 아무도 못 바꾼다.
    """

    id: str
    """값을 담는 열쇠. 템플릿 안에서만 고유하면 된다."""

    label: str
    """설정 화면에 뜰 이름. '라운드', '대회 이름'."""

    kind: str
    """'text' 또는 'logo'."""

    box: tuple[float, float, float, float]
    """(left, top, width, height) — 시안 좌표."""

    font: str = GIANTS
    size: int = 40
    max_width: float | None = None
    """글자가 이 폭을 넘으면 크기를 줄인다. 없으면 상자 폭."""

    shadow: float = 0.0
    """시안의 text-shadow 번짐 반경. 0 이면 안 그린다."""

    placeholder: str = ""
    """설정 화면에 흐리게 보일 예시."""

    max_len: int = 40
    ui_width: int = 150
    """설정 화면에서 이 칸의 가로 폭(px)."""

    empty: str = ""
    """비었을 때 무엇으로 채우나 — '' 안 그림 / 'mark' 흰 파인플레이 마크 /
    'vs' 그 자리에 VS 글자."""

    empty_size: int = 0
    """empty='vs' 일 때 쓸 글자 크기."""


@dataclass(frozen=True)
class CardTemplate:
    id: str
    name: str
    design: tuple[int, int]
    start_bg: str
    """시작 카드 배경 PNG (assets/brand 안의 이름)."""

    section_bg: str
    """구간 카드 배경 PNG. 같은 배경을 써도 된다."""

    start_fields: tuple[CardField, ...]
    section_fields: tuple[CardField, ...]
    gradient: tuple[tuple[int, int, int], tuple[int, int, int]] = (
        (0xFF, 0x74, 0x00), (0xFF, 0xC5, 0x59),
    )
    """배경 PNG 를 못 읽거나 비율이 안 맞아 메워야 할 때 쓸 바탕색(왼쪽, 오른쪽)."""

    note: str = ""
    """설정 화면에 띄울 한 줄 안내."""

    def fields(self, kind: str) -> tuple[CardField, ...]:
        return self.section_fields if kind == "section" else self.start_fields

    def background(self, kind: str) -> str:
        return self.section_bg if kind == "section" else self.start_bg


# ── 내장 템플릿 — 우리가 만든 것 ────────────────────────────────────────
# 좌표는 시안(Figma 1920x1080) CSS 의 calc() 를 풀어 둔 값이다.
FINEPLAY = CardTemplate(
    id="fineplay",
    name="파인플레이 기본",
    design=(1920, 1080),
    start_bg="card-bg-start.png",
    section_bg="card-bg-section.png",
    note="대회 로고를 안 넣으면 그 자리에 VS 가, 팀 로고를 안 넣으면 흰 파인플레이 마크가 들어갑니다.",
    start_fields=(
        CardField(
            id="round_label", label="라운드", kind="text",
            box=(866.13, 111.47, 181.0, 56.0),
            font=GIANTS, size=40, max_width=289.6, shadow=5.4,
            placeholder="1 ROUND", max_len=20, ui_width=120,
        ),
        CardField(
            id="competition", label="대회 이름", kind="text",
            box=(716.63, 164.97, 505.0, 181.0),
            font=GIANTS, size=128, max_width=757.5, shadow=3.9,
            placeholder="8.15 컵", max_len=40, ui_width=190,
        ),
        CardField(
            id="home_logo", label="홈 로고", kind="logo",
            box=(284.25, 373.29, 357.41, 357.41), empty="mark",
        ),
        CardField(
            id="away_logo", label="원정 로고", kind="logo",
            box=(1274.28, 371.26, 361.48, 361.48), empty="mark",
        ),
        CardField(
            id="center_logo", label="대회 로고", kind="logo",
            box=(834.39, 509.01, 249.08, 249.08),
            font=GIANTS, empty="vs", empty_size=132,
        ),
        CardField(
            id="home_name", label="홈 팀", kind="text",
            box=(338.45, 745.71, 249.0, 105.0),
            font=WANTED, size=88, max_width=600.0,
            placeholder="홈팀 이름", max_len=20, ui_width=150,
        ),
        CardField(
            id="away_name", label="원정 팀", kind="text",
            box=(1330.52, 747.74, 249.0, 105.0),
            font=WANTED, size=88, max_width=600.0,
            placeholder="원정팀 이름", max_len=20, ui_width=150,
        ),
    ),
    section_fields=(
        CardField(
            id="label", label="구간 이름", kind="text",
            box=(554.0, 309.5, 811.0, 461.0),
            font=GIANTS, size=327, max_width=811.0, shadow=10.0,
            placeholder="1쿼터", max_len=20, ui_width=120,
        ),
    ),
)

TEMPLATES: tuple[CardTemplate, ...] = (FINEPLAY,)
DEFAULT_TEMPLATE_ID = FINEPLAY.id

_BY_ID = {template.id: template for template in TEMPLATES}


def get_template(template_id: str | None) -> CardTemplate:
    """모르는 id 는 내장으로 떨어진다 — 템플릿이 사라져도 결과물은 나와야 한다."""
    return _BY_ID.get(str(template_id or "").strip(), FINEPLAY)


def describe(template: CardTemplate) -> dict:
    """설정 화면이 칸을 만들 수 있을 만큼만 추린다.

    자리(box)까지 같이 보낸다 — 화면이 **지금 값을 기본값으로** 띄우고 거기서 옮기게
    하려는 것이다. 시안 좌표계(design) 안의 절대값이라 화면도 같은 기준으로 다룬다.
    """

    def one(field_: CardField) -> dict:
        left, top, width, height = field_.box
        return {
            "id": field_.id,
            "label": field_.label,
            "kind": field_.kind,
            "placeholder": field_.placeholder,
            "max_len": field_.max_len,
            "ui_width": field_.ui_width,
            "empty": field_.empty,
            # 시안 좌표. 화면은 이걸 기본값으로 두고 자리를 고치게 한다.
            "box": [left, top, width, height],
            # 크기까지 고칠 수 있는가 — 로고만이다(글자는 글꼴이 크기를 정한다).
            "scalable": field_.kind == "logo",
        }

    return {
        "id": template.id,
        "name": template.name,
        "note": template.note,
        "design": list(template.design),
        "start_fields": [one(f) for f in template.start_fields],
        "section_fields": [one(f) for f in template.section_fields],
    }
