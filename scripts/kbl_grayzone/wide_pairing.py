"""Manual, source-bound frame pairs available before any model inference.

Recording/entry times only propose playback intervals. An operator confirms an
instant, never a constant offset for an entire replay or slow-motion sequence.
"""
import hashlib,json,re,threading,uuid
from pathlib import Path
import cv2
from job_store import atomic,digest,now,lease
LOCK=threading.RLock()

def context(data,eid):
    import case_store,match_library
    event=next((e for e in data['events'] if e['id']==eid),None)
    if event is None:raise ValueError('판독 장면을 확인하세요.')
    case=case_store.load_case(data['linkedCaseId']) if data.get('linkedCaseId') else {}
    mid=match_library.get(data['libraryMatchId']).get('fpcMatchId') if data.get('libraryMatchId') else None
    return event,case,mid or case.get('fpcMatchId')

def sources(data,eid):
    import wide_preparation,wide_reference,case_store,storage_policy
    from wide_search import window,timestamp
    event,case,mid=context(data,eid);rows=[]
    if case:
        root=case_store.CASES[case['id']];ref=wide_reference.manifest(root)['events'].get(eid,{})
        path=Path(ref.get('clipPath',''))
        if ref.get('clipPath') and path.is_file() and storage_policy.allowed_wide_clip(path):
            rows.append({'id':'reference-clip','label':'이 장면의 기존 광각 클립','path':str(path),
                'suggestedSeconds':ref.get('candidateSeconds',0),'basis':'기존 참고 시점 · 동시점 직접 확인'})
    if mid:
        state=wide_preparation.read(mid)
        for rec in state.get('recordings',[]):
            bounds=window(rec,event);stamp=timestamp(rec.get('created_at'));label=stamp.strftime('%m/%d %H:%M') if stamp else '확보 원본'
            for p in rec['parts']:
                cached=wide_preparation.cache_info(mid,rec['session_id'],p)
                if not cached:continue
                start=p['start_seconds'];candidate=bool(bounds and start+p['duration']>=bounds[0] and start<=bounds[1])
                rows.append({'id':f'prepared-{rec["session_id"]}-{p["index"]}',
                    'label':f'{label} · {int(start)//60}:{int(start)%60:02d}부터',
                    'matchId':mid,'sessionId':rec['session_id'],'part':p['index'],'startSeconds':start,'duration':p['duration'],
                    'path':str(wide_preparation.part_path(mid,rec['session_id'],p['index'])),'sourceSha256':cached['sha256'],
                    'suggestedSeconds':max(0,bounds[0]-start) if candidate else 0,
                    'candidate':candidate,'basis':'기록 작성 시각 주변 · 동시점 직접 확인' if candidate else None})
    # API-relayed parts are scoped to this exact FPC match and intake. Their
    # local time begins at the selected file, not the recording's elapsed time;
    # do not infer neighboring files or automatic time alignment from them.
    intake=data.get('id','')
    if mid and re.fullmatch(r'[a-f0-9]{24}',str(intake)):
        root=case_store.ROOT.resolve();relay=root/'outputs'/'kbl-fpc-relay'/str(mid)/intake
        if relay.is_dir() and storage_policy.allowed_relay(relay):
            count=0
            for path in sorted(relay.glob('*/*.mp4')):
                if count>=128:break
                try:
                    session=str(uuid.UUID(path.parent.name))
                    match=re.fullmatch(r'(take-[0-9]{5,}-part-[0-9]{6,})-([a-f0-9]{64})\.mp4',path.name)
                    if not match or path.is_symlink() or path.parent.is_symlink() or not path.resolve().is_relative_to(relay.resolve()):continue
                    stat=path.stat()
                    if not 0<stat.st_size<=2*1024**3:continue
                    actual=match.group(2)
                    name=match.group(1)+'.mp4';source_id='relay-'+session+'-'+hashlib.sha256((name+actual).encode()).hexdigest()[:24]
                    rows.append({'id':source_id,'label':f'FPC 선택 조각 {name} · 조각 내 시간',
                        'path':str(path),'sourceSha256':actual,'suggestedSeconds':0,'candidate':False,'basis':None,
                        'relayOrigin':{'matchId':str(mid),'sessionId':session,'partName':name,'timing':'part-relative-unverified'}})
                    count+=1
                except (OSError,ValueError,OverflowError):continue
    return rows

