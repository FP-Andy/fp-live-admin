"""Read only the UCCC fixture list and match roster from MatchDay."""
import hashlib
import json
import os
import re
import threading
import time

import httpx

BASE = 'https://api.matchday-planner.com/api/v1'
COMPETITION_ID = int(os.getenv('MATCHDAY_UCCC_COMPETITION_ID', '31'))
_cache = None
_cache_at = 0.0
_cache_lock = threading.Lock()


class MatchdayError(Exception):
    pass


def _get(client, path):
    try:
        response = client.get(BASE + path)
        response.raise_for_status()
        body = response.json()
        if body.get('status') != 200 or not isinstance(body.get('data'), dict):
            raise ValueError('invalid response')
        return body['data']
    except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
        raise MatchdayError('매치데이 응답을 가져오지 못했습니다. 잠시 후 다시 시도하세요.') from exc


def fixtures(refresh=False):
    global _cache, _cache_at
    with _cache_lock:
        if not refresh and _cache is not None and time.monotonic() - _cache_at < 30:
            return _cache
        result = []
        with httpx.Client(timeout=httpx.Timeout(10.0, connect=3.0)) as client:
            for stage in ('qualifying', 'finals'):
                data = _get(client, f'/competitions/{COMPETITION_ID}/stages/{stage}/matches')
                if data.get('competitionId') != COMPETITION_ID or not isinstance(data.get('matches'), list):
                    raise MatchdayError('매치데이 경기 목록 형식이 올바르지 않습니다.')
                for item in data['matches']:
                    if not isinstance(item, dict) or not isinstance(item.get('matchId'), int):
                        raise MatchdayError('매치데이 경기 목록 형식이 올바르지 않습니다.')
                    result.append({key: item.get(key) for key in ('matchId', 'matchName', 'homeTeamId', 'homeTeamName', 'awayTeamId', 'awayTeamName', 'scheduledAt', 'stadiumName', 'roundNumber', 'status')} | {'stage': stage})
        _cache, _cache_at = result, time.monotonic()
        return result


def roster(match_id):
    with httpx.Client(timeout=httpx.Timeout(10.0, connect=3.0)) as client:
        data = _get(client, f'/matches/{match_id}/players')
    teams = {}
    errors = []
    for side, key in (('HOME', 'homeTeam'), ('AWAY', 'awayTeam')):
        source = data.get(key)
        if not isinstance(source, dict) or any(not isinstance(source.get(k), list) for k in ('starters', 'substitutes')):
            raise MatchdayError('매치데이 명단 형식이 올바르지 않습니다.')
        players, numbers = [], set()
        for group in ('starters', 'substitutes'):
            for player in source[group]:
                if not isinstance(player, dict):
                    raise MatchdayError('매치데이 선수 정보 형식이 올바르지 않습니다.')
                name = str(player.get('name') or '').strip()
                raw_number = player.get('number')
                number = str(raw_number).strip() if raw_number is not None else ''
                if not name or not re.fullmatch(r'\d{1,3}', number) or int(number) in numbers:
                    errors.append(f'{"홈" if side == "HOME" else "어웨이"} {name or "이름 없음"}: 이름 또는 등번호 누락/중복')
                if number.isdigit():
                    numbers.add(int(number))
                entry = {'name': name, 'number': number, 'label': f'No.{number} {name}', 'isSubstitute': group == 'substitutes', 'matchdayUserId': player.get('userId'), 'matchdayMatchUserId': player.get('id')}
                if player.get('matchPosition') in ('GK', 'DF', 'MF', 'FW'):
                    entry['position'] = player['matchPosition']
                players.append(entry)
        teams[side] = players
    return teams, errors


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
