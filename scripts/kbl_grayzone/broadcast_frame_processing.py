"""Exact selected-frame inference; immutable supplement to existing clip tracks.

People/ball detection and the trained role head run locally. Court landmarks use
the same public Roboflow court model on the selected image, never a nearby frame.
IDs in this supplement are anonymous frame-local detections, not new trajectories.
"""
import base64,hashlib,json,os,ssl,time,urllib.error,urllib.parse,urllib.request
from pathlib import Path
import cv2,numpy as np
import case_store
from basketball_detector import BasketballDetector
from broadcast_tracking import detect
from broadcast_geometry import estimate_court

ROOT=Path(__file__).resolve().parents[2]
COURT_MODEL='basketball-court-detection-2/14'
DETECTOR=None
ROLE_MODEL=None

class CourtCalibrationRequired(RuntimeError):
    """Tracking is saved, but this exact frame needs court calibration review."""

def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,allow_nan=False));tmp.replace(path)

def court_prediction(image,confidence=30):
    import certifi
    env=ROOT/'runtime/kbl-cv/roboflow.env'
    key=next((s.split('=',1)[1].strip().strip('\"\'') for s in env.read_text().splitlines() if s.startswith('ROBOFLOW_API_KEY=')),'') if env.exists() else ''
    if not key:raise RuntimeError('코트 재추론용 Roboflow 키가 없습니다. roboflow.env를 설정한 뒤 재시작하세요.')
    url='https://serverless.roboflow.com/'+COURT_MODEL+'?'+urllib.parse.urlencode({'api_key':key,'confidence':confidence})
    body=base64.b64encode(cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,95])[1])
    request=urllib.request.Request(url,data=body,headers={'Content-Type':'application/x-www-form-urlencoded'},method='POST')
    try:
        with urllib.request.urlopen(request,context=ssl.create_default_context(cafile=certifi.where()),timeout=90) as response:return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'코트 모델 응답 오류 ({exc.code}). 연결·모델 권한을 확인한 뒤 재시도하세요.') from None
    except Exception:
        # Never expose URLs, keys, response bodies or request exceptions.
        raise RuntimeError('코트 모델 연결이 중단됐습니다. 인터넷 연결을 확인한 뒤 재시도하세요.') from None

def classify(image,boxes,device='cpu'):
    global ROLE_MODEL
    import torch
    from PIL import Image
    from train_broadcast_roles import tensor,LABELS,THRESHOLD
    torch.set_num_threads(3)
    model_root=ROOT/'outputs/kbl-broadcast-20261025/role-learning'
    metadata=json.loads((model_root/'training.json').read_text())
    if ROLE_MODEL is None:
        path=model_root/'role-resnet18.pt'
        if hashlib.sha256(path.read_bytes()).hexdigest()!=metadata['modelSha256']:raise RuntimeError('역할 분류 모델 검증 실패')
        ROLE_MODEL=torch.jit.load(str(path),map_location=device).eval()
    h,w=image.shape[:2]
    # Small batches keep memory bounded on the review laptop.
    for offset in range(0,len(boxes),4):
        group=boxes[offset:offset+4];batch=[]
        for b in group:
            x1,y1,x2,y2=[round(v*s) for v,s in zip(b['box'],[w,h]*2)]
            x1=max(0,min(w-1,x1));y1=max(0,min(h-1,y1));x2=max(x1+1,min(w,x2));y2=max(y1+1,min(h,y2))
            batch.append(tensor(Image.fromarray(cv2.cvtColor(image[y1:y2,x1:x2],cv2.COLOR_BGR2RGB))))
        with torch.inference_mode():probabilities=torch.softmax(ROLE_MODEL(torch.stack(batch).to(device)),1).cpu().numpy()
        for b,p in zip(group,probabilities):
            b.update(roleHint=LABELS[int(p.argmax())] if p.max()>=THRESHOLD else 'unknown',
                roleProbabilities=dict(zip(LABELS,map(float,p))),roleConfidence=float(p.max()),roleSource='trained-broadcast-crop-head')
    return metadata['modelSha256']

