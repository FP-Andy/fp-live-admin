"""Operator-selected reference frames and missing referees; no inference."""
from pathlib import Path
import copy,hashlib,json,math,re
import cv2
import case_store
import storage_policy
from job_store import atomic,digest,lease,now

ROOT=Path(__file__).resolve().parents[2]

def context(key,eid):
    case=case_store.load_case(key);event=next(e for e in case['events'] if e['id']==eid)
    packet=case_store.broadcast_packet(key,eid,include_evidence=False)
    index=case_store.broadcast_index(event,packet['fps']);frame=next(f for f in packet['frames'] if f['frameIndex']==index)
    return case,event,packet,frame

def manifest(root):
    path=root/'wide-references.json'
    return json.loads(path.read_text()) if path.exists() else {'schema':'kbl-wide-reference/v2','events':{}}

def version(root):
    """Report-only reference changes must invalidate PDFs and evidence bundles."""
    path=Path(root)/'wide-references.json'
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

def selected(root,event,index):
    item=manifest(root)['events'].get(event['id'])
    if not item:return None
    if item.get('broadcastSha256')!=event['broadcast']['sha256']:raise RuntimeError('광각 참고의 중계 원본이 다릅니다. 다시 선택하세요.')
    if item.get('broadcastFrame') is not None:
        if item['broadcastFrame']!=index:raise RuntimeError('기준 프레임이 바뀌었습니다. 광각 참고 화면을 다시 선택하세요.')
    else:
        capture_id=item.get('captureId','')
        if not re.fullmatch(r'[a-f0-9]{24}',capture_id):raise RuntimeError('광각 참고 화면을 현재 프레임에 다시 연결하세요.')
        current=root/'reconstructions'/event['id']/capture_id/'scene.json'
        if not current.exists():current=root/'reconstructions'/event['id']/'current.json'
        if not current.exists():raise RuntimeError('광각 참고 화면을 현재 프레임에 다시 연결하세요.')
        capture=json.loads(current.read_text())
        if capture['frameIndex']!=index or capture['captureId']!=item.get('captureId'):raise RuntimeError('광각 참고 화면을 현재 프레임에 다시 연결하세요.')
    path=(root/item['image']).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():raise ValueError('광각 참고 이미지 경로를 확인하세요.')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=item['imageSha256']:raise RuntimeError('광각 참고 이미지가 변경됐습니다.')
    return item

def image_file(key,eid):
    _,event,_,frame=context(key,eid);item=selected(case_store.CASES[key],event,frame['frameIndex'])
    if not item:raise ValueError('광각 참고 화면을 먼저 선택하세요.')
    return case_store.CASES[key]/item['image']

def sources(key,eid):
    case,event,_,_=context(key,eid);root=case_store.CASES[key];rows=[]
    item=manifest(root)['events'].get(eid,{})
    clip=Path(item.get('clipPath',''))
    if item.get('clipPath') and clip.is_file() and storage_policy.allowed_wide_clip(clip):
        rows.append({'id':'reference-clip','label':'이 장면의 기존 광각 클립','url':f'/api/cases/{key}/events/{eid}/wide-source/reference-clip.mp4','suggestedSeconds':item.get('candidateSeconds',0)})
    if event.get('wide') and Path(event['wide']['file']).is_file():
        rows.append({'id':'case-wide','label':'연결된 광각 원본','url':f'/api/cases/{key}/events/{eid}/wide-source/case-wide.mp4','suggestedSeconds':(event.get('selectedFrame') or 0)/event['wide']['fps']})
    mid=case.get('fpcMatchId')
    if not mid:
        import match_library
        match=next((m for m in match_library.read()['matches'] if m.get('caseId')==key),{})
        mid=match.get('fpcMatchId')
    if mid:
        import wide_preparation
        prepared=wide_preparation.public(mid)
        for row in prepared['recordings']:
            for part in row['parts']:
                if part['cached']:
                    rows.append({'id':f'prepared-{row["session_id"]}-{part["index"]}',
                        'label':f'확보 원본 {int(part["start_seconds"])//60}:{int(part["start_seconds"])%60:02d}부터',
                        'url':part['url'],'matchId':mid,'sessionId':row['session_id'],'partIndex':part['index'],'suggestedSeconds':0})
    return rows

def source_file(key,eid,source_id):
    row=next((r for r in sources(key,eid) if r['id']==source_id),None)
    if not row:raise ValueError('이 경기에서 확보한 광각 원본을 선택하세요.')
    event=next(e for e in case_store.load_case(key)['events'] if e['id']==eid);root=case_store.CASES[key]
    if source_id=='reference-clip':return Path(manifest(root)['events'][eid]['clipPath'])
    if source_id=='case-wide':return Path(event['wide']['file'])
    import wide_preparation
    return wide_preparation.media_file(row['matchId'],row['sessionId'],row['partIndex'])

