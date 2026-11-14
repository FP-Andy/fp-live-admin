"""Broadcast-frame pose inference/review and reviewed-only COCO keypoint export."""
import copy,hashlib,json,math
from pathlib import Path
import cv2,numpy as np
import pose_jobs
from image_bounds import visible_pixel_box
import broadcast_reconstruction as reconstruction
from case_store import CASES
from read_context import memoized,once
NAMES=['nose','left_eye','right_eye','left_ear','right_ear','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle']

def path(case_id,event_id):return CASES[case_id]/'broadcast-pose'/f'{event_id}.json'

def pose_people(packet,frame,entities=None):
    """Image annotations select pose subjects; floor placement only gates 3D."""
    placed={e['id']:e for e in (entities if entities is not None else
        [{'id':p['id'],'role':p['role'],'x':p['xy'][0],'y':p['xy'][1]} for p in frame.get('floorPositions',[])])}
    people=[]
    for b in frame['boxes']:
        e=placed.get(b['id']);role=e['role'] if e else b['roleHint']
        if role not in ('player','referee'):continue
        people.append({'id':b['id'],'role':role,'x':e['x'] if e else None,'y':e['y'] if e else None,
            'spatialEligible':bool(e),'spatialReason':None if e else 'floor-position-unresolved',
            'pixelBox':visible_pixel_box(b['box'],packet['width'],packet['height']),'team':'unknown'})
        if b.get('widePose') and role==b['widePose']['role']:
            p=people[-1];p.update(imageSource=b.get('imageSource','broadcast'),sourceImageUrl=b.get('sourceImageUrl'),
                sourceSha256=b.get('sourceSha256'),widePose=copy.deepcopy(b['widePose']))
            if p['imageSource']=='wide':p['cameraOverride']=copy.deepcopy(b['sourceCamera'])
    return people

def same_image_person(a,b):
    return a['id']==b['id'] and a['role']==b['role'] and a.get('imageSource','broadcast')==b.get('imageSource','broadcast') and a.get('sourceSha256')==b.get('sourceSha256') and all(abs(x-y)<.01 for x,y in zip(a['pixelBox'],b['pixelBox']))

def camera_inputs(frame,people):
    # Image keypoints need a person crop, not a calibrated court camera.
    if not any(p.get('spatialEligible',True) for p in people):return [],None
    from broadcast_geometry import FLOOR_POINTS
    landmarks=[p for p in frame.get('court',{}).get('landmarks',[]) if p['class_id'] in FLOOR_POINTS]
    if not frame.get('court',{}).get('imageToCourt') or len(landmarks)<6:
        raise ValueError('3D 자세에 필요한 코트 보정점이 부족합니다. 코트 좌표를 먼저 보정하세요.')
    obj=np.float32([[*FLOOR_POINTS[p['class_id']],0] for p in landmarks]);img=np.float32([[p['x'],p['y']] for p in landmarks])
    K=np.array([[1500.,0,960],[0,1500,540],[0,0,1]])
    flags=cv2.CALIB_USE_INTRINSIC_GUESS|cv2.CALIB_FIX_ASPECT_RATIO|cv2.CALIB_FIX_PRINCIPAL_POINT|cv2.CALIB_ZERO_TANGENT_DIST|cv2.CALIB_FIX_K1|cv2.CALIB_FIX_K2|cv2.CALIB_FIX_K3
    try:error,K,d,rv,tv=cv2.calibrateCamera([obj],[img],(1920,1080),K,np.zeros(5),flags=flags)
    except cv2.error as e:
        raise ValueError('코트 카메라 보정을 계산하지 못했습니다. 저장한 객체·관절은 유지됩니다. 코트 보정점을 확인하세요.') from e
    R=cv2.Rodrigues(rv[0])[0];t=tv[0].ravel()
    if (-R.T@t)[2]<0:R[:,2]*=-1
    if not np.isfinite(K).all() or error>20 or not 300<K[0,0]<20000:raise ValueError('중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.')
    override={'K':K.tolist(),'distortion':d.ravel().tolist(),'worldToCamera':R.tolist(),'translation':t.tolist(),'anchorRMSEPixels':error,'source':'visible-floor-landmarks','provisional':True}
    return [img[i%len(img)].astype(float).tolist() for i in range(9)],override

