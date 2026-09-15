"""KFA lineups in visual reading order, independent of PDF object order."""
import io
import re
import unicodedata
from pypdf import PdfReader

# KFA provides colour names, not calibrated RGB values. Preserve the original
# names and use representative colours that can be adjusted in Broadcast.
KIT_COLORS = {
    '초록': '#15803d', '녹색': '#15803d', '연두': '#84cc16', '연두색': '#84cc16',
    '하늘': '#87ceeb', '하늘색': '#87ceeb', '흰색': '#ffffff', '하양': '#ffffff', '백색': '#ffffff',
    '노랑': '#facc15', '노란색': '#facc15', '황색': '#facc15', '보라': '#9333ea', '보라색': '#9333ea',
    '빨강': '#dc2626', '빨간색': '#dc2626', '적색': '#dc2626', '밝은빨강': '#ff4d4d',
    '파랑': '#2158e8', '파란색': '#2158e8', '청색': '#2158e8', '남색': '#1e3a5f', '곤색': '#1e3a5f',
    '검정': '#171717', '검정색': '#171717', '검은색': '#171717', '흑색': '#171717',
    '주황': '#ff7400', '주황색': '#ff7400', '분홍': '#ec4899', '분홍색': '#ec4899',
    '회색': '#9ca3af', '은색': '#c0c0c0', '금색': '#d4af37', '갈색': '#92400e',
}


def team_key(value: str) -> str:
    value = unicodedata.normalize('NFKC', value).casefold()
    value = re.sub(r'[^\w가-힣]', '', value)
    return re.sub(r'fc$', '', value)


def player_from_line(line: str, starter: bool) -> dict | None:
    line = re.sub(r'\(\s*주장\s*\)', '', line)
    line = re.sub(r'\b([GDMF])\s+([KFW])\b', r'\1\2', line)
    match = re.match(r"^\s*(\d{1,3})\s+(GK|DF|MF|FW)\s+([가-힣A-Za-zÀ-ž.'· -]+?)(?:\s{2,}|\s+\d|$)", line)
    if not match:
        return None
    number, position, name = match.groups()
    name = re.sub(r'\s+', ' ', name).strip()
    if not name:
        return None
    return {'number': number, 'position': position, 'name': name, 'label': f'No.{number} {name}', 'starter': starter, 'isSubstitute': not starter}


def _kit_part(raw: str) -> dict:
    names = [re.sub(r'\s+', '', item) for item in raw.split('/') if item.strip()]
    return {'label': ' / '.join(names), 'colors': names, 'hex': KIT_COLORS.get(names[0]) if names else None}


def parse_kfa_layout(pages: list[str], *, first_team_side: str = 'AUTO', expected_teams: dict | None = None) -> dict:
    headers = re.compile(r'선발\s*출전\s*선수')
    boundary = None
    for page in pages:
        for line in page.splitlines():
            matches = list(headers.finditer(line))
            if len(matches) == 2:
                boundary = matches[1].start()
                break
        if boundary is not None:
            break
    if boundary is None:
        raise ValueError('PDF에서 좌우 선수 명단을 확인하지 못했습니다. KFA 원본 PDF 또는 명단 직접 입력을 사용하세요.')

    names = ['', '']
    kits = [{}, {}]
    players = [{}, {}]
    states = [None, None]
    for page in pages:
        # Re-detect each page's column boundary: wide printed margins must not
        # become the split point, and DOM/PDF stream order must not matter.
        page_lines = page.splitlines()
        for line in page_lines:
            matches = list(headers.finditer(line))
            if len(matches) == 2:
                boundary = matches[1].start()
                break
        for line in page_lines:
            title = re.match(r'^\s*(.+?)\s+\d+\s+\d+\s+(?:연장전반|연장후반|전반전|후반전)\s+\d+\s+\d+\s+(.+?)\s*$', line)
            if title:
                names = [re.sub(r'\s+', ' ', value).strip() for value in title.groups()]
            uniforms = list(re.finditer(r'\[상의\](.*?)\[하의\](.*?)\[양말\]([^\[]*)', line))
            if len(uniforms) == 2:
                role = 'goalkeeper' if re.search(r'\bGK', line) else 'field'
                for index, uniform in enumerate(uniforms):
                    parts = [re.sub(r'(필드|GK).*$', '', value).strip() for value in uniform.groups()]
                    kits[index][role] = {key: _kit_part(value) for key, value in zip(('shirt', 'shorts', 'socks'), parts)}
            for index, column in enumerate((line[:boundary], line[boundary:])):
                compact = re.sub(r'\s+', '', column)
                if headers.search(column):
                    states[index] = 'starter'
                    continue
                if compact.startswith('후보선수'):
                    states[index] = 'substitute'
                    continue
                if compact.startswith(('교체선수', '자책골', '지도자/', '경기번호')):
                    states[index] = None
                if states[index] is None:
                    continue
                player = player_from_line(column, states[index] == 'starter')
                if player:
                    previous = players[index].get(player['number'])
                    if previous and previous['name'] != player['name']:
                        raise ValueError('PDF의 같은 팀에 중복 등번호가 있습니다. 명단을 확인하세요.')
                    players[index][player['number']] = player
    if not all(players):
        raise ValueError('홈과 어웨이 선수 명단을 모두 읽지 못했습니다. PDF 형식을 확인하세요.')

    first_side = first_team_side.strip().upper()
    if first_side not in {'AUTO', 'HOME', 'AWAY'}:
        raise ValueError('명단 방향은 AUTO, HOME, AWAY 중 선택하세요.')
    detected_by = 'manual' if first_side != 'AUTO' else 'layout'
    if first_side == 'AUTO':
        first_side = 'HOME'
        expected = {side: team_key(str((expected_teams or {}).get(side) or '')) for side in ('HOME', 'AWAY')}
        observed = [team_key(name) for name in names]
        if all(observed) and observed[0] != observed[1]:
            matches = set()
            if expected['HOME'] == observed[1] or expected['AWAY'] == observed[0]:
                matches.add('AWAY')
            if expected['HOME'] == observed[0] or expected['AWAY'] == observed[1]:
                matches.add('HOME')
            if len(matches) > 1:
                raise ValueError('경기의 홈·어웨이 팀명이 서로 충돌합니다. 팀명을 확인하거나 명단 방향을 직접 선택하세요.')
            if matches:
                first_side, detected_by = matches.pop(), 'team_names'
    sides = [first_side, 'AWAY' if first_side == 'HOME' else 'HOME']
    return {
        'source': 'match_record_pdf', 'first_team_side': first_side, 'detected_by': detected_by,
        'teams': {side: sorted(players[index].values(), key=lambda p: int(p['number'])) for index, side in enumerate(sides)},
        'team_names': {side: names[index] for index, side in enumerate(sides)},
        'uniforms': {side: kits[index] for index, side in enumerate(sides)},
    }


def parse_lineup_pdf(file_bytes: bytes, *, first_team_side: str = 'AUTO', expected_teams: dict | None = None) -> dict:
    if len(file_bytes) > 20 * 1024 * 1024:
        raise ValueError('PDF는 20MB 이하로 업로드하세요.')
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        if len(reader.pages) > 30:
            raise ValueError('명단 PDF는 30페이지 이하로 업로드하세요.')
        pages = [page.extract_text(extraction_mode='layout') for page in reader.pages]
    except ValueError:
        raise
    except Exception as error:
        raise ValueError('PDF를 읽지 못했습니다. 암호가 없는 원본 PDF를 업로드하세요.') from error
    return parse_kfa_layout(pages, first_team_side=first_team_side, expected_teams=expected_teams)
