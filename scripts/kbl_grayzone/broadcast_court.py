"""Frame-bound court corrections; detector IDs and reviewed image labels stay intact."""
import copy,hashlib,json
from datetime import datetime,timezone
import cv2,numpy as np
import case_store
from broadcast_geometry import estimate_court, estimate_manual_court

MIRROR={a:b for x,y in [(0,27),(1,28),(2,29),(3,30),(4,31),(5,32),(6,26),
    (7,24),(8,25),(9,21),(10,22),(11,23),(12,18),(13,19),(14,20)] for a,b in [(x,y),(y,x)]}

def points(raw,width,mirrored=False):
    predictions=raw.get('predictions',[])
    selected=max(predictions,key=lambda p:p.get('confidence',0)).get('keypoints',[]) if predictions else []
    return [{**p,**({'x':width-1-p['x'],'class_id':MIRROR.get(p['class_id'],p['class_id'])} if mirrored else {})} for p in selected]

def infer(image,predict):
    """Two bounded requests, same exact image; retain geometric rejection gates."""
    h,w=image.shape[:2];attempts=[]
    for mirrored in (False,True):
        raw=predict(cv2.flip(image,1) if mirrored else image,confidence=10)
        court=estimate_court(points(raw,w,mirrored),w,h)
        attempts.append({'input':'horizontal-mirror' if mirrored else 'original','raw':raw,'court':court})
        if court.get('imageToCourt'):
            return court,attempts
    return court,attempts

def path(key,event,index):return case_store.CASES[key]/'broadcast-court'/f'{event}-{index}.json'

def project(frame,width,height):
    frame['floorPositions']=[];H=np.array(frame['court']['imageToCourt'])
    for b in frame['boxes']:
        x,y=b['footpointPixels']
        if y>=.97*height or x<3 or x>width-3 or (.20*width<x<.85*width and y>.86*height):continue
        xy=cv2.perspectiveTransform(np.array([[[x,y]]],np.float64),H)[0,0]
        if np.isfinite(xy).all() and -2<xy[0]<30 and -2<xy[1]<17:
            frame['floorPositions'].append(dict(id=b['id'],role=b['roleHint'],xy=xy.tolist(),
                status='bbox-footpoint-proxy',source='broadcast',approvedForOcclusion=False))

def apply(key,event,packet,index):
    file=path(key,event,index)
    if not file.exists():return packet
    data=json.loads(file.read_text())
    # A changed video/model/frame must never inherit a previous homography.
    if data['baseDatasetId']!=packet['datasetId'] or data['inputSha256']!=packet['inputSha256'] or data['frameIndex']!=index:return packet
    frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    if frame is None:return packet
    frame['court']=copy.deepcopy(data['court']);frame['courtRevision']=data['revision']
    project(frame,packet['width'],packet['height'])
    return packet

def save_reviewed(key,event,index,landmarks,provenance,expected_dataset,expected_sha):
    """Install only an explicitly inspected correction, never a raw model proposal."""
    import broadcast_objects
    with case_store.LOCK:
        data=case_store.load_case(key);e=next(e for e in data['events'] if e['id']==event)
        packet=case_store.broadcast_packet(key,event,include_objects=False)
        if case_store.broadcast_index(e,packet['fps'])!=index or packet['datasetId']!=expected_dataset or packet['inputSha256']!=expected_sha:
            raise RuntimeError('기준 프레임이나 분석 결과가 바뀌었습니다. 코트 보정을 다시 확인하세요.')
        # A court correction is anchored before secondary-camera augmentation;
        # its revision invalidates/recomputes that augmentation on next processing.
        packet=case_store.broadcast_packet(key,event,include_objects=False,include_multiview=False)
        court=estimate_manual_court(landmarks,packet['width'],packet['height'])
        if not court.get('imageToCourt'):raise ValueError('코트 기준점의 기하 검증을 통과하지 못했습니다: '+court['reason'])
        # Check the actual 3D camera, not just the floor homography.
        import broadcast_pose
        try:
            _,camera=broadcast_pose.camera_inputs({'court':court},[{'spatialEligible':True}])
            camera_error=None
        except ValueError as exc:
            camera=None;camera_error=str(exc)
        court.update(provenance=copy.deepcopy(provenance),cameraAnchorRMSEPixels=camera['anchorRMSEPixels'] if camera else None,
            cameraCalibrationError=camera_error,
            visuallyReviewed=True,metricAccuracyVerified=False)
        fingerprint=hashlib.sha256(json.dumps(court,sort_keys=True).encode()).hexdigest()
        file=path(key,event,index)
        if file.exists():
            old=json.loads(file.read_text());broadcast_objects.atomic(file.parent/'history'/f"{event}-{index}-{old['revision']}.json",old)
        record=dict(frameIndex=index,baseDatasetId=expected_dataset,inputSha256=expected_sha,court=court,
            revision=fingerprint,savedAt=datetime.now(timezone.utc).isoformat())
        broadcast_objects.atomic(file,record)
        return record

def image_signature(result):
    fields=('id','role','pixelBox','keypoints','scores','depth','manualJoints')
    values=[{k:p.get(k) for k in fields} for p in sorted(result['people'],key=lambda p:p['id'])]
    return hashlib.sha256(json.dumps(values,sort_keys=True).encode()).hexdigest()

def carry_image_review(key,event,previous,checkpoint):
    """Carry a user's completed 2D review only if every image observation is identical."""
    import broadcast_pose,pose_jobs,review_flow,broadcast_objects
    with review_flow.LOCK,case_store.LOCK:
        current=broadcast_pose.current(key,event)
        if not current or current['job']['state']!='complete':return False
        if any(current[k]!=previous[k] for k in ('frameIndex','datasetId','inputSha256')):return False
        old=pose_jobs.result(previous['jobId']);new=current['job']['result']
        if image_signature(old)!=image_signature(new):return False
        saved=review_flow.stored(key)
        if saved['events'].get(event,{}).get('joints')!=checkpoint:return False
        if not checkpoint:return False
        base=review_flow.digest([previous[k] for k in ('frameIndex','datasetId','inputSha256')])
        if checkpoint.get('token')!=review_flow.digest([base,previous['jobId'],previous.get('reviewedPeople',{})]):return False
        current.pop('job');current['reviewedPeople']=copy.deepcopy(previous.get('reviewedPeople',{}))
        current['imageReviewCarriedFrom']=previous['jobId']
        pose_jobs.write(broadcast_pose.path(key,event),current)
        e=next(e for e in case_store.load_case(key)['events'] if e['id']==event)
        state=review_flow.event_state(key,e,saved['events'][event])
        saved['events'][event]['joints']={**checkpoint,'token':state['stages']['joints']['token'],
            'carriedFromJobId':previous['jobId'],'reason':'identical reviewed 2D observations; court-only reconstruction'}
        broadcast_objects.atomic(review_flow.path(key),saved)
        return True
