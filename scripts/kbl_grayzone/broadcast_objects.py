"""Frame-scoped reviewer additions/role/footpoint edits, separate from model output."""
import copy,hashlib,json,math,re,threading,uuid
from datetime import datetime,timezone
import cv2,numpy as np
import case_store
from image_bounds import visible_pixel_box

LOCK=threading.RLock()
ROLES=('player','referee','staff','unknown','ball')
MANUAL_PROJECTION_MARGIN_METRES=0.25

def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False));temp.replace(path)

def folder(case_id,event_id,index):return case_store.CASES[case_id]/'broadcast-objects'/event_id/str(index)

def record(case_id,event_id,packet,index):
    p=folder(case_id,event_id,index)/'current.json'
    if not p.exists():return None
    data=json.loads(p.read_text())
    if data.get('baseDatasetId')!=packet['datasetId'] or data.get('inputSha256')!=packet['inputSha256']:return None
    return data

def ball_objects(frame):
    items=[]
    candidates=frame.get('ballCandidates') or ([frame['ball']] if frame.get('ball') else [])
    for i,b in enumerate(candidates):
        box=b.get('pixelBox') or b.get('box')
        point=b.get('point') or ([(box[0]+box[2])/2,(box[1]+box[3])/2] if box else None)
        if not point:continue
        if not box:box=[max(0,point[0]-8),max(0,point[1]-8),min(1920,point[0]+8),min(1080,point[1]+8)]
        items.append({'id':f"ball-{frame['frameIndex']}-{i}",'role':'ball','pixelBox':box,
            'footpointPixels':point,'footpointManual':False,'excluded':False,'added':False,'manuallyReviewed':False})
    return items

