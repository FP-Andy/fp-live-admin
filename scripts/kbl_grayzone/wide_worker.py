"""Bounded secondary-camera detector/pose job. Runs only inside the T4 worker."""
import json,time
import cv2,numpy as np
from pathlib import Path

def run(request,folder):
    from basketball_detector import BasketballDetector
    from broadcast_tracking import people_nms
    from broadcast_frame_processing import classify,court_prediction,atomic
    from broadcast_geometry import estimate_court
    from broadcast_pose import camera_inputs
    from multiview_geometry import align,search_score
    from work_progress import update
    import pose_jobs
    payload=request['payload'];index=payload['frameIndex'];cap=cv2.VideoCapture(request['source'])
    fps=cap.get(cv2.CAP_PROP_FPS);total=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));start=time.monotonic()
    manifest=Path('runtime/kbl-cv/models/kbl-refree-v1/manifest.json') if payload.get('wideModel') else None
    detector=BasketballDetector(threads=2,device='cuda',model_manifest=manifest);frames=[];audits=[]
    if payload.get('wideModel') and detector.execution['modelSha256']!=payload['wideModel']['sha256']:raise ValueError('요청한 광각 모델과 실행 모델이 다릅니다.')
    sweeping=bool(payload.get('searchFrames'))
    if sweeping and len(payload['searchFrames'])>150:raise ValueError('광각 탐색 프레임 수 제한')
    # Numeric clock evidence fixes the chosen time. Geometry may not move it
    # several seconds to obtain an easier player match.
    indices=list(range(total)) if sweeping else [index]
    if sweeping and total!=len(payload['searchFrames']):raise ValueError('광각 탐색 프레임 목록 불일치')
    def read(at):
        cap.set(cv2.CAP_PROP_POS_FRAMES,at);ok,im=cap.read()
        if not ok or round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1!=at:raise RuntimeError('광각 기준 프레임 읽기 실패')
        if abs(im.shape[1]/im.shape[0]-16/9)>.02:raise RuntimeError('광각 영상의 화면 비율을 확인하세요.')
        return cv2.resize(im,(1920,1080))
    image=read(index);update('광각 코트 기준점 계산',0,1,'프레임')
    from wide_court import infer
    court,attempts=infer(image,court_prediction);atomic(folder/'court-raw.json',attempts)
    if not court.get('imageToCourt'):
        atomic(folder/'wide-result.json',{'state':'court-unresolved','people':[],'positions':[],'court':court})
        cap.release();return {'wideState':'court-unresolved','workerSeconds':time.monotonic()-start}
    H=np.array(court['imageToCourt'])
    for n,at in enumerate(indices):
        update('광각 인물 검출·중계 배치 대조',n,len(indices),'프레임');im=read(at);detections=[]
        # Overlapping halves preserve small far-side people without a full-video pass.
        for x1,x2 in [(0,1920),(0,1120),(800,1920)]:
            detections.extend(detector.predict(im[:,x1:x2],(x1,0),threshold=.35))
        boxes=[]
        for i,p in enumerate(people_nms(detections)):
            x1,y1,x2,y2=p['box']
            if y2-y1<22:continue
            boxes.append({'id':f'f{at}-p{i}','box':[x1/1920,y1/1080,x2/1920,y2/1080],
                'confidence':p['confidence'],'footpointPixels':[(x1+x2)/2,y2],
                'roleHint':p['class'],'roleConfidence':p['confidence']})
        if not manifest:classify(im,boxes,device='cuda')
        positions=[]
        for b in boxes:
            if b['roleHint'] not in ('player','referee') or b['roleConfidence']<(.45 if manifest else .65):continue
            x,y=b['footpointPixels']
            if y>=1065 or x<4 or x>1916:continue
            xy=cv2.perspectiveTransform(np.array([[[x,y]]],float),H)[0,0]
            if np.isfinite(xy).all() and -1.5<=xy[0]<=29.5 and -1.5<=xy[1]<=16.5:
                positions.append({'id':b['id'],'role':b['roleHint'],'xy':xy.tolist()})
        match=align(payload['primaryPositions'],positions)
        audits.append({'frameIndex':at,'boxes':boxes,'positions':positions,'match':match,
                       'searchScore':search_score(payload['primaryPositions'],positions)})
        if match['state']=='matched':frames.append({'frameIndex':at,'boxes':boxes,'positions':positions,'match':match})
    if sweeping:
        chosen=[]
        for candidate in sorted(audits,key=lambda a:a['searchScore']):
            if candidate['searchScore']>3:continue
            if any(abs(payload['searchFrames'][c['frameIndex']]['globalSeconds']-payload['searchFrames'][candidate['frameIndex']]['globalSeconds'])<15 for c in chosen):continue
            chosen.append(candidate)
            if len(chosen)==3:break
        atomic(folder/'wide-result.json',{'state':'search-candidates','candidates':[{'searchFrameIndex':r['frameIndex'],'score':r['searchScore']} for r in chosen],'court':court,'alignmentAttempts':audits})
        cap.release();return {'wideState':'search-candidates','sampledFrames':len(indices),'workerSeconds':time.monotonic()-start}
    if not frames:
        atomic(folder/'wide-result.json',{'state':'geometry-unresolved','people':[],'positions':[],'court':court,'alignmentAttempts':audits});cap.release()
        return {'wideState':'geometry-unresolved','workerSeconds':time.monotonic()-start}
    best=min(frames,key=lambda f:f['match']['score']);image=read(best['frameIndex']);cap.release()
    boxes={b['id']:b for b in best['boxes']};people=[]
    for p in best['positions']:
        b=boxes[p['id']]
        people.append({'id':p['id'],'role':p['role'],'x':p['xy'][0],'y':p['xy'][1],
            'pixelBox':(np.array(b['box'])*[1920,1080,1920,1080]).tolist(),'roleConfidence':b['roleConfidence'],
            'spatialEligible':True,'imageSource':'wide','sourceFrameIndex':best['frameIndex'],'sourceSha256':request['sha256']})
    _,camera=camera_inputs({'court':court},people)
    update('광각 관절 추정',0,len(people),'명');model,load=pose_jobs.engine()
    xyz,scores,_,xy=model(image,[p['pixelBox'] for p in people])
    for i,p in enumerate(people):p.update(keypoints=xy[i,:17].tolist(),scores=scores[i,:17].tolist(),depth=xyz[i,:17,2].tolist())
    update('광각 관절 추정',len(people),len(people),'명')
    result={'state':'matched','frameIndex':best['frameIndex'],'fps':fps,'people':people,'positions':best['positions'],
        'match':best['match'],'court':court,'camera':camera,'modelSha256':pose_jobs.MODEL_SHA,
        'inputSha256':request['sha256'],'pixelSize':[1920,1080],'depthMeasured':False,'device':'T4-CUDA'}
    atomic(folder/'wide-result.json',result);cv2.imwrite(str(folder/'wide-frame.jpg'),image)
    return {'wideState':'matched','people':len(people),'workerSeconds':time.monotonic()-start}