def source(data,eid,sid):
    row=next((r for r in sources(data,eid) if r['id']==sid),None)
    if row is None:raise ValueError('이 경기에서 확보한 광각 구간을 선택하세요. FPC 준비 상태를 새로고침할 수 있습니다.')
    return row

def file(key,eid,sid):
    import review_intake
    return Path(source(review_intake.load(key),eid,sid)['path'])

def info(data,eid,sid):
    import review_intake
    row=source(data,eid,sid);path=Path(row['path']);stat=path.stat()
    if row.get('relayOrigin'):
        with path.open('rb') as stream: actual=hashlib.file_digest(stream,'sha256').hexdigest()
        if actual!=row['sourceSha256']:raise ValueError('광각 원본이 변경됐습니다. 해당 구간을 다시 확보하세요.')
    key=digest([str(path),stat.st_size,stat.st_mtime_ns]);cache=review_intake.folder(data['id'])/'wide-probes'/f'{key}.json'
    with LOCK:
        if cache.exists():meta=json.loads(cache.read_text())
        else:
            cv2.setNumThreads(1)
            cap=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
            fps=cap.get(cv2.CAP_PROP_FPS);frames=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));w=round(cap.get(cv2.CAP_PROP_FRAME_WIDTH));h=round(cap.get(cv2.CAP_PROP_FRAME_HEIGHT));cap.release()
            if not 1<=fps<=120 or frames<1:raise ValueError('광각 영상 정보를 읽지 못했습니다.')
            sha=row.get('sourceSha256')
            if not sha:
                with path.open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
            meta={'fps':fps,'frames':frames,'width':w,'height':h,'sourceSha256':sha};atomic(cache,meta)
    return {k:v for k,v in row.items() if k!='path'}|meta|{'url':f'/api/intake/{data["id"]}/wide/{eid}/media/{sid}.mp4'}

