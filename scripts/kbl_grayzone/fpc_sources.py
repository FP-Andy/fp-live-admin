"""Read-only FPC catalogue and recording manifests. Never imports stream keys.

The local adapter reads the existing recorder over SSH. A deployed workbench
can use a read-only recording volume instead, without changing preparation jobs.
Configuration is server-side only; request bodies cannot supply hosts or paths.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import json,re,shlex,ssl,subprocess,threading,urllib.request,uuid
from job_store import atomic,lease,busy,now

ROOT=Path(__file__).resolve().parents[2]
STORE=ROOT/'outputs/kbl-library'
CONFIG=ROOT/'runtime/kbl-cv/fpc.json'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='fpc-catalogue')
LOCK=threading.RLock();FUTURE=None

def config():
    # Hosts and S3 locations are supplied by the operator's private config.
    settings={'apiBase':'','recordingMode':'disabled','recordingRoot':'/recordings','downloadMiBPerSecond':8}
    if CONFIG.is_file():settings.update(json.loads(CONFIG.read_text()))
    return settings

def match_id(value):
    try:return str(uuid.UUID(value))
    except (ValueError,TypeError,AttributeError):raise ValueError('FPC 경기 ID를 확인하세요.') from None

def normalize_match(row):
    from match_library import team
    if not isinstance(row,dict):raise ValueError('경기 정보 형식을 확인하세요.')
    if row.get('sport')!='BASKETBALL':return None
    metadata=row.get('metadata') if isinstance(row.get('metadata'),dict) else {};name=str(row.get('name',''))
    home=metadata.get('home_team');away=metadata.get('away_team')
    if not home or not away:
        pair=re.split(r'\s+vs\.?\s+',re.sub(r'^\[[^]]*\]\s*','',name),flags=re.I)
        if len(pair)!=2:return None
        home,away=pair
    home,away=team(str(home)),team(str(away))
    if not home or not away or home==away:return None
    date=None;basis='registered-at'
    for field in ('match_date','game_date','scheduled_at','kickoff_at','date'):
        value=metadata.get(field)
        if not isinstance(value,str):continue
        try:
            parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
            date=(parsed.astimezone(ZoneInfo('Asia/Seoul')) if parsed.tzinfo else parsed).date().isoformat()
            basis='fixture-metadata';break
        except ValueError:continue
    if date is None:
        parsed=datetime.fromisoformat(row['created_at'].replace('Z','+00:00'))
        if parsed.tzinfo is None:parsed=parsed.replace(tzinfo=timezone.utc)
        date=parsed.astimezone(ZoneInfo('Asia/Seoul')).date().isoformat()
    return {'id':match_id(row['id']),'home':home[:80],'away':away[:80],'date':date,'dateBasis':basis,
            'venue':str(metadata.get('venue') or '')[:120],'gameNumber':str(metadata.get('game_number') or '')[:20],
            'archived':bool(row.get('archived')),'source':'fpc-live','recordingState':'not-checked'}

def catalogue():
    path=STORE/'fpc-catalogue.json'
    data=json.loads(path.read_text()) if path.exists() else {'matches':[],'fetchedAt':None}
    status_path=STORE/'fpc-sync.json'
    sync=json.loads(status_path.read_text()) if status_path.exists() else {'state':'idle'}
    if sync['state']=='running' and (FUTURE is None or FUTURE.done()) and not busy(STORE/'fpc-sync.lock'):
        sync={**sync,'state':'interrupted','message':'목록 새로고침이 중단됐습니다. 다시 불러올 수 있습니다.'}
    return {**data,'sync':sync}

def refresh():
    global FUTURE
    with LOCK:
        if FUTURE and not FUTURE.done():return catalogue()
        guard=lease(STORE/'fpc-sync.lock');acquired=guard.__enter__()
        if not acquired:
            guard.__exit__(None,None,None);return catalogue()
        try:
            # Keep the lease from enqueue through completion across processes.
            atomic(STORE/'fpc-sync.json',{'state':'running','startedAt':now(),'message':'FPC 최신 경기 목록을 불러오는 중입니다.'})
            FUTURE=POOL.submit(_refresh,guard)
        except Exception:
            guard.__exit__(None,None,None);raise
        return catalogue()

def _refresh(guard):
    try:
        try:
            base=config()['apiBase'].rstrip('/');url=urlsplit(base)
            if url.scheme!='https' or not url.hostname or url.username or url.password:raise ValueError('FPC 연결 주소를 확인하세요.')
            import certifi
            request=urllib.request.Request(base+'/api/matches?sport=BASKETBALL&compact=false',headers={'Accept':'application/json'})
            with urllib.request.urlopen(request,timeout=20,context=ssl.create_default_context(cafile=certifi.where())) as response:
                raw=response.read(16*1024**2+1)
            if len(raw)>16*1024**2:raise ValueError('FPC 경기 목록이 너무 큽니다. 서버의 목록 범위를 확인하세요.')
            payload=json.loads(raw)
            if not isinstance(payload,list):raise ValueError('FPC 경기 목록 형식을 확인하세요.')
            rows=[];skipped=0
            for row in payload:
                try:normalized=normalize_match(row)
                except (ValueError,KeyError,TypeError,AttributeError):
                    skipped+=1;continue
                if normalized:rows.append(normalized)
            if skipped and not rows:raise ValueError('FPC 경기 정보를 확인하세요.')
            atomic(STORE/'fpc-catalogue.json',{'schema':'kbl-fpc-catalogue/v1','matches':rows,'fetchedAt':now()})
            atomic(STORE/'fpc-sync.json',{'state':'complete','finishedAt':now(),'count':len(rows),'skipped':skipped,
                'message':'최신 경기 목록을 저장했습니다.'+(f' 형식 확인이 필요한 {skipped}개 항목은 제외했습니다.' if skipped else '')})
        except Exception:
            # Preserve the last good catalogue. Never expose request URLs or auth.
            atomic(STORE/'fpc-sync.json',{'state':'failed','finishedAt':now(),'message':'FPC 목록을 새로 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도하세요. 이전 목록은 유지됩니다.'})
    finally:guard.__exit__(None,None,None)

# Executed by the recorder's Python, or locally against a read-only mounted
# volume. Only this whitelist crosses the adapter boundary; stream keys do not.
MANIFEST_READER=r'''
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);mid=sys.argv[2];rows=[]
for path in root.glob('*/state.json'):
    d=json.loads(path.read_text())
    if d.get('match_id')!=mid:continue
    row={k:d.get(k) for k in ('id','match_id','status','desired','created_at','updated_at','stopped_at','interruptions')}
    row['parts']=[{k:p.get(k) for k in ('key','duration','bytes','saved_at')} for p in d.get('parts',[])]
    rows.append(row)
print(json.dumps(rows))
'''

def recordings(value):
    mid=match_id(value);c=config()
    if c['recordingMode']=='mounted':
        import sys
        args=[sys.executable,'-c',MANIFEST_READER,c['recordingRoot'],mid]
    elif c['recordingMode']=='ssh':
        remote=['docker','exec',c['recordingContainer'],'python','-c',MANIFEST_READER,c['recordingRoot'],mid]
        args=['ssh','-F',c['sshConfig'],'-o','BatchMode=yes','-o','ConnectTimeout=10',c['sshHost'],shlex.join(remote)]
    else:raise ValueError('FPC 녹화 연결 방식을 확인하세요.')
    try:
        proc=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
        if proc.returncode or len(proc.stdout)>32*1024**2:raise RuntimeError('녹화 목록을 읽지 못했습니다.')
        source=json.loads(proc.stdout);rows=[]
        for row in source:
            sid=match_id(row['id']);parts=[];position=0.
            if row['match_id']!=mid:raise ValueError('다른 경기의 녹화 정보입니다.')
            for i,p in enumerate(row['parts']):
                key=p.get('key');duration=float(p.get('duration') or 0);size=int(p.get('bytes') or 0)
                # Unuploaded recorder segments have no durable S3 key yet.
                if not key:continue
                prefix=f'prelaunch/recordings/{mid}/{sid}/'
                if not key.startswith(prefix) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.mp4',key[len(prefix):]):raise ValueError('녹화 원본 경로를 확인하세요.')
                if not 0<duration<=300 or not 0<size<=2*1024**3:raise ValueError('녹화 구간 정보를 확인하세요.')
                parts.append({'index':i,'key':key,'duration':duration,'bytes':size,'saved_at':p.get('saved_at'),'start_seconds':position})
                position+=duration
            rows.append({'match_id':mid,'session_id':sid,'status':row.get('status'),'recordingActive':bool(row.get('desired')),
                'created_at':row.get('created_at'),'updated_at':row.get('updated_at'),'stopped_at':row.get('stopped_at'),
                'interruptions':row.get('interruptions',0),'duration':position,'bytes':sum(p['bytes'] for p in parts),'parts':parts})
        return sorted(rows,key=lambda r:r.get('created_at') or '',reverse=True)
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError,RuntimeError):
        raise RuntimeError('FPC 광각 녹화 목록을 읽지 못했습니다. 녹화 서버 연결을 확인한 뒤 다시 시도하세요.') from None
