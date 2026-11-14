"""Local fixture registry. FPC imports copy allowlisted metadata, never controls."""
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import copy,json,re,threading,unicodedata,uuid
import case_store
from job_store import atomic,lease
ROOT=Path(__file__).resolve().parents[2]
STORE=ROOT/'outputs/kbl-library/matches.json'
LOCK=threading.RLock()
TEAMS=['서울 SK','창원 LG','수원 KT','안양 정관장','원주 DB','대구 한국가스공사','서울 삼성','부산 KCC','고양 소노','울산 현대모비스']
ALIASES={
    '서울 SK 나이츠':'서울 SK','창원 LG 세이커스':'창원 LG',
    '고양 소노 스카이거너스':'고양 소노','수원 KT 소닉붐':'수원 KT',
    '원주 DB프로미':'원주 DB','원주 DB 프로미':'원주 DB',
    '대구 한국가스공사 페가수스':'대구 한국가스공사','서울 삼성 썬더스':'서울 삼성',
    '울산 현대모비스 피버스':'울산 현대모비스','부산 KCC 이지스':'부산 KCC',
    '안양 정관장 레드부스터스':'안양 정관장',
    'KCC':'부산 KCC','LG':'창원 LG','KT':'수원 KT','SK':'서울 SK',
    '정관장':'안양 정관장','삼성':'서울 삼성','DB':'원주 DB',
}
TEAM_NAMES_CASEFOLD={name.casefold():canonical for name,canonical in {**{name:name for name in TEAMS},**ALIASES}.items()}
def team(value):
    name=' '.join(unicodedata.normalize('NFC',value).split())
    return TEAM_NAMES_CASEFOLD.get(name.casefold(),name)
def now():return datetime.now(timezone.utc).isoformat()
def sources():
    rows={}
    paths=[STORE.with_name('fpc-recordings.json')]
    for path in paths:
        if not path.exists():continue
        for r in json.loads(path.read_text()):
            if not r.get('home_team') or not r.get('away_team'):continue
            key=r['match_id'];date=datetime.fromisoformat(r['created_at']).astimezone(ZoneInfo('Asia/Seoul')).date().isoformat()
            row=dict(id=key,home=team(r['home_team']),away=team(r['away_team']),date=date,venue='',gameNumber='',source='fpc-snapshot',dateBasis='recording-start',recordingState=r['status'],snapshotDate=datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).date().isoformat())
            if key not in rows or row['date']>rows[key]['date']:rows[key]=row
    import fpc_sources
    live=fpc_sources.catalogue()
    for item in live['matches']:
        previous=rows.get(item['id']);row={**item,'snapshotDate':live.get('fetchedAt'),'lastSyncedAt':live.get('fetchedAt')}
        if previous:
            row['recordingState']=previous['recordingState']
            if row['dateBasis']=='registered-at':row.update(date=previous['date'],dateBasis=previous['dateBasis'])
        rows[item['id']]=row
    for key,root in case_store.CASES.items():
        c=json.loads((root/'case.json').read_text());wide=c['events'][0].get('wide',{});fpc=wide.get('matchId')
        if fpc and fpc in rows:rows[fpc].update(date=c['date'],dateBasis='verified-fixture',gameNumber=c['gameNumber'],venue=c.get('venue',''))
    return sorted(rows.values(),key=lambda r:(r['date'],r['id']),reverse=True)

def seeds():
    rows=[]
    for key,root in case_store.CASES.items():
        c=json.loads((root/'case.json').read_text());wide=c['events'][0].get('wide',{})
        rows.append(dict(id=key,home=team(c['home']),away=team(c['away']),date=c['date'],venue=c.get('venue',''),gameNumber=c['gameNumber'],referees=c.get('referees',[]),source='existing-case',caseId=key,fpcMatchId=wide.get('matchId'),createdAt=now()))
    if not (ROOT/'outputs/kbl-grayzone-demo-20261020/manifest.json').is_file() or not (ROOT/'outputs/kbl-grayzone-demo-20261020/referees.json').is_file():return rows
    manifest=json.loads((ROOT/'outputs/kbl-grayzone-demo-20261020/manifest.json').read_text())
    rosters=json.loads((ROOT/'outputs/kbl-grayzone-demo-20261020/referees.json').read_text())
    seen=set()
    for c in manifest['clips']:
        if c['match_id'] in seen:continue
        seen.add(c['match_id']);home,away=c['game'].split(' vs ')
        city=next(x for x in ('wonju','suwon','anyang') if x in c['slug'])
        roster=next((r['referees'] for r in rosters['games'] if r['match_id']==c['match_id']),[])
        rows.append(dict(id='fpc-'+c['match_id'],home=team(home),away=team(away),date=c['date'],venue='',gameNumber='',referees=roster,source='fpc-snapshot',fpcMatchId=c['match_id'],demoMatchId=f'{city}-1',createdAt=now()))
    return rows
