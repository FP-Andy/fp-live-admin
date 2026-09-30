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

from dataclasses import dataclass, field, replace

# 글꼴 파일 — assets/fonts 안의 이름.
GIANTS = "Giants-Bold.ttf"
WANTED = "WantedSans-ExtraBold.otf"
# SUFA 시안의 실제 글꼴 — PSD 글자 레이어에서 읽었다(전부 Pretendard-Bold).
# 무료(OFL) 배포본이라 그대로 넣었다. WantedSans 로 흉내내면 굵기가 더 나간다.
PRETENDARD = "Pretendard-Bold.otf"


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

    tracking: int = 0
    """자간 — 포토샵 Tracking 단위(1/1000 em). SUFA 점수판 제목이 200 이다.
    이걸 빼먹으면 같은 글꼴이라도 제목이 눈에 띄게 좁아 보인다."""

    placeholder: str = ""
    """설정 화면에 흐리게 보일 예시."""

    default: str = ""
    """칸이 **이 값으로 채워진 채** 시작한다(고칠 수 있다). 안내글(placeholder)은
    안 치면 빈칸으로 나가지만, 기본값은 안 쳐도 그대로 나간다 — 시안에 박혀 있던
    문구('2026 SUFA ADVANCED LEAGUE 4R')는 이쪽이 맞다. 지우면 지운 대로 나간다."""

    max_len: int = 40
    ui_width: int = 150
    """설정 화면에서 이 칸의 가로 폭(px)."""

    empty: str = ""
    """비었을 때 무엇으로 채우나 — '' 안 그림 / 'mark' 흰 파인플레이 마크 /
    'vs' 그 자리에 VS 글자."""

    empty_size: int = 0
    """empty='vs' 일 때 쓸 글자 크기."""

    color: str = "#FFFFFF"
    """글자 색. 우리 카드는 전부 흰 글자였지만 대회 시안은 그렇지 않다 — SUFA 점수판은
    제목과 팀명이 검정, 점수만 흰색이다."""


