"""Durable, read-only FPC source preparation; one bounded download, no decoding.

Cached files are shared by recording UUID, independent of an intake or report.
They are reference footage, never automatically treated as synchronized evidence.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,os,shutil,threading,time
import fpc_sources
import storage_policy
from job_store import atomic,lease,busy,now

ROOT=Path(__file__).resolve().parents[2]
STORE=ROOT/'outputs/kbl-wide-preparation'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='kbl-wide-source')
LOCK=threading.RLock();ACTIVE={}
RESERVE=2*1024**3

class Paused(Exception):pass

def folder(mid):return STORE/fpc_sources.match_id(mid)
def read(mid):
    path=folder(mid)/'status.json'
    return json.loads(path.read_text()) if path.exists() else {'matchId':mid,'state':'idle','recordings':[],'selectedSessionId':None,'message':'광각 녹화 목록을 먼저 확인하세요.'}
def write(mid,data):atomic(folder(mid)/'status.json',data)
def part_path(mid,sid,index):return folder(mid)/fpc_sources.match_id(sid)/f'{index:06}.mp4'
def cache_info(mid,sid,part):
    path=part_path(mid,sid,part['index']);meta=path.with_suffix('.json')
    try:
        saved=json.loads(meta.read_text());stat=path.stat()
        if saved['key']==part['key'] and saved['bytes']==part['bytes']==stat.st_size and saved['mtimeNs']==stat.st_mtime_ns:return saved
    except (OSError,KeyError,ValueError):pass
    return None

def public(mid):
    data=read(mid);state=data['state']
    if state in ('queued','running') and (mid not in ACTIVE or ACTIVE[mid].done()) and not busy(folder(mid)/'job.lock'):
        data={**data,'state':'interrupted','message':'준비 작업이 중단됐습니다. 저장된 구간부터 이어받을 수 있습니다.'}
    records=[]
    for row in data.get('recordings',[]):
        sid=row['session_id'];parts=[]
        for part in row['parts']:
            cached=cache_info(mid,sid,part)
            parts.append({k:part[k] for k in ('index','duration','bytes','start_seconds')}|{
                'cached':bool(cached),'url':f'/wide-source/{mid}/{sid}/{part["index"]}.mp4' if cached else None})
        records.append({k:row[k] for k in ('session_id','status','recordingActive','created_at','stopped_at','interruptions','duration','bytes')}|{
            'parts':parts,'cachedParts':sum(p['cached'] for p in parts),'cachedBytes':sum(p['bytes'] for p in parts if p['cached'])})
    selected=next((r for r in records if r['session_id']==data.get('selectedSessionId')),None)
    if state=='prepared' and selected and selected['cachedParts']!=len(selected['parts']):
        data={**data,'state':'listed','message':'보존된 판독 구간을 제외한 광각 캐시가 정리되었습니다. 필요한 원본은 다시 받을 수 있습니다.'}
    return {k:data.get(k) for k in ('matchId','state','message','operation','selectedSessionId','startedAt','updatedAt','finishedAt','checkedAt','receivedBytes','activePartIndex','activePartBytes','activePartTotal')}|{
        'state':data['state'],'recordings':records,'selected':selected,'freeBytes':storage_policy.free_bytes(STORE),
        'downloadActive':data['state'] in ('queued','running'),'resumeAvailable':data['state'] in ('paused','interrupted','failed'),
        'alignmentStatus':'not-aligned','message':data.get('message',''),'singleDownload':True}

def submit(mid,operation='refresh',session_id=None):
    mid=fpc_sources.match_id(mid)
    if operation not in ('refresh','cache','resume','auto'):raise ValueError('광각 준비 작업을 확인하세요.')
    with LOCK:
        data=read(mid)
        if mid in ACTIVE and not ACTIVE[mid].done():return public(mid)
        guard=lease(folder(mid)/'job.lock');acquired=guard.__enter__()
        if not acquired:
            guard.__exit__(None,None,None);return public(mid)
        try:
            # Hold the process-independent lease while queued, not just running.
            if operation=='resume':operation=data.get('operation') or 'cache'
            if operation=='cache':
                sid=fpc_sources.match_id(session_id or data.get('selectedSessionId'))
                selected=next((r for r in data.get('recordings',[]) if r['session_id']==sid),None)
                if not selected or not selected['parts']:raise ValueError('저장된 구간이 있는 광각 녹화를 선택하세요.')
                needed=sum(p['bytes'] for p in selected['parts'] if not cache_info(mid,sid,p))
                data.update(selectedSessionId=sid,receivedBytes=selected['bytes']-needed,
                            activePartIndex=None,activePartBytes=0,activePartTotal=0)
            data.update(state='queued',operation=operation,message='광각 준비 순서 대기 · GPU 계산과 별도로 진행합니다.',
                        startedAt=now(),updatedAt=now())
            (folder(mid)/'pause.json').unlink(missing_ok=True)
            data.pop('finishedAt',None);write(mid,data)
            ACTIVE[mid]=POOL.submit(_run,mid,guard)
        except Exception:
            guard.__exit__(None,None,None);raise
        return public(mid)

def pause(mid):
    with LOCK:
        data=read(mid)
        if data['state'] not in ('queued','running'):return public(mid)
        atomic(folder(mid)/'pause.json',{'requestedAt':now()})
        data.update(message='현재 전송을 정리하고 일시정지합니다. 받은 부분은 유지됩니다.',updatedAt=now());write(mid,data)
        return public(mid)

def discover(mid):
    """A saved match remains usable even if source discovery cannot be queued."""
    try:return {'widePreparation':submit(mid,'auto')}
    except (OSError,RuntimeError,ValueError):
        return {'preparationWarning':'경기는 저장했습니다. 광각 녹화 목록 새로고침을 눌러 준비를 이어가세요.'}

def update(mid,**values):
    with LOCK:
        data=read(mid);data.update(values,updatedAt=now());write(mid,data)

def check_pause(mid):
    if (folder(mid)/'pause.json').exists():raise Paused()

def prune_old_cache(mid):
    """Housekeeping never changes the completed download's result."""
    try:
        import wide_cache_retention
        wide_cache_retention.ensure_capacity(0,mid,prune_older=True)
    except Exception:
        import logging
        logging.getLogger(__name__).warning('이전 광각 캐시 자동 정리를 완료하지 못했습니다. 기존 자료는 유지됩니다.')