def prepare(case_id,event_id,index,stage=lambda message:None):
    global DETECTOR
    case=case_store.load_case(case_id);event=next(e for e in case['events'] if e['id']==event_id)
    import gpu_bridge
    import object_cache
    expected=object_cache.contract(gpu_bridge.config() if gpu_bridge.enabled() else {},event,index,ROOT)
    def reviewed():
        folder=case_store.CASES[case_id]/'broadcast-objects'/event_id
        return folder.exists() and any(folder.glob('*/current.json'))
    def preserve_review():
        if expected is not None and reviewed():
            raise RuntimeError('기존 수동 객체 검수가 있어 자동 재처리를 중단했습니다. 기존 검수와 리포트는 보존됩니다. 별도 작업에서 확인하세요.')
    fresh=None
    if not event.get('broadcastTrackingReady'):
        preserve_review()
        fresh=gpu_bridge.tracking(case_id,event_id,index,stage)
    packet=case_store.broadcast_packet(case_id,event_id)
    existing=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    seconds=event.get('broadcastSelection',{}).get('actionWindowSeconds')
    if existing and seconds is not None:
        from action_window import window_frames
        first,end=window_frames(round(event['broadcast']['durationSeconds']*packet['fps']),packet['fps'],index,seconds)
        coverage=packet.get('coverageSeconds',[index/packet['fps'],index/packet['fps']])
        if coverage[0]>first/packet['fps']+.001 or coverage[1]<end/packet['fps']-.001:existing=None
    if existing and fresh is None:object_cache.require_current(packet,expected)
    if not existing and fresh is None:preserve_review()
    if existing and not existing.get('floorPositions'):
        raise CourtCalibrationRequired('선택 프레임의 코트 기준점을 찾지 못했습니다. 객체 추적은 저장됐으며 코트 수동 보정 또는 프레임 재선택이 필요합니다.')
    if existing:return {'frameIndex':index,'reusedExactFrame':fresh is None,'people':len(existing['boxes']),
        'refereeCandidates':sum(p['role']=='referee' for p in existing['floorPositions']),
        **({'seconds':fresh['transferAndWorkerSeconds'],'execution':'T4'} if fresh else {})}
    if fresh:raise CourtCalibrationRequired('선택 프레임의 코트 보정이 부족합니다. 코트가 보이는 프레임을 선택하세요. 객체 추적 결과는 저장됐습니다.')
    if gpu_bridge.enabled():
        result=gpu_bridge.tracking(case_id,event_id,index,stage)
        packet=case_store.broadcast_packet(case_id,event_id);f=next(f for f in packet['frames'] if f['frameIndex']==index)
        if not f.get('floorPositions'):raise CourtCalibrationRequired('선택 프레임의 코트 보정이 부족합니다. 코트가 보이는 프레임을 선택하세요. 객체 추적 결과는 저장됐습니다.')
        return {'frameIndex':index,'reusedExactFrame':False,'people':len(f['boxes']),'floorPeople':len(f['floorPositions']),'seconds':result['transferAndWorkerSeconds'],'execution':'T4'}
    if os.environ.get('KBL_GPU_WORKER')!='1' and os.environ.get('KBL_ALLOW_LOCAL_INFERENCE')!='1':
        raise RuntimeError('T4 연결이 필요합니다. 로컬 고부하 추론은 실행하지 않으며 저장된 결과는 유지됩니다.')
    started=time.monotonic();source=case_store.CASES[case_id]/'broadcast'/event['broadcast']['file']
    with source.open('rb') as f:source_hash=hashlib.file_digest(f,'sha256').hexdigest()
    if source_hash!=packet['inputSha256']:raise RuntimeError('원본 영상 해시가 변경됐습니다.')
    cap=cv2.VideoCapture(str(source));cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();decoded=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;cap.release()
    if not ok or decoded!=index:raise RuntimeError('선택한 정확한 프레임을 읽지 못했습니다.')
    h,w=image.shape[:2]
    if (w,h)!=(packet['width'],packet['height']):raise RuntimeError('영상 크기가 기존 분석과 다릅니다.')
    stage('선택 프레임의 코트 선 재추론 · Roboflow')
    raw=court_prediction(image);preds=raw.get('predictions',[])
    points=max(preds,key=lambda p:p.get('confidence',0)).get('keypoints',[]) if preds else []
    court=estimate_court(points,w,h)
    if not court.get('imageToCourt'):
        from broadcast_court import infer
        court,attempts=infer(image,court_prediction)
        court['recoveryMethod']='same-frame Roboflow retry; original and mirrored input'
        court['requiresVisualReview']=True
        atomic(case_store.CASES[case_id]/'broadcast-court'/f'{event_id}-{index}-attempts.json',attempts)
    if court['status']!='provisional':raise RuntimeError('이 프레임의 코트 선을 안정적으로 찾지 못했습니다. 코트가 더 잘 보이는 프레임을 선택하거나 수동 보정을 진행해야 합니다.')
    stage('선택 프레임의 선수·심판·공 검출 · 로컬 CPU')
    if DETECTOR is None:DETECTOR=BasketballDetector(threads=3,device='cpu')
    people,balls,full=detect(DETECTOR,image,ball_tiles=True)
    boxes=[]
    for n,p in enumerate(people):
        if p['confidence']<.3:continue
        x1,y1,x2,y2=p['box']
        boxes.append({'id':f'f{index}-d{n+1}','box':[x1/w,y1/h,x2/w,y2/h],
            'confidence':p['confidence'],'publicRoleHint':'referee' if p['class']=='referee' else 'player',
            'footpointPixels':[(x1+x2)/2,y2],'source':'observed','footpointStatus':'bbox-bottom proxy; not ankle-verified'})
    stage('선수·심판·운영 인력 분류 · 학습한 역할 모델')
    role_hash=classify(image,boxes);positions=[];H=np.array(court['imageToCourt'])
    for box in boxes:
        x,y=box['footpointPixels']
        if y>=.97*h or x<3 or x>w-3 or (.20*w<x<.85*w and y>.86*h):continue
        pos=cv2.perspectiveTransform(np.array([[[x,y]]],np.float64),H)[0,0]
        if not np.isfinite(pos).all() or not (-2<pos[0]<30 and -2<pos[1]<17):continue
        positions.append({'id':box['id'],'role':box['roleHint'],'xy':pos.tolist(),'status':'bbox-footpoint-proxy','source':'broadcast','approvedForOcclusion':False})
    if not any(p['role'] in ('player','referee') for p in positions):raise RuntimeError('자세를 계산할 선수·심판의 코트 좌표가 부족합니다. 다른 프레임을 선택하세요.')
    credible=[b for b in balls if b['confidence']>=.45]
    frame={'frameIndex':index,'t':index/packet['fps'],'boxes':boxes,'rawPeople':people,'court':court,'floorPositions':positions,
        'ballCandidates':balls,'ball':credible[0] if len(credible)==1 else None,'ballStatus':'candidate-unverified' if len(credible)==1 else 'ambiguous' if credible else 'missing',
        'fullFrameBallCount':len(full),'ballTiles':True,'idScope':'selected-frame-only; no temporal identity assignment'}
    processing={'method':'exact-frame detector + trained role head + court model','wallSeconds':time.monotonic()-started,
        'detector':DETECTOR.execution,'roleModelSha256':role_hash,'courtModel':COURT_MODEL,'courtExecution':'roboflow-serverless',
        'framePixelsSha256':hashlib.sha256(image.tobytes()).hexdigest(),'temporalTrackingRebuilt':False}
    extension={'inputSha256':packet['inputSha256'],'baseDatasetId':packet['datasetId'],'frame':frame,'processing':processing}
    fingerprint=hashlib.sha256(json.dumps(extension,sort_keys=True).encode()).hexdigest()[:16]
    extension['datasetId']=packet['datasetId']+'-frame-'+fingerprint
    atomic(case_store.CASES[case_id]/'broadcast-frames'/f'{event_id}-{index}.json',extension)
    return {'frameIndex':index,'reusedExactFrame':False,'people':len(boxes),'floorPeople':len(positions),
        'refereeCandidates':sum(p['role']=='referee' for p in positions),'seconds':processing['wallSeconds']}