def view(key,eid):
    case,event,packet,frame=context(key,eid);root=case_store.CASES[key]
    try:item=selected(root,event,frame['frameIndex']);error=None
    except (ValueError,RuntimeError) as exc:item=None;error=str(exc)
    path=root/'scene-evidence.json';all_evidence=json.loads(path.read_text()) if path.exists() else {'events':{}}
    evidence=all_evidence['events'].get(eid,{})
    if evidence and any(evidence.get(k)!=v for k,v in {'broadcastFrame':frame['frameIndex'],'broadcastSha256':packet['inputSha256'],'datasetId':packet['datasetId']}.items()):evidence={};error='이전 광각 보완은 현재 객체 결과에 맞춰 다시 확인하세요.'
    if evidence.get('wideReference') and (not item or evidence['wideReference']['imageSha256']!=item['imageSha256']):evidence={};error='광각 참고 프레임이 바뀌었습니다. 보완 심판을 다시 지정하세요.'
    placed={p['id'] for p in frame.get('floorPositions',[]) if p['role']=='referee'}
    # Step3 can place a cropped broadcast referee without inventing a footpoint
    # in the image. Count that same person before offering a new wide referee.
    scene_path=root/'reconstructions'/eid/'current.json'
    if scene_path.is_file():
        saved=json.loads(scene_path.read_text())
        if saved.get('frameIndex')==frame['frameIndex'] and saved.get('datasetId')==packet['datasetId']:
            image_refs={b['id']:b for b in frame.get('boxes',[]) if b.get('roleHint')=='referee'}
            placed.update(e['id'] for e in saved.get('state',{}).get('entities',[]) if e['id'] in image_refs and e.get('positionSource')=='manual' and (not image_refs[e['id']].get('spatialExcluded') or e.get('spatialOverride') is True))
    return {'version':digest({'reference':manifest(root)['events'].get(eid),'evidence':all_evidence['events'].get(eid),'frame':frame['frameIndex'],'dataset':packet['datasetId']}),
        'frameIndex':frame['frameIndex'],'error':error,'referees':case.get('referees',[]),
        'broadcastUnplacedReferees':[b['id'] for b in frame.get('boxes',[]) if b.get('roleHint')=='referee' and b['id'] not in placed],
        'broadcastRefereeCount':len(placed),
        'reference':{'image':f'/api/cases/{key}/events/{eid}/wide-reference.jpg','sha256':item['imageSha256'],'displayCrop':item.get('displayCrop')} if item else None,
        'supplementalReferees':evidence.get('supplementalReferees',[]),'identities':evidence.get('identities',{}),'sources':sources(key,eid)}