def _run(mid,guard):
    try:
        # Shared disk lease also prevents two local server processes from
        # downloading simultaneously. Waiting does not start a GPU task.
        while True:
            check_pause(mid)
            with lease(STORE/'download.lock') as granted:
                if granted:_prepare(mid);break
            time.sleep(.5)
        if read(mid).get('state')=='prepared' and read(mid).get('operation')!='refresh':
            threading.Thread(target=prune_old_cache,args=(mid,),name='kbl-wide-retention',daemon=True).start()
    except Paused:
        update(mid,state='paused',message='광각 준비를 일시정지했습니다. 받은 부분부터 이어받을 수 있습니다.')
    except Exception as exc:
        message=str(exc) if isinstance(exc,ValueError) else '광각 준비 연결이 중단됐습니다. 원본·다운로드 부분은 유지됩니다. 연결 확인 후 이어받으세요.'
        update(mid,state='failed',message=message,finishedAt=now())
    finally:guard.__exit__(None,None,None)

def _prepare(mid):
    data=read(mid);operation=data['operation']
    update(mid,state='running',message='FPC 광각 녹화 정보를 확인하고 있습니다.')
    if operation in ('refresh','auto'):
        rows=fpc_sources.recordings(mid);check_pause(mid)
        sid=data.get('selectedSessionId')
        if sid not in {r['session_id'] for r in rows}:sid=rows[0]['session_id'] if len(rows)==1 else None
        selected=next((r for r in rows if r['session_id']==sid),None)
        prepared=bool(selected and selected['parts'] and all(cache_info(mid,sid,p) for p in selected['parts']))
        message='녹화 목록을 확인했습니다. 원본을 미리 확보할 수 있습니다.' if rows else '저장된 광각 녹화가 아직 없습니다. 녹화 시작 후 목록을 새로고침하세요.'
        if prepared:message='현재 저장된 광각 구간은 모두 확보되어 있습니다.'+(' 녹화 종료 후 새 구간을 확인하세요.' if selected['recordingActive'] else '')
        update(mid,recordings=rows,selectedSessionId=sid,checkedAt=now(),state='prepared' if prepared else 'listed' if rows else 'waiting',finishedAt=now(),message=message)
        if operation=='refresh' or not selected or not selected['parts']:return
        # Auto-selection is permitted only for an unambiguous recording or a
        # previously selected session. Never borrow a different game's source.
        data=read(mid);update(mid,state='running',message='광각 원본을 자동으로 미리 확보합니다.')
    row=next(r for r in data['recordings'] if r['session_id']==data['selectedSessionId'])
    needed=sum(p['bytes'] for p in row['parts'] if not cache_info(mid,row['session_id'],p))
    if storage_policy.free_bytes(STORE)<needed+RESERVE:
        update(mid,state='running',message='이전 경기의 안전한 광각 캐시를 확인해 저장 공간을 확보하고 있습니다.')
        try:
            import wide_cache_retention
            wide_cache_retention.ensure_capacity(needed+RESERVE,mid,on_progress=lambda message:update(mid,state='running',message=message),check_cancel=lambda:check_pause(mid))
        except Paused:raise
        except (RuntimeError,OSError,ValueError) as exc:
            raise ValueError('자동 공간 확보를 완료하지 못했습니다. 기존 판독 자료는 유지됩니다. 외장 저장소와 연결 상태를 확인하세요.') from exc
        if storage_policy.free_bytes(STORE)<needed+RESERVE:
            raise ValueError('보존할 자료를 제외하고도 공간이 부족합니다. 외장 저장소의 여유 공간을 더 확보하세요.')
        update(mid,state='running',message='저장 공간을 확보했습니다. 광각 원본을 준비합니다.')
    import boto3
    from botocore.config import Config
    settings=fpc_sources.config()
    client=boto3.client('s3',region_name=settings['region'],config=Config(connect_timeout=10,read_timeout=25,max_pool_connections=4,retries={'max_attempts':2}))
    _download_parts(client,settings,mid,row)
    update(mid,state='prepared',finishedAt=now(),activePartIndex=None,activePartBytes=0,
        message='현재 저장된 광각 구간을 모두 확보했습니다.'+(' 녹화가 진행 중이므로 종료 후 새 구간을 확인하세요.' if row['recordingActive'] else ''))
    # Frame pairing uses cached sources immediately; clock OCR is optional.