def read():
    if STORE.exists():return json.loads(STORE.read_text())
    return {'matches':seeds()}
def write(data):
    atomic(STORE,data)

def initialize():
    """Create a catalog once, retaining any existing case seeds."""
    with LOCK,lease(STORE.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('다른 경기 등록을 저장 중입니다. 잠시 후 다시 시도하세요.')
        if STORE.is_symlink():raise RuntimeError('경기 목록 저장 위치를 확인하세요.')
        if not STORE.exists():write(read())

def attach_case(key,case_id,referees):
    """Keep earlier case links when another intake is registered for a match."""
    if not isinstance(case_id,str) or not re.fullmatch(r'[a-z0-9-]+',case_id):raise ValueError('판독 자료 ID를 확인하세요.')
    with LOCK,lease(STORE.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('다른 경기 등록을 저장 중입니다. 잠시 후 다시 시도하세요.')
        data=read();row=next((r for r in data['matches'] if r['id']==key),None)
        if row is None:raise ValueError('등록된 경기를 찾을 수 없습니다.')
        previous=row.get('caseIds',[])
        if not isinstance(previous,list) or any(not isinstance(x,str) or not re.fullmatch(r'[a-z0-9-]+',x) for x in previous):
            raise RuntimeError('기존 판독 자료 연결을 확인하세요.')
        ids=list(dict.fromkeys([*previous,*([row['caseId']] if row.get('caseId') else []),case_id]))
        row.update(caseIds=ids,caseId=case_id,referees=copy.deepcopy(referees));write(data)
        return copy.deepcopy(row)

def ensure_authorized_fpc(match_id,fixture,home,away):
    """Associate a verified FPC match without relinking or deleting existing rows.

    This is called only by the loopback adapter after FPC checks match access.
    Match identity and teams come from FPC, not from the intake request.
    """
    try:mid=str(uuid.UUID(match_id))
    except (ValueError,TypeError,AttributeError):raise ValueError('FPC 경기 ID를 확인하세요.') from None
    if not all(isinstance(x,str) and x.strip() for x in (home,away)) or team(home)!=team(str(fixture.get('home',''))) or team(away)!=team(str(fixture.get('away',''))):
        raise ValueError('선택한 FPC 경기와 CSV의 홈팀·원정팀이 일치하지 않습니다.')
    with LOCK,lease(STORE.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('다른 경기 등록을 저장 중입니다. 잠시 후 다시 시도하세요.')
        data=read();existing=[r for r in data['matches'] if r.get('fpcMatchId')==mid]
        if len(existing)>1:raise RuntimeError('FPC 경기 연결이 중복되어 있습니다. 기존 연결을 먼저 확인하세요.')
        if existing:
            validate_fixture(existing[0],fixture)
            return copy.deepcopy(existing[0])
        key='fpc-'+mid
        if any(r.get('id')==key for r in data['matches']):raise RuntimeError('경기 ID가 기존 자료와 충돌합니다.')
        row={'id':key,'fpcMatchId':mid,'home':team(home),'away':team(away),'date':fixture['date'],
             'gameNumber':fixture.get('gameNumber',''),'venue':fixture.get('venue',''),
             'referees':[],'source':'fpc-authorized','createdAt':now()}
        data['matches'].append(row);write(data);return copy.deepcopy(row)
def get(key):
    row=next((r for r in read()['matches'] if r['id']==key),None)
    if not row:raise ValueError('등록된 경기를 찾을 수 없습니다.')
    return copy.deepcopy(row)
def intakes(row):
    out=[]
    for path in (ROOT/'outputs/kbl-intake').glob('*/intake.json'):
        d=json.loads(path.read_text())
        if d.get('libraryMatchId')!=row['id'] and not (row.get('caseId') and d.get('linkedCaseId')==row['caseId']):continue
        out.append(dict(id=d['id'],status=d['status'],receivedAt=d['receivedAt'],videoCount=len(d['media']),eventCount=len(d.get('events',[])),selectedCount=sum(bool(e.get('selection')) for e in d.get('events',[])),media=[{'name':m['name'],'status':m['status']} for m in d['media']]))
    return sorted(out,key=lambda r:r['receivedAt'],reverse=True)
def detail(key):
    row=get(key);row['intakes']=intakes(row)
    if row.get('fpcMatchId'):
        import wide_preparation
        row['widePreparation']=wide_preparation.public(row['fpcMatchId'])
    return row
def listing():
    rows=read()['matches']
    for row in rows:
        jobs=intakes(row);row['intakeCount']=len(jobs);row['latestIntakeId']=jobs[0]['id'] if jobs else None
    return {'matches':sorted(rows,key=lambda r:(r['date'],r['id']),reverse=True)}
def validate_fixture(row,fixture):
    mismatches=[]
    for key,label in (('date','경기일'),('home','홈팀'),('away','원정팀'),('gameNumber','경기번호')):
        selected=str(row.get(key,'')).strip();uploaded=str(fixture.get(key,'')).strip()
        if key=='gameNumber' and not selected:continue
        same=(team(selected)==team(uploaded)) if key in ('home','away') else (selected.lstrip('0')==uploaded.lstrip('0')) if key=='gameNumber' else selected==uploaded
        if not same:mismatches.append(f'{label} (경기: {selected} / CSV: {uploaded})')
    if mismatches:
        raise ValueError('CSV의 경기일·홈팀·원정팀·경기번호가 선택한 경기와 다릅니다. 불일치: '+', '.join(mismatches)+'. 올바른 경기에서 등록하세요.')
def create(payload):
    with LOCK,lease(STORE.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('다른 경기 등록을 저장 중입니다. 잠시 후 다시 시도하세요.')
        if not isinstance(payload,dict):raise ValueError('경기 정보가 필요합니다.')
        fpc=payload.get('fpcMatchId');source=next((s for s in sources() if s['id']==fpc),None) if fpc else None
        if fpc and source is None:raise ValueError('FPC 목록의 경기를 선택하세요.')
        clean={}
        for k,limit in [('home',80),('away',80),('date',10),('venue',120),('gameNumber',20)]:
            v=payload.get(k,'')
            if not isinstance(v,str) or len(v)>limit:raise ValueError('경기 정보를 확인하세요.')
            clean[k]=v.strip()
        clean['home']=team(clean['home']);clean['away']=team(clean['away'])
        if source and (clean['home']!=source['home'] or clean['away']!=source['away']):raise ValueError('FPC에서 선택한 경기의 홈팀·원정팀을 유지하세요. 다른 경기라면 직접 생성하세요.')
        if not clean['home'] or not clean['away'] or clean['home']==clean['away']:raise ValueError('서로 다른 홈팀과 원정팀이 필요합니다.')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',clean['date']):raise ValueError('경기일을 확인하세요.')
        datetime.strptime(clean['date'],'%Y-%m-%d')
        data=read()
        existing=next((r for r in data['matches'] if (fpc and r.get('fpcMatchId')==fpc) or all(r[k]==clean[k] for k in ('date','home','away'))),None)
        if existing:
            linked_now=bool(source and not existing.get('fpcMatchId'))
            if source and existing.get('fpcMatchId') not in (None,fpc):raise ValueError('이 경기는 다른 FPC 원본에 연결되어 있습니다. 경기 상세에서 연결을 확인하세요.')
            if source and not existing.get('fpcMatchId'):
                existing.update(fpcMatchId=fpc,sourceSnapshotDate=source.get('snapshotDate'),fpcLinkedAt=now())
                write(data)
            return {**existing,'alreadyExists':True,'fpcLinkedNow':linked_now}
        row=dict(clean,id='match-'+uuid.uuid4().hex[:16],source=source['source'] if source else 'manual',createdAt=now(),referees=[])
        if source:row.update(fpcMatchId=fpc,sourceSnapshotDate=source.get('snapshotDate'))
        data['matches'].append(row);write(data);return row

def source_status():
    import fpc_sources,storage_policy
    storage_policy.external_root()
    status=fpc_sources.catalogue()
    return {'matches':sources(),'mode':'fpc-live-with-cache','fetchedAt':status['fetchedAt'],'sync':status['sync']}

def link_fpc(key,payload):
    import fpc_sources
    mid=fpc_sources.match_id(payload.get('fpcMatchId'));source=next((s for s in sources() if s['id']==mid),None)
    if not source:raise ValueError('최신 FPC 목록에서 경기를 선택하세요.')
    with LOCK,lease(STORE.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('다른 경기 변경을 저장 중입니다. 잠시 후 다시 시도하세요.')
        data=read();row=next((m for m in data['matches'] if m['id']==key),None)
        if not row:raise ValueError('등록된 경기를 확인하세요.')
        if team(row['home'])!=source['home'] or team(row['away'])!=source['away']:raise ValueError('홈팀·원정팀이 같은 FPC 경기를 선택하세요.')
        if payload.get('expectedFpcMatchId')!=row.get('fpcMatchId'):raise RuntimeError('FPC 연결이 다른 화면에서 변경됐습니다. 다시 불러오세요.')
        if source['dateBasis'] in ('fixture-metadata','verified-fixture') and row['date']!=source['date']:raise ValueError('경기일이 다릅니다. 같은 날짜의 FPC 경기를 선택하세요.')
        row.update(fpcMatchId=mid,fpcLinkedAt=now());write(data)
        if row.get('caseId'):
            import case_store
            path=case_store.CASES.get(row['caseId'])
            if path and (path/'case.json').exists():
                case=json.loads((path/'case.json').read_text())
                if case.get('wideAssistance',{}).get('enabled'):
                    case.update(fpcMatchId=mid,wideReferenceMode='automatic-secondary-camera')
                    atomic(path/'case.json',case)
    return detail(key)