@dataclass(frozen=True)
class ColorZone:
    """배경 그림에 **구워져 있는 색**을 갈아끼울 자리.

    대회 점수판은 팀 색이 그림에 박혀 있다. 그렇다고 전체를 색상 회전시키면(카드 배경이
    쓰는 방법) 같은 색을 쓰는 다른 부분까지 같이 돈다 — 실제로 SUFA 점수판은 왼쪽 팀
    블록과 **가운데 점수판이 같은 파랑**이라 통째로 돌리면 점수판까지 팀 색이 된다.

    그래서 '이 상자 안에서, 이 색인 픽셀만' 갈아끼운다. 평평한 단색 도형이라 이 방법이
    정확하고, 상자 안에 있어도 색이 다른 것(로고·글자)은 건드리지 않는다.
    """

    id: str
    label: str
    box: tuple[float, float, float, float]
    """(left, top, width, height) — 그 템플릿의 시안 좌표."""

    source: str
    """배경에 구워져 있는 색(#RRGGBB)."""

    tolerance: int = 14
    """이 값만큼 어긋난 픽셀까지 같은 색으로 본다(가장자리 안티앨리어싱)."""


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

    boxes: dict = field(default_factory=dict)
    """이 템플릿이 기본으로 쓸 자리·배율 — {'start': {항목id: {x, y, scale}}, 'section': …}.

    운영자가 콘솔에서 만든 템플릿이 여기에 자기 배치를 담는다. **굽지 않고 넘기는**
    이유는 로고의 배율이다 — 상자를 키워 흉내내려 하면 맞춤 단계가 원본보다 키우지
    않아서 작은 로고는 꿈쩍하지 않는다. 그리는 쪽의 규칙(_moved)을 그대로 쓰는 게
    유일하게 어긋나지 않는 길이다.

    잡에 저장된 자리값이 있으면 **그쪽이 이긴다**(같은 항목 기준). 운영자가 템플릿을
    고른 뒤 그 판에서 다시 옮긴 것이니 당연히 나중 것이 우선이다.
    """

    def boxes_for(self, kind: str) -> dict:
        got = self.boxes.get("section" if kind == "section" else "start")
        return got if isinstance(got, dict) else {}

    base_color: str = "#FF7400"
    """배경 그림의 바탕색. **색만 바꾸기**의 기준점이다.

    배경은 한 가지 색의 그라데이션이라(실측: 색상 27~39도, 무채색 0%) 색상만 돌리면
    그라데이션·도형·명암이 전부 그대로 남는다. 이 값이 '지금 색' 이고, 사용자가 고른
    색과의 **차이만큼** 돌린다.
    """

    backdrop: str = ""
    """카드 뒤에 깔 사진(assets/brand 안의 이름). 시안의 **투명 여백**으로 이 사진이
    비친다. 비어 있으면 시안 여백의 저장색(보통 흰색)이 그대로 화면이 된다 —
    파인플레이 기본이 그렇고, 그쪽은 시안이 화면을 꽉 채우므로 애초에 여백이 없다."""

    board_bg: str = ""
    """점수판 배경 PNG. 비어 있으면 이 템플릿엔 점수판 면이 없다(코드로 그리는 기본 점수판을 쓴다)."""

    board_design: tuple[int, int] | None = None
    """점수판 시안 규격. 카드와 다를 수 있다(SUFA 는 1215x605)."""

    board_defaults: dict = field(default_factory=dict)
    """점수판의 기본 크기·자리 — {'size_pct', 'pos_x', 'pos_y'}(화면 비율 좌표).
    세트를 고르는 순간 이 값으로 잡히고, 그 뒤에는 자유롭게 옮길 수 있다."""

    board_fields: tuple[CardField, ...] = ()
    board_zones: tuple[ColorZone, ...] = ()
    """점수판에서 색을 갈아끼울 자리 — 보통 홈·어웨이 팀 색."""

    first_half_video: str = ""
    second_half_video: str = ""
    """전반·후반 효과 영상. 글자를 얹지 않고 그대로 끼워 넣는다."""

    def fields(self, kind: str) -> tuple[CardField, ...]:
        if kind == "board":
            return self.board_fields
        return self.section_fields if kind == "section" else self.start_fields

    def background(self, kind: str) -> str:
        if kind == "board":
            return self.board_bg
        return self.section_bg if kind == "section" else self.start_bg

    def design_for(self, kind: str) -> tuple[int, int]:
        if kind == "board" and self.board_design:
            return self.board_design
        return self.design

    @property
    def has_board(self) -> bool:
        """이 템플릿이 자기 점수판 그림을 들고 있나."""
        return bool(self.board_bg)


