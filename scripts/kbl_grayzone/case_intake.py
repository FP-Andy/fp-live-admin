"""Import broadcaster review records without conflating three time bases."""
import csv
from datetime import datetime
import hashlib
import io
import re
import unicodedata


def csv_referees(rows):
    """Read a consistent, catalogue-verified crew without assigning video identities."""
    from referee_roster import CATALOGUE
    known={person['number']:person['name'] for person in CATALOGUE}
    assigned={}
    for row in rows:
        for index in range(1,4):
            value=unicodedata.normalize('NFC',(row.get(f'심판{index}') or '').strip())
            if not value:continue
            match=re.fullmatch(r'#?\s*(\d{1,3})\s*[.．]\s*(\S(?:.*\S)?)',value)
            if not match:raise ValueError(f'CSV 심판{index}의 번호와 이름을 확인하세요. 예: 23.김태환')
            number=int(match[1]);name=match[2]
            if number not in known or unicodedata.normalize('NFC',known[number])!=name:
                raise ValueError(f'CSV 심판{index} ({value})이 심판 명단의 번호·이름과 일치하지 않습니다. 명단과 CSV를 확인하세요.')
            person={'number':number,'name':known[number]}
            if index in assigned and assigned[index]!=person:
                raise ValueError(f'CSV의 심판{index} 정보가 판독 행마다 다릅니다. 심판 배정을 확인하세요.')
            assigned[index]=person
    refs=[assigned[index] for index in sorted(assigned)]
    if len({person['number'] for person in refs})!=len(refs):raise ValueError('CSV의 배정 심판이 중복됩니다. 심판 정보를 확인하세요.')
    return refs


def clock_seconds(value):
    match=re.fullmatch(r'(\d{1,2}):([0-5]\d(?:\.\d{1,3})?)',value.strip())
    if not match:raise ValueError('경기 시계는 분:초 형식이어야 합니다.')
    result=int(match[1])*60+float(match[2])
    if not 0<=result<=600:raise ValueError('경기 시계 범위를 확인하세요.')
    return result


def parse_csv(raw):
    try:text=raw.decode('utf-8-sig')
    except UnicodeDecodeError:raise ValueError('CSV를 UTF-8 형식으로 저장한 뒤 다시 등록하세요.') from None
    reader=csv.DictReader(io.StringIO(text))
    required=('경기번호','경기일','홈팀','원정팀','판독횟수','쿼터','경기시간','소요시간(초)',
              '판독구분','요청팀','판독결과','판독결과(직접입력)','기록시각','작성자')
    missing=[name for name in required if name not in (reader.fieldnames or [])]
    if missing:raise ValueError('CSV 필수 열이 없습니다: '+', '.join(missing))
    rows=list(reader)
    if not 1<=len(rows)<=10:raise ValueError('한 경기의 판독 기록 1~10개가 필요합니다.')
    events=[];fixture=None;seen=set()
    for row in rows:
        if None in row or any(row.get(k) is None for k in required):raise ValueError('CSV 행의 열 개수가 헤더와 다릅니다. 쉼표가 포함된 값은 따옴표로 감싸세요.')
        game={k:row[k].strip() for k in ('경기번호','경기일','홈팀','원정팀')}
        if not all(game.values()) or game['홈팀']==game['원정팀']:raise ValueError('CSV의 경기번호·경기일·홈팀·원정팀을 확인하세요.')
        datetime.strptime(game['경기일'],'%Y-%m-%d')
        if fixture is not None and fixture!=game:raise ValueError('다른 경기의 기록이 섞여 있습니다.')
        fixture=game
        number=int(row['판독횟수']);quarter=int(row['쿼터'].strip().upper().removesuffix('Q').removeprefix('Q'))
        if number<1 or number in seen or not 1<=quarter<=20:raise ValueError('판독 번호/쿼터를 확인하세요.')
        seen.add(number);clock=row['경기시간'].strip()
        # A missing source clock is unknown, never 0:00 or the entry timestamp.
        try:seconds=clock_seconds(clock) if clock else None
        except ValueError as exc:raise ValueError(f'판독 {number}: {exc}') from None
        if quarter>4 and seconds is not None and seconds>300:raise ValueError(f'판독 {number}: 연장전 시계 범위를 확인하세요.')
        duration=int(row['소요시간(초)'])
        if duration<0:raise ValueError('판독 소요시간을 확인하세요.')
        events.append(dict(id=f'review-{number}',number=number,quarter=quarter,gameClock=clock or '시각 미기재',
                           gameClockSeconds=seconds,gameClockStatus='recorded' if clock else 'missing',reviewDurationSeconds=duration,
                           requestType=row['판독구분'],requestingTeam=row['요청팀'],
                           recordedDecision=row['판독결과'],recordedReason=row['판독결과(직접입력)'],
                           recordedAt=row['기록시각'],recordedBy=row['작성자'],
                           decisionSource='broadcaster CSV; not an automated verdict',
                           selectedFrame=None,selectionStatus='awaiting-user'))
    case=dict(schema='kbl-review-case/v1',gameNumber=fixture['경기번호'],date=fixture['경기일'],
                home=fixture['홈팀'],away=fixture['원정팀'],events=sorted(events,key=lambda x:x['number']),
                csvSha256=hashlib.sha256(raw).hexdigest(),revision=0,
                timingPolicy=dict(event='quarter + remaining game clock',
                                  recordedAt='entry time; never treated as event timestamp',
                                  reviewDuration='official review duration; not incident clip length',
                                  maxIncidentSeconds=30,slaMinutes=90,slaStart='upload-completed',planningIncidentCount=8))
    refs=csv_referees(rows)
    if refs:case['referees']=refs
    return case