def _download_parts(client,settings,mid,row):
    """Download distinct parts concurrently within the existing total rate cap."""
    sid=row['session_id'];parts=row['parts']
    if len({p['index'] for p in parts})!=len(parts):
        raise ValueError('광각 원본 구간 정보가 중복됩니다. 녹화 목록을 다시 확인하세요.')
    cached=sum(p['bytes'] for p in parts if cache_info(mid,sid,p))
    pending=[p for p in parts if not cache_info(mid,sid,p)]
    if not pending:return
    total_cap=max(1.,min(50.,float(settings.get('downloadMiBPerSecond',8))))
    workers=min(4,len(pending),max(1,int(total_cap)))
    worker_settings={**settings,'downloadMiBPerSecond':total_cap/workers}
    queue_lock=threading.Lock();progress_lock=threading.Lock();stop=threading.Event()
    positions={};iterator=iter(pending)
    def progress(part,value):
        with progress_lock:
            positions[part['index']]=value
            update(mid,receivedBytes=cached+sum(positions.values()),activePartIndex=part['index'],
                   activePartBytes=value,activePartTotal=part['bytes'],
                   message=f'광각 원본 확보 중 · 구간 {part["index"]+1}/{len(parts)}'+(f' · {workers}개 동시' if workers>1 else ''))
    def work():
        while not stop.is_set():
            check_pause(mid)
            with queue_lock:
                part=next(iterator,None)
            if part is None:return
            try:
                _download(client,worker_settings,mid,sid,part,0,
                          progress=lambda value:progress(part,value),stop_event=stop)
                progress(part,part['bytes'])
            except BaseException:
                stop.set();raise
    with ThreadPoolExecutor(max_workers=workers,thread_name_prefix='kbl-wide-part') as pool:
        futures=[pool.submit(work) for _ in range(workers)]
        errors=[]
        for future in futures:
            try:future.result()
            except BaseException as exc:errors.append(exc)
        if errors:
            raise next((exc for exc in errors if not isinstance(exc,Paused)),errors[0])