# ── 내장 템플릿 — 우리가 만든 것 ────────────────────────────────────────
# 좌표는 시안(Figma 1920x1080) CSS 의 calc() 를 풀어 둔 값이다.
FINEPLAY = CardTemplate(
    id="fineplay",
    name="파인플레이 기본",
    design=(1920, 1080),
    base_color="#FF7400",
    start_bg="card-bg-start.png",
    section_bg="card-bg-section.png",
    note="대회 로고를 안 넣으면 그 자리에 VS 가, 팀 로고를 안 넣으면 흰 파인플레이 마크가,"
         " 협력사 로고를 안 넣으면 파인플레이 로고가 들어갑니다.",
    # 자리·크기는 전부 **시안(시작.png)에서 직접 잰 값**이다. 글자는 같은 글을 우리
    # 글꼴로 그려 보며 높이가 맞는 크기를 찾았다 — 상자만 맞추면 글자 크기가 안 맞는다.
    start_fields=(
        CardField(
            id="round_label", label="라운드", kind="text",
            box=(847.0, 123.0, 228.0, 33.0),
            font=GIANTS, size=40, max_width=420.0, shadow=5.4,
            placeholder="1 ROUND", max_len=20, ui_width=120,
        ),
        CardField(
            id="competition", label="대회 이름", kind="text",
            box=(290.0, 219.0, 1339.0, 77.0),
            font=GIANTS, size=93, max_width=1440.0, shadow=3.9,
            placeholder="2026 HYU-LEAGUE AUTUMN", max_len=40, ui_width=190,
        ),
        CardField(
            id="home_logo", label="홈 로고", kind="logo",
            box=(286.0, 375.0, 354.0, 354.0), empty="mark",
        ),
        CardField(
            id="away_logo", label="원정 로고", kind="logo",
            box=(1276.0, 373.0, 358.0, 358.0), empty="mark",
        ),
        CardField(
            id="center_logo", label="대회 로고", kind="logo",
            # 로고를 안 넣으면 이 자리에 VS 가 들어간다. 그래서 상자 가운데를
            # 시안의 VS 글자 가운데에 맞춰 뒀다 — 둘이 같은 자리에 와야 한다.
            box=(834.0, 486.0, 249.0, 249.0),
            font=GIANTS, empty="vs", empty_size=179,
        ),
        CardField(
            id="home_name", label="홈 팀", kind="text",
            box=(345.0, 759.0, 240.0, 79.0),
            font=WANTED, size=86, max_width=600.0,
            placeholder="홈팀 이름", max_len=20, ui_width=150,
        ),
        CardField(
            id="away_name", label="원정 팀", kind="text",
            box=(1337.0, 761.0, 241.0, 79.0),
            font=WANTED, size=86, max_width=600.0,
            placeholder="원정팀 이름", max_len=20, ui_width=150,
        ),
        CardField(
            id="partner_logo", label="협력사 로고", kind="logo",
            # 시안에서 [대회 로고] × [Fine Play] 가 앉는 자리. 아무것도 안 넣으면
            # 파인플레이 로고가 들어간다 — 배경에 박혀 있던 그 글자를 오려내 쓴다.
            box=(688.0, 913.0, 548.0, 63.0), empty="wordmark",
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

# ── SUFA 대학축구연맹 — 리그 4종 ──────────────────────────────────────────
#
# 자리·색은 **PSD 레이어에서 직접 읽은 값**이다(psd-tools). 글자 레이어의 경계가 곧
# 그 항목의 자리이고, '왼쪽팀 컬러'·'오른쪽팀 컬러' 도형의 경계가 곧 팀 색 자리다.
# 픽셀을 눈대중으로 재다가 한 번 틀렸다 — 큰 파란 블록을 팀 색으로 봤는데, 실제로는
# 그 옆의 **얇은 세로 바**가 팀 색이었다. 레이어 이름이 그걸 바로잡아 줬다.
#
# 배경 PNG 는 **글자와 팀 로고(누끼)를 숨기고** 합성한 것이다 — 그 자리는 우리가 채운다.
# 네 리그는 판이 완전히 같고 그림·색만 다르다(점수판 1215x605, 팀 소개 1510x1080).

#: 점수판 — 제목·팀명은 검정, 점수는 흰색. 상자는 원래 글자의 한가운데에 맞췄다.
_SUFA_BOARD_FIELDS: tuple[CardField, ...] = (
    # 크기·자간은 PSD 글자 스타일에서 그대로 — 제목 60pt x 배율 0.465 = 28pt · 자간 200,
    # 팀명 35pt · 점수 60pt · 자간 25. 눈대중으로 맞춘 값(26/32/48)은 전부 작았다.
    CardField(
        id="round_label", label="대회·라운드", kind="text",
        box=(167.0, 139.0, 611.0, 41.0), font=PRETENDARD, size=28, tracking=200,
        color="#101115",
        placeholder="2026 SUFA ADVANCED LEAGUE 4R", max_len=48, ui_width=260,
    ),
    CardField(
        id="home_name", label="홈 팀명", kind="text",
        box=(222.0, 200.0, 211.0, 55.0), font=PRETENDARD, size=35, tracking=25,
        color="#101115",
        placeholder="KWPE", max_len=20, ui_width=150,
    ),
    CardField(
        id="away_name", label="어웨이 팀명", kind="text",
        box=(648.0, 200.0, 215.0, 58.0), font=PRETENDARD, size=35, tracking=25,
        color="#101115",
        placeholder="아마추어축구부", max_len=20, ui_width=150,
    ),
    CardField(
        id="home_score", label="홈 점수", kind="text",
        box=(465.0, 200.0, 61.0, 56.0), font=PRETENDARD, size=60, tracking=25,
        color="#FFFFFF",
        placeholder="0", max_len=3, ui_width=70,
    ),
    CardField(
        id="away_score", label="어웨이 점수", kind="text",
        box=(559.0, 200.0, 61.0, 56.0), font=PRETENDARD, size=60, tracking=25,
        color="#FFFFFF",
        placeholder="0", max_len=3, ui_width=70,
    ),
)

#: 시작 전 팀 소개 — 라운드 한 줄, 팀 로고 둘, 팀명 둘.
_SUFA_START_FIELDS: tuple[CardField, ...] = (
    CardField(
        id="round_label", label="대회·라운드", kind="text",
        box=(289.0, 210.0, 1002.0, 54.0), font=PRETENDARD, size=60, color="#101115",
        placeholder="2026 SUFA ADVANCED LEAGUE 5R", max_len=48, ui_width=260,
    ),
    # 로고 기본 자리는 운영에서 눈으로 맞춘 값이다(2026-09-30 지정: 220·1030, y 400).
    # 판 중심 실측(408.7·1115.7)으로 잡았던 것을 화면에서 보며 다시 고른 값이라
    # 이쪽이 정본이다.
    CardField(
        id="home_logo", label="홈 로고", kind="logo",
        box=(220.0, 400.0, 300.0, 285.0), empty="mark", ui_width=120,
    ),
    CardField(
        id="away_logo", label="어웨이 로고", kind="logo",
        box=(1030.0, 400.0, 300.0, 285.0), empty="mark", ui_width=120,
    ),
    CardField(
        id="home_name", label="홈 팀명", kind="text",
        box=(207.0, 730.0, 361.0, 58.0), font=PRETENDARD, size=45, color="#FFFFFF",
        placeholder="서울대 SNUWFC", max_len=24, ui_width=170,
    ),
    CardField(
        id="away_name", label="어웨이 팀명", kind="text",
        box=(890.0, 730.0, 408.0, 58.0), font=PRETENDARD, size=45, color="#FFFFFF",
        placeholder="국민대 한마음 레이디스", max_len=24, ui_width=170,
    ),
)

#: 팀 색 자리 — 레이어 '왼쪽팀 컬러'(194,191,18,75)·'오른쪽팀 컬러'(866,191,20,75).
#: 한 칸씩 넉넉히 잡아 가장자리 안티앨리어싱까지 함께 갈린다.
_SUFA_HOME_BOX = (192.0, 189.0, 22.0, 79.0)
_SUFA_AWAY_BOX = (864.0, 189.0, 24.0, 79.0)


#: 리그별 대회명 — 시안에 박혀 있던 문구다. 라운드 숫자만 갈아 쓰면 된다.
_SUFA_LEAGUE_WORD = {"A": "ADVANCED", "B": "BASIC", "L": "LADIES", "S": "SUPREME"}


def _with_round_default(fields: tuple[CardField, ...], text: str) -> tuple[CardField, ...]:
    """라운드 항목에만 리그별 기본 문구를 박는다. 나머지는 경기마다 다르니 비워 둔다."""
    return tuple(
        replace(f, default=text, placeholder=text) if f.id == "round_label" else f
        for f in fields
    )


def _sufa(key: str, name: str, home_src: str, away_src: str,
          base_color: str) -> CardTemplate:
    """리그 하나. 판은 같고 그림·색만 다르다."""
    low = key.lower()
    round_text = f"2026 SUFA {_SUFA_LEAGUE_WORD[key]} LEAGUE 1R"
    return CardTemplate(
        id=f"sufa-{low}",
        name=name,
        design=(1510, 1080),
        base_color=base_color,
        start_bg=f"sufa-{low}-intro.png",
        # 구간 카드 시안은 따로 없다 — 시작 카드와 같은 판을 쓴다.
        section_bg=f"sufa-{low}-intro.png",
        start_fields=_with_round_default(_SUFA_START_FIELDS, round_text),
        section_fields=_with_round_default(_SUFA_START_FIELDS, round_text),
        board_bg=f"sufa-{low}-board.png",
        board_design=(1215, 605),
        board_fields=_with_round_default(_SUFA_BOARD_FIELDS, round_text),
        # 운영에서 맞춰 본 자리 — 크기 27%, 영상 픽셀 (74, 80). 비율(%)이 아니라
        # **픽셀**이다 — 화면의 위치 숫자 칸이 픽셀이라 그 값이 그대로 보여야 한다.
        board_defaults={"size_pct": 27, "pos_px_x": 74, "pos_px_y": 80},
        board_zones=(
            ColorZone(id="home_color", label="홈 팀 색",
                      box=_SUFA_HOME_BOX, source=home_src),
            ColorZone(id="away_color", label="어웨이 팀 색",
                      box=_SUFA_AWAY_BOX, source=away_src),
        ),
        # 시안(1510x1080)이 16:9 화면보다 좁고 여백이 투명이라, 뒤에 깔 사진이 필요하다.
        backdrop="sufa-backdrop.jpg",
        first_half_video=f"sufa-{low}-first.mp4",
        second_half_video=f"sufa-{low}-second.mp4",
        note="점수판·시작 카드·전후반 효과 영상이 한 세트입니다."
             " 효과 영상은 글자를 얹지 않고 그대로 들어갑니다.",
    )


# 팀 색의 '바탕에 구워진 색' 은 리그마다 다르다(실측).
SUFA_A = _sufa("A", "SUFA A리그", "#000000", "#99001B", "#14038F")
SUFA_B = _sufa("B", "SUFA B리그", "#EBEBEB", "#000000", "#026840")
SUFA_L = _sufa("L", "SUFA L리그", "#FF8F00", "#173FE3", "#9F43E6")
SUFA_S = _sufa("S", "SUFA S리그", "#FFF000", "#173FE3", "#99001C")


TEMPLATES: tuple[CardTemplate, ...] = (FINEPLAY, SUFA_A, SUFA_B, SUFA_L, SUFA_S)
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

    def one(field_: CardField) -> dict:  # noqa: D401
        left, top, width, height = field_.box
        return {
            "id": field_.id,
            "label": field_.label,
            "kind": field_.kind,
            "placeholder": field_.placeholder,
            "default": field_.default,
            "max_len": field_.max_len,
            "ui_width": field_.ui_width,
            "empty": field_.empty,
            # 시안 좌표. 화면은 이걸 기본값으로 두고 자리를 고치게 한다.
            "box": [left, top, width, height],
            # 크기 조정은 로고·글자 모두 된다. 로고는 그린 크기에, 글자는 글꼴
            # 크기에 곱한다.
            "scalable": True,
        }

    return {
        "id": template.id,
        "name": template.name,
        "note": template.note,
        "design": list(template.design),
        # 배경 바탕색 — 설정 화면의 색 고르개가 이 값에서 시작한다.
        "base_color": template.base_color,
        "start_fields": [one(f) for f in template.start_fields],
        "section_fields": [one(f) for f in template.section_fields],
        # 이 템플릿이 기본으로 쓸 배치. 설정 화면은 여기서 시작해 더 옮길 수 있다.
        "boxes": {"start": template.boxes_for("start"),
                  "section": template.boxes_for("section")},
        # 이 세트가 자기 점수판·효과 영상을 들고 있나. 화면이 칸을 보일지 정한다.
        "has_board": template.has_board,
        "board_defaults": dict(template.board_defaults),
        "has_half_videos": bool(template.first_half_video or template.second_half_video),
        "board_fields": [one(f) for f in template.board_fields],
    }