def view(key,eid):
    import review_intake
    data=review_intake.load(key);event,_,mid=context(data,eid);rows=sources(data,eid)
    selected=(event.get('selection') or {}).get('widePair');candidates=[r for r in rows if r.get('basis')]
    # Three playback entry points distributed across the bounded search interval.
    if len(candidates)>3:candidates=[candidates[i] for i in (0,len(candidates)//2,len(candidates)-1)]
    return {'matchId':mid,'sources':[{k:v for k,v in r.items() if k not in ('path','sourceSha256')} for r in rows],
        'candidates':[{'sourceId':r['id'],'seconds':r['suggestedSeconds'],'basis':r['basis']} for r in candidates],
        'selection':selected,'wideChoice':(event.get('selection') or {}).get('wideChoice','pending'),
        'message':'후보 구간은 기록 시각으로 좁혔습니다. 공·선수 동작을 비교해 같은 순간을 확정하세요.' if candidates else '광각 구간을 골라 같은 동작을 찾으세요. 시계를 읽지 못해도 직접 연결할 수 있습니다.' if rows else '확보된 광각 구간이 없습니다. 위의 FPC 광각 준비에서 경기 연결·다운로드를 확인하세요.'}

def clean(data,eid,item,index,payload):
    choice=payload.get('wideChoice','pending');pair=payload.get('widePair')
    if choice not in ('paired','skip','pending'):raise ValueError('광각 연결 방식을 확인하세요.')
    if choice!='paired':
        if pair is not None:raise ValueError('광각 연결 선택과 프레임이 다릅니다.')
        return {'wideChoice':choice,'widePair':None}
    if not isinstance(pair,dict) or pair.get('confirmed') is not True:raise ValueError('중계와 광각이 같은 순간인지 확인하세요.')
    meta=info(data,eid,pair.get('sourceId'));f=pair.get('frameIndex')
    if type(f)!=int or not 0<=f<meta['frames']:raise ValueError('광각 프레임 범위를 확인하세요.')
    if pair.get('sourceSha256')!=meta['sourceSha256']:raise RuntimeError('광각 원본이 바뀌었습니다. 다시 선택하세요.')
    if pair.get('broadcastFrame')!=index or pair.get('broadcastSha256')!=item['sha256']:raise ValueError('중계 프레임이 바뀌었습니다. 두 화면의 같은 순간을 다시 확인하세요.')
    out={k:meta[k] for k in ('sourceSha256','fps','frames','width','height')}
    out.update(sourceId=meta['id'],frameIndex=f,broadcastFrame=index,broadcastSha256=item['sha256'],method='operator-frame-pair',scope='selected-instant',confirmedAt=now())
    for k in ('matchId','sessionId','part','startSeconds'):
        if k in meta:out[k]=meta[k]
    if meta.get('relayOrigin'):out['relayOrigin']=meta['relayOrigin']
    out['revision']=digest({k:v for k,v in out.items() if k!='confirmedAt'})[:16]
    return {'wideChoice':choice,'widePair':out}

def active(event):
    pair=event.get('broadcastSelection',{}).get('widePair')
    if pair and pair['broadcastFrame']==event.get('selectedBroadcastFrame') and pair['broadcastSha256']==event['broadcast']['sha256']:return pair
    return None

def export(data,case):
    """Save one exact wide frame as report evidence; never touch delivered PDFs."""
    import case_store,wide_reference
    root=case_store.CASES[case['id']]
    with lease(root/'wide-reference.lock') as acquired:
        if not acquired:raise RuntimeError('광각 참고 화면 저장 중입니다. 잠시 후 다시 연결하세요.')
        refs=wide_reference.manifest(root);changed=False
        for event in case['events']:
            pair=active(event);old=refs['events'].get(event['id'],{})
            if not pair:
                if old.get('pairRevision') or (old and event.get('broadcastSelection',{}).get('wideChoice')=='skip'):
                    refs['events'].pop(event['id']);changed=True
                continue
            if old.get('pairRevision')==pair['revision']:continue
            row=source(data,event['id'],pair['sourceId']);meta=info(data,event['id'],pair['sourceId'])
            if meta['sourceSha256']!=pair['sourceSha256']:raise RuntimeError('저장한 광각 원본이 변경됐습니다. 다시 확인하세요.')
            cv2.setNumThreads(1);cap=cv2.VideoCapture(row['path'],cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
            try:
                cap.set(cv2.CAP_PROP_POS_FRAMES,pair['frameIndex']);ok,im=cap.read();decoded=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1
            finally:cap.release()
            if not ok or decoded!=pair['frameIndex']:raise RuntimeError('선택한 광각 프레임을 읽지 못했습니다.')
            raw=cv2.imencode('.jpg',im,[cv2.IMWRITE_JPEG_QUALITY,94])[1].tobytes();sha=hashlib.sha256(raw).hexdigest()
            name=f'wide-reference-images/{event["id"]}-{sha[:16]}.jpg';(root/name).parent.mkdir(parents=True,exist_ok=True);(root/name).write_bytes(raw)
            refs['events'][event['id']]={'image':name,'imageSha256':sha,'broadcastSha256':pair['broadcastSha256'],'broadcastFrame':pair['broadcastFrame'],
                'clipPath':row['path'],'clipSha256':pair['sourceSha256'],'candidateSeconds':pair['frameIndex']/pair['fps'],
                'source':pair,'pairRevision':pair['revision'],'savedAt':now()};changed=True
        if changed:
            atomic(root/'wide-reference-history'/f'{digest(wide_reference.manifest(root))[:16]}.json',wide_reference.manifest(root))
            atomic(root/'wide-references.json',refs)