def apply(case_id,event_id,packet,index):
    data=record(case_id,event_id,packet,index)
    if not data:return packet
    frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    if frame is None:return packet
    w,h=packet['width'],packet['height'];boxes={b['id']:b for b in frame['boxes']};positions={p['id']:p for p in frame.get('floorPositions',[])}
    balls={b['id']:b for b in ball_objects(frame)};expanded=[]
    for edit in data['edits']:
        person_id=edit['id']
        if edit['excluded']:
            boxes.pop(person_id,None);positions.pop(person_id,None);balls.pop(person_id,None);continue
        if edit['role']=='ball':
            boxes.pop(person_id,None);positions.pop(person_id,None)
            balls[person_id]=copy.deepcopy(edit);continue
        balls.pop(person_id,None)
        box=copy.deepcopy(boxes.get(person_id,{'id':person_id,'confidence':None,'source':'manual-addition'}))
        prior_pixel_box=visible_pixel_box(box['box'],w,h) if box.get('box') else None
        evidence=edit.get('footpointEvidence','manual-proxy')
        box.update(box=[v/s for v,s in zip(edit['pixelBox'],[w,h]*2)],roleHint=edit['role'],roleSource='manual-review',
            footpointPixels=edit['footpointPixels'],footpointStatus=('manual-floor-estimate' if evidence=='off-frame-estimate' else 'manual-floor-contact') if edit['footpointManual'] else 'bbox-bottom proxy; not ankle-verified',
            footpointEvidence=evidence,footpointNote=edit.get('footpointNote',''),
            manuallyReviewed=True,manualAddition=edit['added'],groundContactVerified=False,spatialExcluded=bool(edit.get('spatialExcluded')))
        if edit['footpointManual'] and edit['pixelBox'][3]>=h-1 and edit['footpointPixels'][1]>=h-2:
            box['footpointStatus']='manual-floor-frame-edge-estimate';box['footpointFrameEdge']=True
        boxes[person_id]=box;positions.pop(person_id,None)
        if edit.get('spatialExcluded'):
            box['footpointStatus']='reviewer-image-only';continue
        if box.get('widePosition') and not edit['footpointManual'] and edit['pixelBox']==prior_pixel_box:
            positions[person_id]={**copy.deepcopy(box['widePosition']),'role':edit['role']}
            continue
        x,y=edit['footpointPixels'];blocked=not edit['footpointManual'] and (y>=.97*h or x<3 or x>w-3 or (.20*w<x<.85*w and y>.86*h))
        H=box.get('sourceImageToCourt') if box.get('imageSource')=='wide' else frame.get('court',{}).get('imageToCourt')
        if box.get('imageSource')=='wide':blocked=not edit['footpointManual'] and (y>=.99*h or x<3 or x>w-3)
        if H and not blocked:
            xy=cv2.perspectiveTransform(np.array([[[x,y]]],np.float64),np.array(H))[0,0]
            if np.isfinite(xy).all():
                raw_xy=xy.copy()
                # A manually chosen point can land slightly outside
                # the supported apron because calibration itself is approximate.
                # Keep the measured projection, label the adjustment, and never
                # apply this tolerance to automatic footpoint guesses.
                margin=MANUAL_PROJECTION_MARGIN_METRES
                near_manual=edit['footpointManual'] and -2-margin<=xy[0]<=30+margin and -2-margin<=xy[1]<=17+margin
                if near_manual:
                    xy=np.array([np.clip(xy[0],-2,30),np.clip(xy[1],-2,17)])
                in_expanded=edit['footpointManual'] and -4<=xy[0]<=32 and -3<=xy[1]<=19
                if in_expanded or (-2<xy[0]<30 and -2<xy[1]<17):
                    adjusted=not np.array_equal(raw_xy,xy)
                    positions[person_id]={'id':person_id,'role':edit['role'],'xy':xy.tolist(),'status':'manual-floor-estimate-boundary-adjusted' if adjusted else box['footpointStatus'],
                        'source':'manual-review','footpointEvidence':evidence,'footpointNote':edit.get('footpointNote',''),'approvedForOcclusion':False}
                    if adjusted:positions[person_id].update(rawProjectedXY=raw_xy.tolist(),boundaryAdjusted=True)
                    if box.get('footpointFrameEdge'):positions[person_id]['frameEdgeEstimate']=True
                    if not near_manual and in_expanded and not (-2<xy[0]<30 and -2<xy[1]<17):expanded.append({'id':person_id,'xy':xy.tolist()})
    previous=(data.get('previousScene') or {}).get('state');draft=None
    if previous:
        old={e['id']:e for e in previous['entities']};entities=[]
        for p in positions.values():
            e=copy.deepcopy(old.get(p['id'],{'id':p['id'],'bodyHeading':0,'bodyDirectionSource':'assumed'}))
            if e.get('positionSource')=='manual' and p['id'] not in data.get('positionChangedIds',[]):p['xy']=[e['x'],e['y']]
            # Object review is authoritative for membership and role. Older
            # spatial role overrides must never undo an object-stage correction.
            if e.get('role')!=p['role']:e.pop('teamSource',None)
            e.update(role=p['role'],roleSource=boxes[p['id']].get('roleSource','model'),x=p['xy'][0],y=p['xy'][1]);entities.append(e)
        # A later team/ball/other-person edit must not erase a partial person's
        # explicit Step3 placement. A changed crop/footpoint still invalidates it.
        placed={e['id'] for e in entities}
        for person_id,e in old.items():
            box=boxes.get(person_id)
            if person_id in placed or person_id in data.get('positionChangedIds',[]) or not box or e.get('positionSource')!='manual':continue
            if box.get('spatialExcluded') and not e.get('spatialOverride'):continue
            e=copy.deepcopy(e)
            if e.get('role')!=box['roleHint']:e.pop('teamSource',None)
            e.update(role=box['roleHint'],roleSource=box.get('roleSource','model'));entities.append(e)
        draft={**copy.deepcopy(previous),'entities':entities}
    frame['boxes']=list(boxes.values());frame['floorPositions']=list(positions.values())
    frame['ballObjects']=list(balls.values())
    frame['ball']=({'point':balls[next(iter(balls))]['footpointPixels'],'confidence':None,'source':'manual' if balls[next(iter(balls))].get('manuallyReviewed') else 'candidate','coordinateSpace':'image','heightMeasured':False} if len(balls)==1 else None)
    frame['ballStatus']='manual-tag' if len(balls)==1 and next(iter(balls.values())).get('manuallyReviewed') else 'candidate-unverified' if len(balls)==1 else 'ambiguous' if balls else 'missing'
    frame['objectReview']={'revision':data['revision'],'manualAdded':sum(e['added'] and not e['excluded'] and e['role']!='ball' for e in data['edits']),
        'manualEdited':sum(not e['added'] and not e['excluded'] and e['role']!='ball' for e in data['edits']),
        'ballTags':len(balls),'excluded':sum(e['excluded'] for e in data['edits']),'scope':'selected-frame-only'}
    packet['objectReview']={'baseDatasetId':packet['datasetId'],**frame['objectReview'],'sceneDraft':draft}
    packet['datasetId']=data['datasetId']
    if expanded:
        digest=hashlib.sha256(json.dumps(sorted(expanded,key=lambda e:e['id']),sort_keys=True,separators=(',',':')).encode()).hexdigest()[:12]
        packet['datasetId']+='-apron-v1-'+digest
    return packet