@memoized
def current(case_id,event_id):
    case,event,packet,frame=reconstruction.context(case_id,event_id,require_floor=False)
    p=path(case_id,event_id)
    if not p.exists():return None
    record=json.loads(p.read_text())
    if record['frameIndex']!=frame['frameIndex'] or record['datasetId']!=packet['datasetId'] or record['inputSha256']!=packet['inputSha256']:return None
    s=pose_jobs.status(record['jobId'])
    # Preserve a completed, image-only annotation when a first court transform
    # is added. It remains image-only: no inferred 3D mesh or gaze is created.
    court_changed=record.get('courtRevision')!=frame.get('courtRevision')
    image_only_carry=bool(court_changed and record.get('courtRevision') is None and
        frame.get('courtRevision') and s['state']=='complete' and
        s['result'].get('poseSource')=='image-only-inferred' and
        all(p.get('spatialEligible') is False for p in s['result'].get('people',[])))
    if court_changed and not image_only_carry:return None
    scene_path=CASES[case_id]/'reconstructions'/event_id/'current.json'
    if s['state']=='complete':
        entities=(packet.get('objectReview',{}).get('sceneDraft') or {}).get('entities')
        if scene_path.exists():
            scene=json.loads(scene_path.read_text())
            if scene.get('frameIndex')==frame['frameIndex'] and scene.get('datasetId')==packet['datasetId']:entities=scene['state']['entities']
        expected={p['id']:p for p in pose_people(packet,frame,entities)}
        manual_positions={e['id'] for e in (entities or []) if e.get('positionSource')=='manual'}
        if {p['id'] for p in s['result']['people']}!=set(expected):return None
        for p in s['result']['people']:
            e=expected[p['id']]
            if not same_image_person(e,p):return None
            if image_only_carry:continue
            # Moving an unchanged, reviewed body in the court does not change
            # its image keypoints or local mesh. Newly placed image-only bodies
            # retain their 2D review and use a neutral template until lifted.
            if p['id'] in manual_positions:continue
            if e['spatialEligible']!=p.get('spatialEligible',True):return None
            if e['spatialEligible'] and math.hypot(e['x']-p['x'],e['y']-p['y'])>.001:return None
    return {**record,'job':s,**({'imageOnlyAfterCourtReview':True} if image_only_carry else {})}

def validate_pose(case_id,event_id,job_id,entities):
    record=current(case_id,event_id)
    if not record or record['jobId']!=job_id or record['job']['state']!='complete':raise RuntimeError('현재 프레임의 완료된 자세 작업이 필요합니다.')
    result=record['job']['result'];by_id={e['id']:e for e in entities}
    def mesh_signature():
        mesh=json.loads((pose_jobs.folder(job_id)/'meshes.json').read_text())
        return hashlib.sha256(json.dumps(mesh['assets'],separators=(',',':')).encode()).hexdigest(),mesh['geometrySha256']
    actual,recorded=once(('pose-mesh-signature',job_id),mesh_signature)
    if actual!=result['meshSha256'] or recorded!=actual:raise RuntimeError('자세 메시 파일이 변경됐습니다. 다시 생성하세요.')
    for p in result['people']:
        if p.get('spatialEligible') is False:continue
        e=by_id.get(p['id'])
        if e is None or e['role']!=p['role'] or (e.get('positionSource')!='manual' and math.hypot(e['x']-p['x'],e['y']-p['y'])>.001):raise RuntimeError('위치·역할이 바뀌었습니다. 자세를 다시 추정하세요.')
    return result