def save(key,eid,payload):
    root=case_store.CASES[key]
    with lease(root/'wide-reference.lock') as acquired:
        if not acquired:raise RuntimeError('광각 근거를 저장 중입니다. 잠시 후 다시 시도하세요.')
        current=view(key,eid)
        if payload.get('version')!=current['version']:raise RuntimeError('광각 근거가 변경됐습니다. 다시 불러오세요.')
        case,event,packet,frame=context(key,eid);refs=manifest(root)
        if payload.get('operation')=='capture':
            seconds=payload.get('seconds')
            if type(seconds) not in (int,float) or not math.isfinite(seconds) or seconds<0:raise ValueError('광각 영상 시점을 확인하세요.')
            path=source_file(key,eid,payload.get('sourceId'))
            cap=cv2.VideoCapture(str(path));fps=cap.get(cv2.CAP_PROP_FPS);total=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));index=round(seconds*fps)
            if not 1<=fps<=120 or not 0<=index<total:cap.release();raise ValueError('광각 원본 프레임 범위를 확인하세요.')
            cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();decoded=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;cap.release()
            if not ok or decoded!=index:raise RuntimeError('광각의 선택 프레임을 정확하게 읽지 못했습니다.')
            with path.open('rb') as f:source_sha=hashlib.file_digest(f,'sha256').hexdigest()
            raw=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,94])[1].tobytes();sha=hashlib.sha256(raw).hexdigest()
            name=f'wide-reference-images/{eid}-{sha[:16]}.jpg';(root/Path(name).parent).mkdir(parents=True,exist_ok=True);(root/name).write_bytes(raw)
            h,w=image.shape[:2]
            prior_refs=copy.deepcopy(refs)
            refs['events'][eid]={'image':name,'imageSha256':sha,'broadcastSha256':packet['inputSha256'],'broadcastFrame':frame['frameIndex'],
                'displayCrop':[0,round(h*.35),w,h],'clipPath':str(path),'clipSha256':source_sha,'candidateSeconds':index/fps,
                'source':{'sourceId':payload['sourceId'],'frameIndex':index,'fps':fps,'sha256':source_sha},'savedAt':now()}
            if prior_refs.get('events'):atomic(root/'wide-reference-history'/f'{digest(prior_refs)[:20]}.json',prior_refs)
            atomic(root/'wide-references.json',refs)
        elif payload.get('operation')=='supplement':
            people=payload.get('referees',[])
            evidence_path=root/'scene-evidence.json';data=json.loads(evidence_path.read_text()) if evidence_path.exists() else {'events':{}}
            if people==[]:
                if eid in data['events']:atomic(root/'scene-evidence-history'/f'{digest(data)[:20]}.json',data)
                data['events'].pop(eid,None);atomic(evidence_path,data)
                return view(key,eid)
            item=selected(root,event,frame['frameIndex'])
            if not item:raise ValueError('심판이 보이는 광각 참고 화면을 먼저 선택하세요.')
            if not isinstance(people,list) or len(people)+current['broadcastRefereeCount']>3:raise ValueError('중계 심판과 합해 3명 이내로 보완하세요.')
            image=cv2.imread(str(root/item['image']));h,w=image.shape[:2];clean=[];identities={}
            for n,person in enumerate(people,1):
                if not isinstance(person,dict) or not isinstance(person.get('note',''),str):raise ValueError('심판 보완 형식을 확인하세요.')
                xy=person.get('xy');box=person.get('pixelBox');note=person.get('note','').strip();number=person.get('number')
                if not isinstance(xy,list) or len(xy)!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in xy) or not(-4<=xy[0]<=32 and -3<=xy[1]<=19):raise ValueError('2D 코트의 심판 위치를 확인하세요.')
                if not isinstance(box,list) or len(box)!=4 or any(type(v) not in (int,float) or not math.isfinite(v) for v in box) or not(0<=box[0]<box[2]<=w and 0<=box[1]<box[3]<=h):raise ValueError('광각에서 심판 박스를 지정하세요.')
                if not note or len(note)>300:raise ValueError('광각 대조·위치 확인 근거를 남겨 주세요.')
                pid=person.get('id',f'wide-ref-{eid}-{n}')
                if not isinstance(pid,str) or not re.fullmatch(r'wide-ref-[A-Za-z0-9_-]{1,51}',pid) or any(p['id']==pid for p in clean):raise ValueError('보완 심판 ID를 확인하세요.')
                saved={'id':pid,'xy':xy,'pixelBox':box,'note':note,'number':number};proof_id=person.get('sequenceEvidenceId')
                if proof_id is not None:
                    if not isinstance(proof_id,str) or not re.fullmatch(r'[a-f0-9]{64}',proof_id):raise ValueError('동기 심판 근거를 확인하세요.')
                    proof_file=root/'sequence-evidence'/f'{proof_id}.json'
                    try:proof=json.loads(proof_file.read_text())
                    except (OSError,ValueError):raise ValueError('동기 심판 근거 파일이 없습니다.') from None
                    if (digest(proof)!=proof_id or proof.get('caseId')!=key or proof.get('eventId')!=eid or proof.get('supplementId')!=pid
                        or proof.get('sceneXY')!=xy or proof.get('observation',{}).get('wideBox')!=box):raise ValueError('동기 심판의 위치 또는 원본 근거가 다릅니다.')
                    saved['sequenceEvidenceId']=proof_id
                clean.append(saved)
                if number is not None:
                    if type(number)!=int or number not in {r['number'] for r in case['referees']} or number in {i['number'] for i in identities.values()}:raise ValueError('배정 심판 번호의 중복을 확인하세요.')
                    identities[pid]={'number':number,'basis':'operator-roster-match','sourceFrame':frame['frameIndex']}
            old=data['events'].get(eid,{})
            if all(old.get(k)==v for k,v in {'broadcastFrame':frame['frameIndex'],'broadcastSha256':packet['inputSha256'],'datasetId':packet['datasetId']}.items()):
                broadcast_ids={p['id'] for p in frame.get('floorPositions',[]) if p['role']=='referee'}
                for pid,identity in old.get('identities',{}).items():
                    if pid in broadcast_ids:
                        if identity['number'] in {i['number'] for i in identities.values()}:raise ValueError('중계·광각에 같은 심판 번호가 중복됩니다.')
                        identities[pid]=identity
            same=all(old.get(k)==v for k,v in {'broadcastFrame':frame['frameIndex'],'broadcastSha256':packet['inputSha256'],'datasetId':packet['datasetId']}.items()) and (not old.get('wideReference') or old['wideReference'].get('imageSha256')==item['imageSha256'])
            retained=copy.deepcopy(old) if same else {}
            warnings=list(retained.get('qualityWarnings',[]));warning='광각 참고 시점에서 확인한 근사 심판 위치 · 기본 자세'
            if clean and warning not in warnings:warnings.append(warning)
            if not clean:warnings=[w for w in warnings if w!=warning]
            data['events'][eid]={**retained,'broadcastFrame':frame['frameIndex'],'broadcastSha256':packet['inputSha256'],'datasetId':packet['datasetId'],
                'wideReference':{'image':item['image'],'imageSha256':item['imageSha256'],'broadcastFrame':frame['frameIndex']},
                'supplementalReferees':clean,'identities':identities,'qualityWarnings':warnings}
            if evidence_path.exists():
                previous=json.loads(evidence_path.read_text());atomic(root/'scene-evidence-history'/f'{digest(previous)[:20]}.json',previous)
            atomic(evidence_path,data)
            # Bind the photo to the source frame, not to a mutable 3D capture ID.
            refs['events'][eid]['broadcastFrame']=frame['frameIndex'];atomic(root/'wide-references.json',refs)
        else:raise ValueError('광각 근거 작업을 확인하세요.')
    return view(key,eid)