def context(case_id,event_id):
    case=case_store.load_case(case_id);event=next(e for e in case['events'] if e['id']==event_id)
    base=case_store.broadcast_packet(case_id,event_id,include_objects=False);index=case_store.broadcast_index(event,base['fps'])
    frame=next((f for f in base['frames'] if f['frameIndex']==index),None)
    if frame is None:raise RuntimeError('선택한 프레임을 먼저 재처리하세요.')
    return case,event,base,frame

def view(case_id,event_id):
    case,event,base,frame=context(case_id,event_id);index=frame['frameIndex'];r=record(case_id,event_id,base,index)
    packet=apply(case_id,event_id,copy.deepcopy(base),index);current=next(f for f in packet['frames'] if f['frameIndex']==index)
    w,h=base['width'],base['height'];objects={}
    for b in frame['boxes']:
        objects[b['id']]={'id':b['id'],'role':b['roleHint'],'pixelBox':visible_pixel_box(b['box'],w,h),
            'footpointPixels':b['footpointPixels'],'footpointManual':False,'excluded':False,'added':False}
    for b in ball_objects(frame):objects[b['id']]=b
    for e in (r or {}).get('edits',[]):objects[e['id']]=copy.deepcopy(e)
    floor={p['id']:p for p in current.get('floorPositions',[])}
    for item in objects.values():
        source=next((b for b in current['boxes'] if b['id']==item['id']),{})
        item['imageSource']=source.get('imageSource','broadcast');item['sourceImageUrl']=source.get('sourceImageUrl')
        position=floor.get(item['id']);item['hasFloorPosition']=position is not None
        item['frameEdgeEstimate']=bool(source.get('footpointFrameEdge'))
        if position and position.get('boundaryAdjusted'):
            item['boundaryAdjusted']=True;item['rawProjectedXY']=position['rawProjectedXY']
            item['boundaryAdjustmentMetres']=math.dist(position['rawProjectedXY'],position['xy'])
        item['spatialExcluded']=bool(item.get('spatialExcluded'))
        item['spatialStatus']='excluded' if item['excluded'] else 'image-only' if item['role']=='ball' or item['spatialExcluded'] else 'placed' if item['hasFloorPosition'] else 'footpoint-required'
    return {'caseId':case_id,'eventId':event_id,'frameIndex':index,'selectionRevision':case['revision'],
        'datasetId':packet['datasetId'],'inputSha256':base['inputSha256'],'revision':r['revision'] if r else 0,
        'width':w,'height':h,'objects':list(objects.values()),'wideAssistance':packet.get('wideAssistance'),
        'courtCalibrationRequired':not bool(current.get('court',{}).get('imageToCourt')),
        'frameUrl':f'/case-object-frame/{case_id}/{event_id}/{index}.jpg','scope':'selected-frame-only'}

def finite(v,lo,hi):
    if type(v) not in (int,float) or not math.isfinite(v) or not lo<=v<=hi:raise ValueError('이미지 범위 안의 유효한 좌표가 필요합니다.')
    return float(v)

