"""Local video + CSV intake with explicit candidate confirmation and provenance.

OCR suggestions are not incident-contact detection. Known assets may reuse prior
alignment only after full file hashes and fixture identity match.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
import copy,hashlib,json,math,os,re,shutil,subprocess,threading,time,uuid,unicodedata
import cv2
from case_intake import parse_csv
import case_store
import storage_policy
from job_store import atomic,lease,busy,now,RecoverableJobError
ROOT=Path(__file__).resolve().parents[2]
STORE=ROOT/'outputs/kbl-intake'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='intake')
LOCK=threading.RLock()
ACTIVE={}
MATCHING={}
OCR=ROOT/'runtime/kbl-clock-ocr'
MAX_TOTAL=30*1024**3

def write(path,data):
    atomic(path,data)

def folder(key):
    if not re.fullmatch(r'[a-f0-9]{24}',key):raise ValueError('접수 ID를 확인하세요.')
    return STORE/key

def load(key):return json.loads((folder(key)/'intake.json').read_text())
def linked_records(data):
    """A case is the current factual source; the uploaded CSV remains untouched."""
    if data.get('linkedCaseId'):
        import case_records
        case=case_store.load_case(data['linkedCaseId'])
        if case.get('events') and data.get('events'):case_records.project_intake(data,case)
        return case
    return None

def selected_packet(case_id,event,selection):
    if not selection or selection.get('sourceSha256')!=event['broadcast']['sha256']:return None,None
    index=selection['frameIndex']
    if index!=case_store.broadcast_index(event,event['broadcast']['fps']):return None,None
    current=event.get('broadcastSelection',{})
    if (selection.get('widePair') or {}).get('revision')!=(current.get('widePair') or {}).get('revision') or selection.get('wideChoice','pending')!=current.get('wideChoice','pending'):return None,None
    packet=case_store.broadcast_packet(case_id,event['id'])
    frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    return packet,frame

def preparation(data,case):
    import broadcast_pose
    results=[];issues=[];all_frames=True
    by_id={e['id']:e for e in case['events']}
    for e in data['events']:
        try:
            packet,frame=selected_packet(data['linkedCaseId'],by_id[e['id']],e.get('selection'))
            if frame is None:all_frames=False;continue
            court_ready=bool(frame.get('court',{}).get('imageToCourt'))
            row={'eventId':e['id'],'frameIndex':frame['frameIndex'],'people':len(frame['boxes']),
                 'floorPeople':len(frame.get('floorPositions',[])),
                 'refereeCandidates':sum(b.get('roleHint')=='referee' for b in frame['boxes']),
                 'spatialReady':court_ready,'posedPeople':None,'poseStatus':'awaiting-object-review'}
            if packet.get('wideAssistance'):row['wideAssistance']=packet['wideAssistance']
            try:pose=broadcast_pose.current(data['linkedCaseId'],e['id'])
            except (ValueError,RuntimeError,OSError,StopIteration,KeyError):pose=None
            if pose:
                row.update(poseJobId=pose['jobId'],poseStatus=pose['job']['state'])
                if pose['job']['state']=='complete':row.update(posedPeople=len(pose['job']['result']['people']),poseSeconds=pose['job'].get('totalSeconds'))
            results.append(row)
            if not court_ready:issues.append({'eventId':e['id'],'frameIndex':frame['frameIndex'],'kind':'court-calibration','error':'코트 좌표 보정이 필요합니다. 객체 검수는 진행할 수 있습니다.'})
        except (ValueError,RuntimeError,OSError,StopIteration,KeyError):all_frames=False
    total=len(data['events']);objects_ready=bool(total and all_frames and len(results)==total)
    pose_ready=objects_ready and all(r['poseStatus']=='complete' for r in results)
    return {'state':'needs-review' if objects_ready and issues else 'complete' if objects_ready else 'pending',
        'stage':f'현재 객체 후보 {len(results)}/{total} 준비'+(' · 코트 보정 확인 필요' if issues else ' · 관절 준비 완료' if pose_ready else ' · 관절은 객체 검수 후 계산'),
        'completed':len(results),'processed':len(results),'total':total,'results':results,'issues':issues,
        'objectsReady':objects_ready,'poseReady':pose_ready,'next':links(data['linkedCaseId'])}

def public(data):
    data=json.loads(json.dumps(data));data['revision']=data.get('revision',0)
    if data.get('status')=='matching' and (data['id'] not in MATCHING or MATCHING[data['id']].done()) and not busy(folder(data['id'])/'matching.lock'):
        latest=load(data['id'])
        if latest.get('status')!='matching':data=latest
        else:data.update(status='failed',error='영상 후보 탐색이 중단됐습니다. 업로드 원본은 보관되어 있습니다.')
    if data.get('status')=='failed' and data.get('media') and not data.get('linkedCaseId'):
        data['matchingResumeAvailable']=all(m.get('received')==m.get('size') for m in data['media']) and not any(e.get('selection') for e in data.get('events',[]))
    for media in data['media']:media.pop('localPath',None)
    if data.get('events') and data.get('media'):data['mediaProposals']=media_proposals(data)
    case=linked_records(data) if data.get('linkedCaseId') in case_store.CASES else None
    if not case and data.get('case',{}).get('events'):
        import case_records
        data['recordsVersion']=case_records.version(data['case'])
    job=data.get('processing')
    if job and job['state'] in ('queued','running') and (data['id'] not in ACTIVE or ACTIVE[data['id']].done()) and not busy(folder(data['id'])/'processing.lock'):
        job.update(state='interrupted',resumeAvailable=True,error='서버 연결이 중단됐습니다. 이어받기를 누르면 완료 결과와 T4 작업을 다시 연결합니다.')
    if case:
        import report_versions
        saved_reports=report_versions.index(data['linkedCaseId'])
        data['delivery']={k:saved_reports.get(k) for k in ('publishedVersion','publishedAt','firstPublishedAt')}
    data['objectsReady']=False
    if case and data.get('status')=='selected':
        current=preparation(data,case);data['preparation']=current
        data['objectsReady']=current['objectsReady'];data['poseReady']=current['poseReady']
        if job and job['state'] in ('complete','needs-review'):
            data['processingExecution']=copy.deepcopy(job)
            data['processing']={**job,**current} if current['objectsReady'] else {**job,'state':'needs-review','stage':'변경한 장면의 객체 후보를 다시 준비하세요.','issues':current['issues']}
    return data

def correct_record(key,payload):
    import case_records
    with LOCK:
        data=load(key);event_id=payload.get('eventId');case_id=data.get('linkedCaseId')
        if case_id:
            case_records.save(case_id,event_id,payload)
        else:
            if payload.get('version')!=case_records.version(data['case']):raise RuntimeError('기록이 변경됐습니다. 다시 불러오세요.')
            event=next((e for e in data['events'] if e['id']==event_id),None)
            if not event:raise ValueError('판독 장면을 확인하세요.')
            reason=payload.get('reason','').strip()
            if not reason or len(reason)>300:raise ValueError('정정 근거를 300자 이내로 남겨 주세요.')
            clean=case_records.clean_fields(event,payload.get('fields'))
            event.setdefault('sourceRecord',case_records.facts(event))
            data.setdefault('recordHistory',[]).append({'eventId':event_id,'before':case_records.facts(event),'fields':clean,'reason':reason,'savedAt':now()})
            event.update(clean)
            next(e for e in data['case']['events'] if e['id']==event_id).update(clean)
            write(folder(key)/'intake.json',data)
        return public(load(key))

def latest(case_id):
    if case_id not in case_store.CASES:raise ValueError('등록된 경기를 확인하세요.')
    for p in sorted(STORE.glob('*/intake.json'),key=lambda p:p.stat().st_mtime,reverse=True):
        d=json.loads(p.read_text())
        if d.get('linkedCaseId')==case_id:return {'id':d['id']}
    return {'id':None}

def create(payload):
    text=payload.get('csvText','')
    if not isinstance(text,str) or not 0<len(text.encode())<=256000:raise ValueError('CSV 파일을 확인하세요.')
    case=parse_csv(text.encode());items=payload.get('media',[])
    match_id=payload.get('libraryMatchId')
    if match_id:
        import match_library
        match_library.validate_fixture(match_library.get(match_id),case)
    if not isinstance(items,list) or not 1<=len(items)<=10:raise ValueError('중계 영상 1~10개를 선택하세요.')
    total=0;media=[]
    for i,item in enumerate(items):
        name=item.get('name','');size=item.get('size')
        if not isinstance(name,str) or len(name)>250 or Path(name).suffix.lower() not in ('.mp4','.mov','.m4v'):raise ValueError('MP4 또는 MOV 영상을 선택하세요.')
        if type(size)!=int or not 0<size<=MAX_TOTAL:raise ValueError('영상 크기를 확인하세요.')
        total+=size;media.append(dict(id=str(i),name=Path(name).name,size=size,received=0,status='awaiting-upload',uploadChunks=[]))
    if total>MAX_TOTAL or total+2*1024**3>storage_policy.free_bytes(STORE):raise ValueError('저장 공간이 부족합니다. 총 30GB 이하, 여유 공간 2GB 이상이 필요합니다.')
    key=uuid.uuid4().hex[:24];root=folder(key);root.mkdir(parents=True)
    mode=payload.get('candidateMode','auto')
    if mode not in ('auto','manual'):raise ValueError('자동 후보 탐색 또는 직접 선택을 지정하세요.')
    data=dict(id=key,revision=0,status='uploading',receivedAt=datetime.now(timezone.utc).isoformat(),case=case,media=media,events=[],warnings=[],candidateMode=mode,strictTracking=payload.get('strictTracking') is True)
    if match_id:data['libraryMatchId']=match_id
    if payload.get('fixtureDateBasis') in ('fpc-metadata','operator-confirmed'):data['fixtureDateBasis']=payload['fixtureDateBasis']
    if 'referees' in payload:
        import referee_roster
        selected=referee_roster.clean(payload['referees'])
        if selected:data['referees']=selected
        elif case.get('referees'):data['referees']=copy.deepcopy(case['referees'])
        else:data['referees']=selected
    elif case.get('referees'):
        data['referees']=copy.deepcopy(case['referees'])
    (root/'reviews.csv').write_text(text);write(root/'intake.json',data);return public(data)

def create_for_authorized_fpc(payload):
    """Create an intake bound to the match already authorized by the FPC API."""
    if not isinstance(payload,dict):raise ValueError('접수 요청을 확인하세요.')
    text=payload.get('csvText')
    if not isinstance(text,str) or not 0<len(text.encode())<=256000:raise ValueError('CSV 파일을 확인하세요.')
    fixture=parse_csv(text.encode())
    if payload.get('expectedDate') and payload['expectedDate']!=fixture.get('date'):
        raise ValueError('선택한 FPC 경기와 CSV의 경기일이 일치하지 않습니다.')
    import match_library
    row=match_library.ensure_authorized_fpc(payload.get('fpcMatchId'),fixture,payload.get('home'),payload.get('away'))
    safe={k:payload[k] for k in ('csvText','media','candidateMode','referees') if k in payload}
    safe['libraryMatchId']=row['id'];safe['strictTracking']=True
    safe['fixtureDateBasis']='fpc-metadata' if payload.get('expectedDate') else 'operator-confirmed'
    return create(safe)

def upload(key,slot,offset,stream,size):
    if not isinstance(slot,str) or not re.fullmatch(r'\d+',slot):raise ValueError('영상 번호를 확인하세요.')
    with LOCK,lease(folder(key)/'upload.lock') as acquired:
        if not acquired:raise RuntimeError('다른 영상 전송을 저장 중입니다. 잠시 후 이어서 올리세요.')
        data=load(key)
        if data['status']!='uploading':raise RuntimeError('이미 등록이 완료된 영상입니다.')
        item=next((x for x in data['media'] if x['id']==slot),None)
        if item is None:raise ValueError('영상 번호를 확인하세요.')
        if offset!=item['received']:raise RuntimeError('업로드 위치가 다릅니다. 다시 등록하세요.')
        if not 0<size<=8*1024**2 or offset+size>item['size']:raise ValueError('업로드 청크 범위를 확인하세요.')
        if storage_policy.free_bytes(STORE)<size+2*1024**3:raise ValueError('외장 저장 공간이 부족합니다. 여유 공간을 확보한 뒤 이어서 올려 주세요.')
        path=folder(key)/f'media-{slot}.mp4'
        if path.exists():
            current=path.stat().st_size
            if current<offset:raise RuntimeError('저장된 영상이 접수 기록보다 짧습니다. 원본을 확인하세요.')
            if current>offset:
                with path.open('r+b') as f:f.truncate(offset)
        elif offset:raise RuntimeError('저장된 영상이 없습니다. 원본을 확인하세요.')
        digest=hashlib.sha256()
        with path.open('ab') as out:
            remaining=size
            try:
                while remaining:
                    chunk=stream.read(min(remaining,1024*1024))
                    if not chunk:raise ValueError('영상 전송이 중단되었습니다.')
                    out.write(chunk);digest.update(chunk);remaining-=len(chunk)
                out.flush();os.fsync(out.fileno())
            except Exception:
                out.truncate(offset);raise
        if isinstance(item.get('uploadChunks'),list):item['uploadChunks'].append({'offset':offset,'size':size,'sha256':digest.hexdigest()})
        item['received']+=size;item['status']='uploaded' if item['received']==item['size'] else 'uploading'
        write(folder(key)/'intake.json',data);return {'received':item['received']}

def probe(path):
    cap=cv2.VideoCapture(str(path));fps=cap.get(cv2.CAP_PROP_FPS);frames=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));ok,image=cap.read();cap.release()
    if not ok or not math.isfinite(fps) or not 1<=fps<=120 or frames<1:raise ValueError('읽을 수 없는 영상입니다.')
    return dict(fps=fps,frames=frames,width=image.shape[1],height=image.shape[0],duration=frames/fps)

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda:f.read(1024**2),b''):h.update(part)
    return h.hexdigest()

def media_path(key,slot):
    data=load(key);item=next(m for m in data['media'] if m['id']==slot)
    path=Path(item['localPath']) if item.get('localPath') else folder(key)/f'media-{slot}.mp4'
    if item.get('localPath') and data.get('storageMigration') and not path.is_file():raise ValueError('외장 저장소의 원본 영상을 찾을 수 없습니다. 저장 장치를 다시 연결하세요.')
    return path

def demo():
    raise ValueError('웹에서는 로컬 예시 경기를 사용할 수 없습니다.')

def _matching_worker(key,guard):
    try:analyse(key)
    finally:guard.__exit__(None,None,None)

def _start_matching(key,guard=None):
    if guard is None:
        guard=lease(folder(key)/'matching.lock');acquired=guard.__enter__()
        if not acquired:
            guard.__exit__(None,None,None);raise RuntimeError('이 경기의 영상 후보 탐색이 이미 진행 중입니다.')
    try:MATCHING[key]=POOL.submit(_matching_worker,key,guard)
    except Exception:
        guard.__exit__(None,None,None);raise

def finalize(key):
    with LOCK,lease(folder(key)/'upload.lock') as acquired:
        if not acquired:raise RuntimeError('영상 전송이 끝난 뒤 등록을 완료하세요.')
        data=load(key)
        if data['status']!='uploading' or any(m['received']!=m['size'] for m in data['media']):raise ValueError('영상 업로드를 먼저 완료하세요.')
        data.update(status='matching',uploadCompletedAt=datetime.now(timezone.utc).isoformat(),slaStart='upload-completed',slaMinutes=90);write(folder(key)/'intake.json',data);_start_matching(key);return public(data)

def resume_matching(key):
    """Resume an interrupted candidate scan without re-uploading source media."""
    with LOCK,lease(folder(key)/'upload.lock') as acquired:
        if not acquired:raise RuntimeError('영상 전송이 끝난 뒤 다시 시도하세요.')
        data=load(key)
        if key in MATCHING and not MATCHING[key].done():return public(data)
        guard=lease(folder(key)/'matching.lock');held=guard.__enter__()
        if not held:
            guard.__exit__(None,None,None);return public(data)
        transferred=False
        try:
            if data.get('status') not in ('matching','failed') or data.get('linkedCaseId') or any(e.get('selection') for e in data.get('events',[])):
                raise RuntimeError('현재 접수 상태에서는 후보 탐색을 다시 시작할 수 없습니다.')
            media=data.get('media',[])
            if not media or any(m.get('received')!=m.get('size') for m in media):raise ValueError('영상 업로드가 모두 완료돼야 이어서 처리할 수 있습니다.')
            for m in media:
                path=media_path(key,m['id'])
                if not path.is_file() or path.stat().st_size!=m['size']:raise ValueError('저장된 영상의 크기가 다릅니다. 원본을 확인하세요.')
                with path.open('rb') as stream:
                    offset=0
                    for chunk in m.get('uploadChunks',[]):
                        if chunk.get('offset')!=offset or type(chunk.get('size')) is not int or chunk['size']<=0:raise ValueError('업로드 검증 기록을 확인하세요.')
                        remaining=chunk['size'];h=hashlib.sha256()
                        while remaining:
                            block=stream.read(min(remaining,1024*1024))
                            if not block:raise ValueError('저장된 영상이 완전하지 않습니다.')
                            h.update(block);remaining-=len(block)
                        if h.hexdigest()!=chunk.get('sha256'):raise ValueError('저장된 영상의 해시가 다릅니다. 원본을 확인하세요.')
                        offset+=chunk['size']
                    if offset!=m['size']:raise ValueError('업로드 검증 기록이 완전하지 않습니다.')
            previous=copy.deepcopy(data);archive=folder(key)/'matching-history';archive.mkdir(exist_ok=True)
            write(archive/(uuid.uuid4().hex+'.json'),previous)
            data.update(status='matching',events=[],warnings=[],matchingResumedAt=now())
            data.pop('error',None);write(folder(key)/'intake.json',data)
            _start_matching(key,guard);transferred=True
            return public(data)
        finally:
            if not transferred:
                try:guard.__exit__(None,None,None)
                except RuntimeError:pass

def clock_matches(text):
    quarters=re.findall(r'\b([1-4])\s*(?:Q|ST|ND|RD|TH)\b|\bQ\s*([1-4])\b',text.upper())
    quarters={int(a or b) for a,b in quarters};clocks=[]
    for m in re.finditer(r'(?<!\d)(\d{1,2})\s*:\s*([0-5]\d(?:\.\d)?)',text):
        value=int(m[1])*60+float(m[2])
        if 0<=value<=600:clocks.append(value)
    return quarters,clocks

def clip_review_number(name):
    """Filename grouping is only a media hint, never a contact-frame selection."""
    match=re.search(r'(?:판독|review)\s*[-_ ]\s*(\d+)\b',unicodedata.normalize('NFC',name),re.I)
    return int(match[1]) if match else None

def matches_event_clock(event,text):
    seconds=event.get('gameClockSeconds')
    if seconds is None:return False
    quarters,clocks=clock_matches(text)
    return event['quarter'] in quarters and any(abs(c-seconds)<=1 for c in clocks)

def media_proposals(data):
    """Evidence-based suggestions only; filename order is never treated as proof."""
    items=data['media'];result={}
    for event in data['events']:
        if event.get('selection'):
            result[event['id']]={'mediaId':event['selection']['mediaId'],'basis':'확정된 프레임의 영상'};continue
        evidence={}
        def add(mid,reason):evidence.setdefault(mid,set()).add(reason)
        for item in items:
            if item.get('knownEvent')==event['id']:add(item['id'],'기존 검토 원본')
            if event.get('number') is not None and clip_review_number(item['name'])==event['number']:add(item['id'],'파일명 판독 번호')
        for c in event.get('candidates',[]):
            if c.get('basis')=='scoreboard-ocr':add(c['mediaId'],'쿼터·경기 시계 OCR')
            elif c.get('basis')=='clock-only-ocr':add(c['mediaId'],'경기 시계 OCR · 쿼터 확인 필요')
        if len(evidence)==1:
            mid=next(iter(evidence));result[event['id']]={'mediaId':mid,'basis':' · '.join(sorted(evidence[mid]))}
        elif len(evidence)>1:result[event['id']]={'mediaId':None,'basis':'여러 영상 후보 · 직접 확인', 'candidates':list(evidence)}
        elif len(items)==1:result[event['id']]={'mediaId':items[0]['id'],'basis':'영상 1개 · 해당 장면 확인 필요'}
        else:result[event['id']]={'mediaId':None,'basis':'일치 근거 없음 · 직접 지정'}
    return result

def assign_media(key,payload):
    with LOCK:
        data=load(key)
        if data['status'] not in ('awaiting-selection','selected'):raise RuntimeError('영상 준비가 끝난 뒤 연결하세요.')
        if key in ACTIVE and not ACTIVE[key].done():raise RuntimeError('재처리 중에는 영상 연결을 변경할 수 없습니다.')
        if payload.get('revision')!=data['revision']:raise RuntimeError('선택이 변경됐습니다. 다시 불러오세요.')
        assignments=payload.get('assignments');ids={e['id'] for e in data['events']};media_ids={m['id'] for m in data['media']}
        if not isinstance(assignments,dict) or set(assignments)!=ids or any(v not in media_ids for v in assignments.values()):raise ValueError('모든 판독 장면의 영상을 선택하세요.')
        for e in data['events']:
            selected=e.get('selection')
            if selected and selected['mediaId']!=assignments[e['id']]:raise ValueError(f"판독 {e['number']}은 이미 프레임이 확정됐습니다. 프레임 화면에서 영상을 바꿔 다시 확정하세요.")
        for e in data['events']:e['preferredMediaId']=assignments[e['id']]
        data['mediaAssignments']={'assignments':assignments.copy(),'confirmedAt':now()}
        data['revision']+=1;write(folder(key)/'intake.json',data)
        return public(data)

def scan_ocr(path,item,root):
    if not OCR.is_file():return []
    samples=root/f"ocr-{item['id']}";samples.mkdir(exist_ok=True);cap=cv2.VideoCapture(str(path));paths=[];indices={}
    # Long game scan: at most 1800 coarse samples. Suggestions still require review.
    step=max(1.,item['duration']/1800) if item['duration']>120 else .5
    for at in range(0,item['frames'],max(1,round(step*item['fps']))):
        cap.set(cv2.CAP_PROP_POS_FRAMES,at);ok,im=cap.read()
        if not ok:continue
        h,w=im.shape[:2]
        for name,crop in [('scoreboard',im[round(h*.82):,:]),('upper-clock',im[:round(h*.32),round(w*.52):])]:
            p=samples/f'{at:08d}-{name}.jpg';cv2.imwrite(str(p),crop);paths.append(str(p));indices[str(p)]=at
    cap.release();write(samples/'inputs.json',paths)
    try:
        subprocess.run([str(OCR),str(samples/'inputs.json'),str(samples/'text.json')],check=True,timeout=1800,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        grouped={}
        for r in json.loads((samples/'text.json').read_text()):grouped.setdefault(indices[r['file']],[]).append(r['text'])
    finally:
        # These crops are reproducible from the retained source video; the OCR
        # readings and chosen frame candidates remain in the intake record.
        for name in paths:
            try:Path(name).unlink(missing_ok=True)
            except OSError:pass
    return [{'frameIndex':i,'text':' '.join(parts)} for i,parts in sorted(grouped.items())]

def analyse(key):
    data=load(key);root=folder(key);started=time.monotonic()
    try:
        known=None
        same=bool(known) and all(str(data['case'].get(k,''))==str(known.get(k,'')) for k in ['gameNumber','date','home','away'])
        for item in data['media']:
            path=media_path(key,item['id']);item.update(probe(path))
            # The downstream registration and T4 pipeline currently require
            # native 1080p. Report that before the operator selects frames.
            if (item['width'],item['height'])!=(1920,1080):
                raise ValueError('현재 객체·관절 처리는 1920×1080 중계 영상이 필요합니다. 원본은 보존되며 해당 규격의 영상을 등록해 주세요.')
            if abs(item['fps']-30)>.01:
                data['warnings'].append(f"{item['name']}: 현재 판독 영상 생성기는 30fps만 지원합니다. 리포트 작업은 계속할 수 있습니다.")
            item['sha256']=digest(path);item['status']='ready'
            item['knownEvent']=next((e['id'] for e in (known['events'] if known else []) if same and e['broadcast']['sha256']==item['sha256']),None)
        for e in data['case']['events']:
            candidates=[]
            for item in data['media']:
                if item['knownEvent']==e['id']:
                    existing=next(x for x in known['events'] if x['id']==e['id'])
                    # Reuse the selected prior candidate; not a new automatic contact detector.
                    at=case_store.broadcast_index(existing,item['fps'])
                    candidates.append(dict(mediaId=item['id'],frameIndex=at,basis='existing-reviewed-candidate',label='기존 검토 후보 · 동일 원본',confidence=None))
            named=[m for m in data['media'] if clip_review_number(m['name'])==e['number']]
            data['events'].append({**e,'candidates':candidates,'selection':None,
                'preferredMediaId':named[0]['id'] if len(named)==1 else None})
            if e.get('gameClockSeconds') is None:data['warnings'].append(f"판독 {e['number']}: CSV 경기 시각이 비어 있습니다. 영상에서 시각과 기준 프레임을 직접 확인하세요.")
        write(root/'intake.json',data)
        for item in data['media']:
            if item['knownEvent'] or data.get('candidateMode')=='manual':continue
            readings=scan_ocr(media_path(key,item['id']),item,root)
            for e in data['events']:
                if e.get('gameClockSeconds') is None:continue
                found=[]
                for r in readings:
                    if matches_event_clock(e,r['text']):
                        if not found or r['frameIndex']-found[-1]['frameIndex']>2*item['fps']:
                            found.append(dict(mediaId=item['id'],frameIndex=r['frameIndex'],basis='scoreboard-ocr',label='쿼터·경기 시계 OCR 후보 ±1초',confidence=None))
                    else:
                        quarters,clocks=clock_matches(r['text'])
                        if not quarters and any(abs(c-e['gameClockSeconds'])<=1 for c in clocks) and (not found or r['frameIndex']-found[-1]['frameIndex']>2*item['fps']):
                            found.append(dict(mediaId=item['id'],frameIndex=r['frameIndex'],basis='clock-only-ocr',label='경기 시계 OCR 후보 · 쿼터 확인 필요',confidence=None))
                e['candidates'].extend(found[:8])
        data['status']='awaiting-selection';data['analysisSeconds']=time.monotonic()-started
        if any(not e['candidates'] for e in data['events']):data['warnings'].append('시계가 읽히지 않거나 반복 장면이 있으면 영상과 프레임을 직접 선택하세요. 후보는 접촉 순간을 확정하지 않습니다.')
        write(root/'intake.json',data)
    except Exception as exc:
        data['status']='failed';data['error']=str(exc)[:300];write(root/'intake.json',data)

def select(key,payload):
    with LOCK:
        data=load(key)
        if key in ACTIVE and not ACTIVE[key].done():raise RuntimeError('재처리 중입니다. 완료된 뒤 프레임을 변경하세요.')
        if data['status'] not in ('awaiting-selection','selected'):raise RuntimeError('영상 준비가 끝난 뒤 선택하세요.')
        if payload.get('revision')!=data['revision']:raise RuntimeError('선택이 변경됐습니다. 새로고침하세요.')
        e=next((e for e in data['events'] if e['id']==payload.get('eventId')),None)
        item=next((m for m in data['media'] if m['id']==payload.get('mediaId')),None);frame=payload.get('frameIndex');mode=payload.get('mode')
        if e is None or item is None or type(frame)!=int or not 0<=frame<item['frames'] or mode not in ('auto','manual'):raise ValueError('영상·프레임·선택 방식을 확인하세요.')
        if mode=='auto' and not any(c['mediaId']==item['id'] and c['frameIndex']==frame for c in e['candidates']):raise ValueError('자동 선택은 제안된 후보를 골라야 합니다.')
        seconds=payload.get('actionWindowSeconds',12)
        from action_window import window_frames
        window_frames(item['frames'],item['fps'],frame,seconds)
        moment=payload.get('analysisMoment',{})
        if not isinstance(moment,dict) or set(moment)-{'phase','clock','note'}:raise ValueError('기준 순간 설명을 확인하세요.')
        if moment.get('phase','unconfirmed') not in ('unconfirmed','before','contact','after','context'):raise ValueError('접촉 전·순간·직후 중에서 선택하세요.')
        if not isinstance(moment.get('note',''),str) or len(moment.get('note',''))>160:raise ValueError('선택 이유는 160자 이내로 입력하세요.')
        from case_intake import clock_seconds
        clock=moment.get('clock','')
        if not isinstance(clock,str):raise ValueError('화면 시계를 확인하세요.')
        if clock:clock_seconds(clock)
        moment={'phase':moment.get('phase','unconfirmed'),'clock':clock.strip(),'note':moment.get('note','').strip()}
        import wide_pairing
        pair_choice=wide_pairing.clean(data,e['id'],item,frame,payload)
        e['selection']=dict(actionWindowSeconds=seconds,mediaId=item['id'],frameIndex=frame,sourceSha256=item['sha256'],mode=mode,confirmedAt=datetime.now(timezone.utc).isoformat())
        e['selection']['analysisMoment']=moment
        e['selection'].update(pair_choice)
        if data.get('mediaAssignments'):
            data['mediaAssignments']['assignments'][e['id']]=item['id'];e['preferredMediaId']=item['id']
        data['revision']+=1;data['status']='selected' if all(x.get('selection') for x in data['events']) else 'awaiting-selection'
        data.pop('processing',None)
        data['linkedCaseId']=data.get('linkedCaseId')
        if data['linkedCaseId']:
            import uniforms
            uniforms.link_intake(key,data['linkedCaseId'])
        write(folder(key)/'intake.json',data);return public(data)

def handoff(key):
    """Start idempotent background work, or link the exact completed selections."""
    with LOCK:
        data=load(key)
        if data['status']!='selected':raise ValueError('모든 판독 프레임을 확정하세요.')
        if not data.get('linkedCaseId'):
            import case_registration
            data['linkedCaseId']=case_registration.register(data,media_path)
            write(folder(key)/'intake.json',data)
        case_id=data['linkedCaseId']
        if key in ACTIVE and not ACTIVE[key].done():return {'state':'processing','processing':data['processing']}
        if busy(folder(key)/'processing.lock'):return {'state':'processing','processing':data['processing']}
        if any(not f.done() for f in ACTIVE.values()):raise RuntimeError('다른 판독 자료를 재처리 중입니다. 완료 후 연결하세요.')
        case=linked_records(data)
        fields=('id','quarter','gameClock','recordedDecision','recordedReason','requestingTeam')
        if [{k:e.get(k) for k in fields} for e in data['events']] != [{k:e.get(k) for k in fields} for e in case['events']]:raise RuntimeError('CSV 판독 목록 또는 내용이 기존 분석과 다릅니다. 새 분석 작업으로 연결해야 합니다.')
        selections={e['id']:e['selection'] for e in data['events']}
        case=case_store.save_broadcast_selections(case_id,selections,case['revision'])
        import wide_pairing
        wide_pairing.export(data,case)
        if ready(case,case_id):return links(case_id)
        previous=data.get('processing',{});resume=previous.get('caseRevision')==case['revision']
        if previous:
            history=folder(key)/'processing-history';history.mkdir(exist_ok=True)
            write(history/(uuid.uuid4().hex[:12]+'.json'),previous)
        data['processing']={**(previous if resume else {}),'state':'queued','stage':'완료 결과 확인 · 남은 작업 이어받기',
            'caseRevision':case['revision'],'selectionRevision':data['revision'],'completed':previous.get('completed',0) if resume else 0,
            'total':len(data['events']),'results':previous.get('results',[]) if resume else [],
            'startedAt':previous.get('startedAt') if resume and previous.get('startedAt') else datetime.now(timezone.utc).isoformat(),
            'attemptStartedAt':datetime.now(timezone.utc).isoformat(),'resumeCount':previous.get('resumeCount',0)+int(resume)}
        data['processing'].pop('error',None)
        write(folder(key)/'intake.json',data)
        ACTIVE[key]=POOL.submit(process_selected,key,case['revision'])
        return {'state':'processing','processing':data['processing']}


def links(case_id):
    return {'state':'ready','caseId':case_id,'url':f'/reconstruction.html?id={case_id}','poseUrl':f'/pose-review.html?id={case_id}','reportUrl':f'/case-report/{case_id}.pdf'}


def ready(case,case_id):
    from action_window import window_frames
    try:
        for e in case['events']:
            packet=case_store.broadcast_packet(case_id,e['id']);index=case_store.broadcast_index(e,packet['fps'])
            if not any(f['frameIndex']==index for f in packet['frames']):return False
            import gpu_bridge,object_cache
            if gpu_bridge.enabled() or e.get('_trackingCachePolicy') is not None:
                object_cache.require_current(packet,object_cache.contract(gpu_bridge.config() if gpu_bridge.enabled() else {},e,index,ROOT))
            import wide_pairing,multiview
            if case.get('wideAssistance',{}).get('enabled') and wide_pairing.active(e) and not multiview.attempted(case_id,e['id'],index):return False
            seconds=e.get('broadcastSelection',{}).get('actionWindowSeconds')
            if seconds is not None:
                first,end=window_frames(round(e['broadcast']['durationSeconds']*packet['fps']),packet['fps'],index,seconds)
                coverage=packet.get('coverageSeconds',[index/packet['fps'],index/packet['fps']])
                if coverage[0]>first/packet['fps']+.001 or coverage[1]<end/packet['fps']-.001:return False
        return bool(case['events'])
    except (RuntimeError,ValueError,KeyError,OSError,StopIteration):return False


def process_selected(key,revision):
    with lease(folder(key)/'processing.lock') as acquired:
        if acquired:_process_selected(key,revision)

def _process_selected(key,revision):
    started=time.monotonic();results=[];issues=[];case_id=load(key)['linkedCaseId']
    def update(**values):
        with LOCK:
            data=load(key);data['processing'].update(values);write(folder(key)/'intake.json',data)
    def check():
        if case_store.load_case(case_id)['revision']!=revision:raise RuntimeError('다른 화면에서 기준 프레임이 변경됐습니다. 현재 선택을 확인하고 다시 시작하세요.')
    try:
        import broadcast_frame_processing
        data=load(key)
        for n,e in enumerate(data['events'],1):
            check();index=e['selection']['frameIndex']
            def stage(message):
                ticket=case_store.CASES[case_id]/'gpu-jobs'/f'{e["id"]}-f{index}'/'transport.json'
                progress=json.loads(ticket.read_text()).get('progress') if ticket.is_file() else None
                update(currentProgress=progress,state='running',stage=f"판독 {n}/{len(data['events'])} · F{index} · {message}")
            try:
                row=broadcast_frame_processing.prepare(case_id,e['id'],index,stage)
            except broadcast_frame_processing.CourtCalibrationRequired as exc:
                check()
                issues.append({'eventId':e['id'],'frameIndex':index,'kind':'court-calibration','error':str(exc)[:300]})
                packet=case_store.broadcast_packet(case_id,e['id']);frame=next(f for f in packet['frames'] if f['frameIndex']==index)
                row={'frameIndex':index,'people':len(frame['boxes']),'refereeCandidates':sum(b.get('roleHint')=='referee' for b in frame['boxes']),
                     'reusedExactFrame':True,'spatialReady':False,'courtCalibrationRequired':True}
                update(issues=issues,stage=f"판독 {n}/{len(data['events'])} · 코트 보정 대기 · 객체 검수는 진행 가능")
            check()
            import multiview
            try:
                wide=multiview.prepare(case_id,e['id'],index,stage)
                row['wideAssistance']={k:wide.get(k) for k in ('state','message','addedPeople','filledPositions','seconds')}
            except RecoverableJobError:
                raise
            except (ValueError,RuntimeError,OSError) as exc:
                # Secondary failures never discard primary detections. Surface
                # their status instead of silently claiming two-camera coverage.
                row['wideAssistance']={'state':'failed','message':'광각 자동 보완 중단 · 중계 결과 유지','error':type(exc).__name__}
                multiview.failure(case_id,e['id'],index)
            results.append({'eventId':e['id'],**row,'posedPeople':None,'poseStatus':'awaiting-object-review'})
            update(completed=len(results),processed=n,results=results,issues=issues)
        # Early clips may finish while the one background cache/index is still
        # running. Revisit pending assistance once, before the operator begins.
        for r in results:
            if r.get('wideAssistance',{}).get('state')!='source-pending':continue
            check()
            try:
                wide=multiview.prepare(case_id,r['eventId'],r['frameIndex'],lambda message:update(stage=message))
                r['wideAssistance']={k:wide.get(k) for k in ('state','message','addedPeople','filledPositions','seconds')}
            except RecoverableJobError:raise
            except (ValueError,RuntimeError,OSError):multiview.failure(case_id,r['eventId'],r['frameIndex'])
        wide_total=sum(r.get('wideAssistance',{}).get('state') not in (None,'disabled','unlinked','manual-only') for r in results)
        wide_ready=sum(r.get('wideAssistance',{}).get('state')=='ready' for r in results)
        wide_label=f' · 광각 보완 {wide_ready}/{wide_total}장면' if wide_total else ''
        check();update(state='needs-review' if issues else 'complete',results=results,
            stage=(f'객체 후보 {len(results)}/{len(data["events"])} 준비 · {len(issues)}개 장면 코트 보정 확인 필요' if issues else '객체 후보 준비 완료 · 객체 검수 후 관절 계산')+wide_label,
            issues=issues,seconds=round(time.monotonic()-started,2),next=links(case_id))
    except RecoverableJobError as exc:
        update(state='interrupted',stage=f'판독 {len(results)+1} 연결 복구 대기',error=str(exc)[:300],resumeAvailable=True,
               results=results,completed=len(results),issues=issues,seconds=round(time.monotonic()-started,2))
    except Exception as exc:
        update(state='failed',stage=f'판독 {len(results)+1} 처리 중단',error=str(exc)[:300],issues=issues,seconds=round(time.monotonic()-started,2))