def submit(case_id,event_id,payload):
    case,event,packet,frame=reconstruction.context(case_id,event_id,require_floor=False)
    if payload.get('selectionRevision')!=case['revision']:raise RuntimeError('기준 프레임이 바뀌었습니다. 새로고침하세요.')
    if payload.get('datasetId',packet['datasetId'])!=packet['datasetId']:raise RuntimeError('객체 보정이 변경됐습니다. 새로고침하세요.')
    prior=current(case_id,event_id);override=None;preserved_people=None;previous=None;reusable_people=[]
    reuse_source=None
    if prior and not payload.get('parentId'):
        if prior['job']['state'] in ('queued','running','interrupted'):
            if prior['job']['state']!='interrupted' or prior['job'].get('resumeAvailable'):
                return {**prior,'job':pose_jobs.resume(prior['jobId'])}
        if prior['job']['state']=='complete' and prior['job']['result'].get('pipelineVersion')==pose_jobs.PIPELINE_VERSION:
            return prior
    if payload.get('parentId'):
        if not prior or prior['jobId']!=payload['parentId']:raise RuntimeError('현재 자세의 개정만 수정할 수 있습니다.')
        old=pose_jobs.result(prior['jobId']);anchors=old['anchors'];people=old['people']
    else:
        saved=reconstruction.current(case_id,event_id) if frame.get('floorPositions') else None
        draft=packet.get('objectReview',{}).get('sceneDraft')
        entities=saved['state']['entities'] if saved else draft['entities'] if draft else None
        people=pose_people(packet,frame,entities)
        anchors,override=camera_inputs(frame,people)
        if packet.get('objectReview'):
            import broadcast_objects
            obj=json.loads((broadcast_objects.folder(case_id,event_id,frame['frameIndex'])/'current.json').read_text())
            if obj.get('previousPoseJobId'):
                old=pose_jobs.result(obj['previousPoseJobId'])
                if old['frameIndex']==frame['frameIndex'] and old['clipId']==f'{case_id}-{event_id}-broadcast':
                    preserved_people=old['people']
                    if old.get('modelSha256')==pose_jobs.MODEL_SHA:
                        reusable_people=old['people'];reuse_source={'jobId':old['jobId'],'inputSha256':packet['inputSha256']}
        # Coverage upgrades may invalidate the previous result. Keep its manual
        # image corrections instead of reverting to the earlier object revision.
        previous_path=path(case_id,event_id)
        if previous_path.exists():
            previous=json.loads(previous_path.read_text())
            if previous['frameIndex']==frame['frameIndex'] and previous['inputSha256']==packet['inputSha256'] and pose_jobs.status(previous['jobId'])['state']=='complete':
                old=pose_jobs.result(previous['jobId']);preserved_people=old['people']+(preserved_people or [])
                if old.get('modelSha256')==pose_jobs.MODEL_SHA:
                    reusable_people=old['people']+reusable_people;reuse_source={'jobId':old['jobId'],'inputSha256':packet['inputSha256']}
    clip={'id':f'{case_id}-{event_id}-broadcast','fps':packet['fps'],'file_duration_seconds':event['broadcast']['durationSeconds']}
    data={'datasetId':packet['datasetId'],'analysisSource':'broadcast','frameIndex':frame['frameIndex'],'anchors':anchors,'people':people,**{k:v for k,v in payload.items() if k in ('parentId','edits','rebuild')}}
    trusted_images={}
    import base64,multiview
    for person in people:
        url=person.get('sourceImageUrl')
        if person.get('imageSource')!='wide' or not url or url in trusted_images:continue
        revision=url.rsplit('/',1)[-1].split('.')[0]
        raw=multiview.image_file(case_id,event_id,frame['frameIndex'],revision).read_bytes()
        trusted_images[url]={'base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}
    result=pose_jobs.submit(data,clip,{'datasetId':packet['datasetId'],'analysisSource':'broadcast','inputSha256':packet['inputSha256']},CASES[case_id]/'broadcast'/event['broadcast']['file'],camera_override=override,preserved_people=preserved_people,reusable_people=reusable_people,reuse_source=reuse_source,trusted_people=people,trusted_images=trusted_images)
    record={'caseId':case_id,'eventId':event_id,'jobId':result['jobId'],'frameIndex':frame['frameIndex'],'datasetId':packet['datasetId'],'inputSha256':packet['inputSha256'],'selectionRevision':case['revision'],'labelsReviewed':False,'trainingEligible':False}
    if frame.get('courtRevision'):record['courtRevision']=frame['courtRevision']
    source_review=prior if payload.get('parentId') else previous
    if source_review and source_review['frameIndex']==frame['frameIndex'] and source_review['inputSha256']==packet['inputSha256']:
        old_people=pose_jobs.result(source_review['jobId'])['people'] if pose_jobs.status(source_review['jobId'])['state']=='complete' else []
        record['reviewedPeople']={p['id']:{**copy.deepcopy(source_review['reviewedPeople'][p['id']]),'reviewed':False}
            for p in people if p['id'] in source_review.get('reviewedPeople',{}) and any(same_image_person(p,o) for o in old_people)}
    p=path(case_id,event_id);p.parent.mkdir(exist_ok=True)
    if p.exists():
        previous_record=json.loads(p.read_text());archive=p.parent/'history'/event_id;archive.mkdir(parents=True,exist_ok=True)
        pose_jobs.write(archive/(previous_record['jobId']+'.json'),previous_record)
    pose_jobs.write(p,record);return {**record,'job':result}

def review(case_id,event_id,payload):
    record=current(case_id,event_id)
    if not record or record['jobId']!=payload.get('jobId') or record['job']['state']!='complete':raise RuntimeError('현재 완료된 자세만 검수할 수 있습니다.')
    result=record['job']['result'];lookup={p['id']:p for p in result['people']}
    batch=payload.get('people')
    if batch is None:batch=[{'personId':payload.get('personId'),'visibility':payload.get('visibility'),'reviewed':payload.get('reviewed')}]
    elif not isinstance(batch,list) or not all(isinstance(p,dict) for p in batch) or len(batch)!=len(lookup) or {p.get('personId') for p in batch}!=set(lookup):raise ValueError('현재 장면의 전체 인물 상태가 필요합니다.')
    clean={}
    for item in batch:
        person=lookup.get(item.get('personId'))
        if person is None:raise ValueError('현재 장면의 인물을 확인하세요.')
        vis=item.get('visibility')
        if not isinstance(vis,list) or len(vis)!=17 or any(type(v)!=int or v not in (0,1,2) for v in vis):raise ValueError('17개 관절의 가시성 0/1/2를 확인하세요.')
        clean[person['id']]={'visibility':vis,'reviewed':item.get('reviewed') is True,'keypoints':person['keypoints'],'role':person['role']}
    record.pop('job');record.setdefault('reviewedPeople',{}).update(clean)
    # Saving a scene draft does not certify training labels or measured 3D posture.
    record['trainingEligible']=any(p['reviewed'] for p in record['reviewedPeople'].values());pose_jobs.write(path(case_id,event_id),record)
    return current(case_id,event_id)

def export(case_id):
    from case_store import load_case
    data=load_case(case_id);images=[];annotations=[]
    for e in data['events']:
        r=current(case_id,e['id'])
        if not r or r['job']['state']!='complete':continue
        reviewed=r.get('reviewedPeople',{});people=r['job']['result']['people'];accepted=[p for p in people if reviewed.get(p['id'],{}).get('reviewed') and p.get('imageSource','broadcast')=='broadcast']
        if not accepted:continue
        image_id=len(images)+1;images.append({'id':image_id,'file_name':f"{r['jobId']}/frame.jpg",'width':1920,'height':1080,'gameId':case_id,'split':'test','sourceSha256':r['inputSha256'],'frameIndex':r['frameIndex']})
        for p in accepted:
            review=reviewed[p['id']];kp=[]
            for q,v in zip(review['keypoints'],review['visibility']):kp.extend([float(q[0]) if v else 0,float(q[1]) if v else 0,v])
            x1,y1,x2,y2=p['pixelBox'];annotations.append({'id':len(annotations)+1,'image_id':image_id,'category_id':1,'bbox':[x1,y1,x2-x1,y2-y1],'area':(x2-x1)*(y2-y1),'iscrowd':0,'num_keypoints':sum(v>0 for v in review['visibility']),'keypoints':kp,'role':p['role']})
    if not annotations:raise ValueError('검수 완료로 표시된 관절 라벨이 없습니다. 자동 추정 결과만으로 학습하지 않습니다.')
    out={'info':{'description':'Reviewed 2D keypoints only. Game034 held out for evaluation; never train on this game. Partial person annotations; full-frame completeness unverified.','trainingReady':False},'images':images,'annotations':annotations,'categories':[{'id':1,'name':'person','supercategory':'person','keypoints':NAMES,'skeleton':[[6,8],[8,10],[7,9],[9,11],[6,7],[6,12],[7,13],[12,13],[12,14],[14,16],[13,15],[15,17]]}]}
    pose_jobs.write(CASES[case_id]/'broadcast-pose'/'reviewed-coco.json',out);return out