def save(case_id,event_id,payload):
    with LOCK,case_store.LOCK:
        case,event,base,frame=context(case_id,event_id);current=view(case_id,event_id)
        for key in ('selectionRevision','datasetId','inputSha256','frameIndex','revision'):
            if payload.get(key)!=current[key]:raise RuntimeError('프레임 또는 객체 보정이 변경됐습니다. 새로고침하세요.')
        updates=payload.get('updates')
        if not isinstance(updates,list) or not 1<=len(updates)<=40:raise ValueError('보정할 객체 1~40개가 필요합니다.')
        prior=record(case_id,event_id,base,frame['frameIndex']);edits={e['id']:e for e in (prior or {}).get('edits',[])}
        import broadcast_pose,broadcast_reconstruction
        try:old_pose=broadcast_pose.current(case_id,event_id);old_scene=broadcast_reconstruction.current(case_id,event_id)
        except RuntimeError:old_pose=None;old_scene=None
        known={e['id']:e for e in current['objects']};seen=set();assigned={};position_changed=set() if old_scene else set((prior or {}).get('positionChangedIds',[]));role_changed=set() if old_scene else set((prior or {}).get('roleChangedIds',[]))
        for u in updates:
            person_id=u.get('id')
            if not isinstance(person_id,str) or person_id in seen:raise ValueError('중복되거나 잘못된 인물 ID입니다.')
            seen.add(person_id);added=person_id.startswith('new-')
            if added:
                if not re.fullmatch(r'new-[a-zA-Z0-9-]{1,50}',person_id):raise ValueError('추가할 인물 ID를 확인하세요.')
                assigned[person_id]='manual-'+uuid.uuid4().hex[:12];person_id=assigned[person_id]
            elif person_id not in known:raise ValueError('현재 프레임에 없는 인물입니다.')
            else:added=known[person_id]['added']
            if u.get('role') not in ROLES or type(u.get('excluded'))!=bool or type(u.get('footpointManual'))!=bool:raise ValueError('역할·제외·발 접점 설정을 확인하세요.')
            if type(u.get('spatialExcluded',False))!=bool:raise ValueError('공간 배치 설정을 확인하세요.')
            evidence=u.get('footpointEvidence','manual-proxy');note=u.get('footpointNote','')
            if evidence not in ('manual-proxy','visible-feet','off-frame-estimate') or not isinstance(note,str) or len(note)>600:raise ValueError('발 위치 근거와 메모를 확인하세요.')
            b=u.get('pixelBox');foot=u.get('footpointPixels');w,h=base['width'],base['height']
            if not isinstance(b,list) or len(b)!=4 or not isinstance(foot,list) or len(foot)!=2:raise ValueError('인물 박스와 발 접점 좌표가 필요합니다.')
            b=[finite(v,0,w if i%2==0 else h) for i,v in enumerate(b)]
            if b[2]-b[0]<(2 if u['role']=='ball' else 4) or b[3]-b[1]<(2 if u['role']=='ball' else 8):raise ValueError('인물 전체를 포함하도록 박스를 넓혀 주세요.')
            off_frame=evidence=='off-frame-estimate' and u['footpointManual'] and u['role']!='ball'
            if off_frame and not note.strip():raise ValueError('화면 밖 발 위치는 추정 근거를 기록하세요.')
            foot=[finite(v,-.25*(w,h)[i] if off_frame else 0,1.5*(w,h)[i] if off_frame else (w,h)[i]-1) for i,v in enumerate(foot)] if u['footpointManual'] else [(b[0]+b[2])/2,min(h-1,b[3])]
            if u['role']=='ball':foot=[(b[0]+b[2])/2,(b[1]+b[3])/2]
            old=known.get(person_id,{})
            if old.get('pixelBox')!=b or old.get('footpointPixels')!=foot:position_changed.add(person_id)
            if old.get('role')!=u['role']:role_changed.add(person_id)
            edits[person_id]={'id':person_id,'pixelBox':b,'role':u['role'],'footpointPixels':foot,
                'footpointManual':u['footpointManual'] if u['role']!='ball' else False,'footpointEvidence':evidence,'footpointNote':note,'manuallyReviewed':True,'excluded':u['excluded'],'added':added,'spatialExcluded':u.get('spatialExcluded',False) if u['role']!='ball' else False}
        count=len({**known,**edits})
        if count>40:raise ValueError('한 장면에서 최대 40개까지 관리할 수 있습니다.')
        if prior and not assigned and list(edits.values())==prior['edits']:
            return {**current,'assignedIds':{},'poseRequired':False,'unchanged':True}
        # Keep the prior pose immutable so unaffected, saved joint edits can survive.
        data={'schema':'kbl-broadcast-objects/v1','frameIndex':frame['frameIndex'],'inputSha256':base['inputSha256'],
            'baseDatasetId':base['datasetId'],'revision':current['revision']+1,'edits':list(edits.values()),
            'savedAt':datetime.now(timezone.utc).isoformat(),'previousPoseJobId':old_pose['jobId'] if old_pose and old_pose['job']['state']=='complete' else (prior or {}).get('previousPoseJobId'),
            'previousScene':old_scene or (prior or {}).get('previousScene'),'previousDatasetId':current['datasetId'],
            'positionChangedIds':sorted(position_changed),'roleChangedIds':sorted(role_changed)}
        digest=hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:16]
        data['datasetId']=base['datasetId']+'-objects-'+digest
        root=folder(case_id,event_id,frame['frameIndex']);atomic(root/f"revision-{data['revision']}.json",data);atomic(root/'current.json',data)
        return {**view(case_id,event_id),'assignedIds':assigned,'poseRequired':True}

def image_file(case_id,event_id,index):
    case,event,packet,frame=context(case_id,event_id)
    if index!=frame['frameIndex']:raise RuntimeError('기준 프레임이 변경됐습니다. 새로고침하세요.')
    path=folder(case_id,event_id,index)/(packet['inputSha256'][:16]+'.jpg')
    if not path.exists():
        cap=cv2.VideoCapture(str(case_store.CASES[case_id]/'broadcast'/event['broadcast']['file']));cap.set(cv2.CAP_PROP_POS_FRAMES,index)
        ok,im=cap.read();actual=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;cap.release()
        if not ok or actual!=index:raise RuntimeError('선택한 원본 프레임을 읽지 못했습니다.')
        path.parent.mkdir(parents=True,exist_ok=True);cv2.imwrite(str(path),im,[cv2.IMWRITE_JPEG_QUALITY,95])
    return path