def _download(client,settings,mid,sid,part,completed,progress=None,stop_event=None):
    path=part_path(mid,sid,part['index']);path.parent.mkdir(parents=True,exist_ok=True)
    partial=path.with_suffix('.download');partial_meta=path.with_suffix('.download.json')
    previous=json.loads(partial_meta.read_text()) if partial_meta.exists() else {}
    offset=partial.stat().st_size if partial.exists() and previous.get('key')==part['key'] and previous.get('bytes')==part['bytes'] else 0
    if offset>part['bytes']:offset=0
    head=client.head_object(Bucket=settings['bucket'],Key=part['key'])
    if head['ContentLength']!=part['bytes']:raise ValueError('광각 원본 크기가 변경됐습니다. 녹화 목록을 다시 확인하세요.')
    etag=head['ETag']
    if previous.get('etag')!=etag:offset=0
    atomic(partial_meta,{'key':part['key'],'bytes':part['bytes'],'etag':etag})
    if progress:progress(offset)
    if offset<part['bytes']:
        if storage_policy.free_bytes(STORE)<part['bytes']-offset+RESERVE:raise ValueError('광각 다운로드를 위한 저장 공간이 부족합니다. 확보한 파일은 유지됩니다.')
        response=client.get_object(Bucket=settings['bucket'],Key=part['key'],IfMatch=etag,Range=f'bytes={offset}-')
        body=response['Body'];started=time.monotonic();received=0;last_update=0.
        cap=max(1.,min(50.,float(settings.get('downloadMiBPerSecond',8))))*1024**2
        try:
            with partial.open('ab' if offset else 'wb') as dest:
                while True:
                    check_pause(mid)
                    if stop_event and stop_event.is_set():raise Paused()
                    chunk=body.read(512*1024)
                    if not chunk:break
                    if offset+received+len(chunk)>part['bytes']:raise ValueError('광각 원본 전송 크기를 확인하세요.')
                    dest.write(chunk);received+=len(chunk)
                    elapsed=time.monotonic()-started
                    if elapsed-last_update>1:
                        if storage_policy.free_bytes(STORE)<RESERVE:raise ValueError('광각 저장 공간이 부족합니다. 확보한 부분은 유지됩니다.')
                        if progress:progress(offset+received)
                        else:update(mid,receivedBytes=completed+offset+received,activePartBytes=offset+received)
                        last_update=elapsed
                    wait=received/cap-elapsed
                    if wait>0:time.sleep(min(wait,.5))
                dest.flush();os.fsync(dest.fileno())
        finally:body.close()
    if not partial.exists() or partial.stat().st_size!=part['bytes']:raise RuntimeError('다운로드가 완료되지 않았습니다.')
    with partial.open('rb') as src:sha=hashlib.file_digest(src,'sha256').hexdigest()
    partial.replace(path)
    atomic(path.with_suffix('.json'),{'key':part['key'],'bytes':part['bytes'],'etag':etag,'sha256':sha,'mtimeNs':path.stat().st_mtime_ns,
        'matchId':mid,'sessionId':sid,'partIndex':part['index'],'sourceStartSeconds':part['start_seconds'],'preparedAt':now()})
    partial_meta.unlink(missing_ok=True)

def media_file(mid,sid,index):
    if type(index)!=int or index<0:raise ValueError('광각 원본 구간을 확인하세요.')
    row=next((r for r in read(mid).get('recordings',[]) if r['session_id']==fpc_sources.match_id(sid)),None)
    part=next((p for p in row['parts'] if p['index']==index),None) if row else None
    if not part or not cache_info(mid,sid,part):raise ValueError('준비가 완료된 광각 구간만 재생할 수 있습니다.')
    return part_path(mid,sid,index)
