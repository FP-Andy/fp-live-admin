"""Local, single-worker pose queue. Immutable frame/revision records; no retracking.

The model session is reused. Each revision bakes its own display/collision mesh.
Client coordinates are explicitly reviewer-supplied inputs, not new detections.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import copy, hashlib, json, math, os, re, subprocess, threading, time, uuid
from fit_pose import PIPELINE_VERSION
from job_store import atomic,now,lease,busy,RecoverableJobError

ROOT=Path(__file__).resolve().parents[2]
STORE=ROOT/'outputs/kbl-pose-frames'
MODEL=ROOT/'runtime/kbl-pose/rtmw3d-x.onnx'
MODEL_SHA='4a289c0e99d47eb595e99679d9d4a2d1def1b4241f9adcbafba44b9ff585ebcd'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='kbl-pose')
LOCK=threading.RLock(); ACTIVE={}; ENGINE=None

def write(path,data):
    atomic(path,data)

def folder(job):
    if not isinstance(job,str) or not re.fullmatch('[a-f0-9]{24}',job):raise ValueError('자세 작업 ID가 올바르지 않습니다.')
    return STORE/job

def status(job):
    p=folder(job)/'status.json'
    if not p.exists():raise ValueError('저장된 자세 작업을 찾을 수 없습니다.')
    data=json.loads(p.read_text())
    if os.environ.get('KBL_GPU_WORKER')!='1' and data['state'] in ('queued','running') and job not in ACTIVE and not busy(folder(job)/'process.lock'):
        return {**data,'state':'interrupted','resumeAvailable':(folder(job)/'recovery.json').exists(),
                'stage':'연결 복구 대기 · 저장된 작업 이어받기 가능'}
    return data

def result(job):
    if status(job)['state']!='complete':raise ValueError('완료된 자세가 필요합니다.')
    return json.loads((folder(job)/'result.json').read_text())

def number(x,lo,hi):
    if isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or not lo<=x<=hi:raise ValueError('좌표 또는 프레임 범위를 확인하세요.')
    return x

def validate(data,clip,scene):
    if not isinstance(data,dict):raise ValueError('프레임 정보가 필요합니다.')
    if data.get('datasetId')!=scene['datasetId'] or data.get('analysisSource')!=scene['analysisSource']:raise RuntimeError('추적 결과가 변경됐습니다. 다시 추정하세요.')
    frame=number(data.get('frameIndex'),0,math.ceil(clip['file_duration_seconds']*clip['fps'])-1)
    if int(frame)!=frame:raise ValueError('정수 프레임 번호가 필요합니다.')
    anchors=data.get('anchors')
    people=data.get('people')
    if not isinstance(people,list) or not 1<=len(people)<=30:raise ValueError('현재 프레임의 선수·심판 1~30명이 필요합니다.')
    clean=[];ids=set()
    for p in people:
        if not isinstance(p,dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,60}',str(p.get('id',''))):raise ValueError('인물 ID를 확인하세요.')
        if p['id'] in ids:raise ValueError('중복 인물 ID입니다.')
        ids.add(p['id'])
        if p.get('role') not in ('player','referee','refA','refB','refC'):raise ValueError('선수와 심판만 자세를 추정합니다.')
        b=p.get('pixelBox')
        if not isinstance(b,list) or len(b)!=4:raise ValueError('인물 검출 상자가 필요합니다.')
        for i,v in enumerate(b):number(v,0,1080 if i%2 else 1920)
        if b[2]-b[0]<4 or b[3]-b[1]<8:raise ValueError('인물 검출 상자가 너무 작습니다.')
        spatial=p.get('spatialEligible') is not False
        if not spatial and (scene['analysisSource']!='broadcast' or p.get('x') is not None or p.get('y') is not None):raise ValueError('영상 관절만 추정할 인물의 코트 좌표는 비워 두세요.')
        clean.append(dict(id=p['id'],role=p['role'],team=p.get('team') if p.get('team') in ('home','away') else 'unknown',x=number(p.get('x'),-4,32) if spatial else None,y=number(p.get('y'),-3,19) if spatial else None,pixelBox=b,poseEligible=True,spatialEligible=spatial,spatialReason=None if spatial else 'floor-position-unresolved'))
    image_only=scene['analysisSource']=='broadcast' and all(not p['spatialEligible'] for p in clean)
    if not isinstance(anchors,list) or (len(anchors)!=9 and not (image_only and anchors==[])):raise ValueError('코트 보정점 9개가 필요합니다.')
    for a in anchors:
        if not isinstance(a,list) or len(a)!=2:raise ValueError('코트 보정점을 확인하세요.')
        number(a[0],-1920,3840);number(a[1],-1080,2160)
    return dict(clipId=clip['id'],datasetId=scene['datasetId'],analysisSource=scene['analysisSource'],frameIndex=int(frame),timestamp=frame/clip['fps'],fps=clip['fps'],anchors=anchors,people=clean,inputMode='manual' if data.get('manual') else 'tracking')

def corrected(parent,edits):
    if not isinstance(edits,dict) or not edits or len(edits)>30:raise ValueError('보정할 인물을 선택하세요.')
    frame=copy.deepcopy(parent);lookup={p['id']:p for p in frame['people']}
    for person,edit in edits.items():
        if person not in lookup or not isinstance(edit,dict):raise ValueError('보정 인물을 확인하세요.')
        p=lookup[person];p.setdefault('rawPrediction',{k:copy.deepcopy(p[k]) for k in ('keypoints','scores','depth')});p.setdefault('manualJoints',{})
        joints=edit.get('joints',{})
        if not isinstance(joints,dict):raise ValueError('관절 보정 형식을 확인하세요.')
        for i,q in joints.items():
            if str(i) not in {str(n) for n in range(5,17)}:raise ValueError('관절 5~16의 이미지 좌표가 필요합니다.')
            if q is None:
                p['keypoints'][int(i)]=copy.deepcopy(p['rawPrediction']['keypoints'][int(i)]);p['manualJoints'].pop(str(i),None);continue
            if not isinstance(q,list) or len(q)!=2:raise ValueError('관절 이미지 좌표가 필요합니다.')
            q=[number(q[0],0,1919),number(q[1],0,1079)];p['keypoints'][int(i)]=q;p['manualJoints'][str(i)]=q
        if 'bodyHeading' in edit:
            p['manualBodyHeading']=None if edit['bodyHeading'] is None else number(edit['bodyHeading'],-math.pi,math.pi)
        if 'arms3D' in edit:
            arms=edit['arms3D']
            if not isinstance(arms,dict) or not set(arms)<=set(('l','r')):raise ValueError('왼팔 또는 오른팔을 선택하세요.')
            p.setdefault('manualArms3D',{})
            for side,target in arms.items():
                if target is None:p['manualArms3D'].pop(side,None);continue
                if not p.get('armRig',{}).get(side):raise ValueError('현재 프레임 자세를 먼저 다시 생성하세요.')
                if not isinstance(target,dict) or set(target)!=set(('elbow','wrist')):raise ValueError('팔꿈치와 손목의 3D 위치가 필요합니다.')
                clean={}
                for joint,q in target.items():
                    if not isinstance(q,list) or len(q)!=3:raise ValueError('3D 관절 좌표 3개가 필요합니다.')
                    clean[joint]=[number(v,-2,2) for v in q]
                from arm_ik import solve_arm
                solved=solve_arm(clean,p['armRig'][side])
                p['manualArms3D'][side]={k:solved[k] for k in ('elbow','wrist')}
    return frame

def reuse_predictions(people,previous):
    """Caller verifies source/frame/model; unchanged crops reuse raw 2D/depth only."""
    out={}
    for p in people:
        old=next((o for o in previous if o['id']==p['id'] and o.get('imageSource','broadcast')==p.get('imageSource','broadcast') and o.get('sourceSha256')==p.get('sourceSha256') and len(o.get('pixelBox',[]))==4 and all(abs(a-b)<.01 for a,b in zip(o['pixelBox'],p['pixelBox']))),None)
        raw=(old or {}).get('rawPrediction')
        if not raw or any(len(raw.get(k,[]))!=17 for k in ('keypoints','scores','depth')):continue
        if any(not isinstance(q,list) or len(q)!=2 for q in raw['keypoints']):continue
        values=raw['scores']+raw['depth']+[v for q in raw['keypoints'] for v in q]
        if not all(type(v) in (int,float) and math.isfinite(v) for v in values):continue
        out[p['id']]=copy.deepcopy(raw)
    return out

def submit(data,clip,scene,media,camera_override=None,preserved_people=None,reusable_people=None,reuse_source=None,trusted_people=None,trusted_images=None):
    parent=None
    if data.get('parentId'):
        parent=result(data['parentId'])
        if parent['clipId']!=clip['id'] or parent['datasetId']!=scene['datasetId'] or parent['analysisSource']!=scene['analysisSource']:raise RuntimeError('다른 영상 또는 추적 버전의 자세입니다.')
        if data.get('rebuild') is True:
            if parent.get('pipelineVersion')==PIPELINE_VERSION:raise ValueError('이미 최신 자세 변환 결과입니다.')
            frame=copy.deepcopy(parent)
        else:frame=corrected(parent,data.get('edits'))
    else:
        frame=validate(data,clip,scene)
        if trusted_images:frame['sourceImages']=copy.deepcopy(trusted_images)
        trusted={p['id']:p for p in (trusted_people or [])}
        for p in frame['people']:
            source=trusted.get(p['id'],{})
            for key in ('imageSource','sourceImageUrl','sourceSha256','widePose','cameraOverride'):
                if key in source:p[key]=copy.deepcopy(source[key])
        if camera_override is not None:frame['cameraOverride']=camera_override
        frame['reusedPredictions']=reuse_predictions(frame['people'],reusable_people or [])
        for p in frame['people']:
            if p.get('imageSource')=='wide':
                raw=p.get('widePose')
                if raw and raw.get('sourceSha256')==p.get('sourceSha256') and all(abs(a-b)<.01 for a,b in zip(raw['pixelBox'],p['pixelBox'])):
                    frame['reusedPredictions'].setdefault(p['id'],{k:copy.deepcopy(raw[k]) for k in ('keypoints','scores','depth')})
                elif p.get('sourceImageUrl') not in frame.get('sourceImages',{}):
                    raise ValueError('광각 인물의 원본 이미지가 필요합니다.')
        # Trusted server-side prior results only; never accept this from API input.
        frame['preservedManual']={}
        for p in frame['people']:
            old=next((o for o in (preserved_people or []) if o['id']==p['id']
                and all(abs(a-b)<.01 for a,b in zip(o['pixelBox'],p['pixelBox']))),None)
            if old:
                spatial_match=old['role']==p['role'] and p['spatialEligible'] and old.get('spatialEligible',True) and math.hypot(old['x']-p['x'],old['y']-p['y'])<.001
                keep={k:copy.deepcopy(old[k]) for k in (('manualJoints','manualArms3D','manualBodyHeading') if spatial_match else ('manualJoints',)) if old.get(k) is not None}
                if keep:frame['preservedManual'][p['id']]=keep
    with Path(media).open('rb') as f:source_sha=hashlib.file_digest(f,'sha256').hexdigest()
    if scene.get('inputSha256') and scene['inputSha256']!=source_sha:raise RuntimeError('자세 원본 영상이 변경됐습니다.')
    frame['inputSha256']=source_sha
    if reuse_source and reuse_source.get('inputSha256')==source_sha:frame['meshReuseSource']=copy.deepcopy(reuse_source)
    elif parent:frame['meshReuseSource']={'jobId':parent['jobId'],'inputSha256':source_sha}
    # Persistent idempotency survives API restarts; model/source identity is explicit.
    fingerprint=hashlib.sha256(json.dumps(dict(frame=frame,parent=data.get('parentId'),pipelineVersion=PIPELINE_VERSION,modelSha256=MODEL_SHA),sort_keys=True,separators=(',',':')).encode()).hexdigest()
    with LOCK:
        for saved in STORE.glob('*/status.json'):
            s=json.loads(saved.read_text())
            if s.get('fingerprint')!=fingerprint or s['state']=='failed':continue
            if s['state']=='complete':return s
            if not (saved.parent/'recovery.json').exists():continue
            return resume(s['jobId'])
        if sum(status(j)['state'] in ('queued','running') for j in ACTIVE)>=3:raise RuntimeError('자세 작업이 진행 중입니다. 완료 후 다시 시도하세요.')
        job=uuid.uuid4().hex[:24];path=folder(job);path.mkdir(parents=True)
        frame.update(jobId=job,parentId=data.get('parentId'),revision=(parent.get('revision',0)+1 if parent else 1))
        s=dict(jobId=job,state='queued',stage='분석 대기',fingerprint=fingerprint,clipId=clip['id'],frameIndex=frame['frameIndex'],createdAt=now())
        write(path/'request.json',frame);write(path/'status.json',s)
        write(path/'recovery.json',{'media':str(Path(media).resolve()),'inputSha256':source_sha,'parentId':data.get('parentId')})
        ACTIVE[job]=True;POOL.submit(process,job,frame,media,parent)
        return s

def resume(job):
    with LOCK:
        s=status(job)
        if s['state']=='complete' or job in ACTIVE or busy(folder(job)/'process.lock'):return s
        p=folder(job);recovery=p/'recovery.json'
        if not recovery.exists():raise RuntimeError('이전 버전 작업입니다. 저장된 프레임에서 재처리를 시작하세요.')
        r=json.loads(recovery.read_text());media=Path(r['media'])
        with media.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=r['inputSha256']:raise RuntimeError('원본이 변경되어 중단된 자세를 이어받을 수 없습니다.')
        frame=json.loads((p/'request.json').read_text());parent=result(r['parentId']) if r.get('parentId') else None
        s.update(state='queued',stage='저장된 자세 작업 이어받기',resumedAt=now());s.pop('error',None);write(p/'status.json',s)
        ACTIVE[job]=True;POOL.submit(process,job,frame,media,parent)
        return s

def engine():
    global ENGINE
    if ENGINE is not None:return ENGINE,0
    start=time.perf_counter()
    if hashlib.sha256(MODEL.read_bytes()).hexdigest()!=MODEL_SHA:raise RuntimeError('자세 모델 파일 검증에 실패했습니다.')
    import onnxruntime as ort
    import numpy as np
    from rtmlib import RTMPose3d
    opt=ort.SessionOptions();opt.intra_op_num_threads=2;opt.inter_op_num_threads=1
    cuda=os.environ.get('KBL_POSE_DEVICE')=='cuda'
    if cuda:
        import torch
        if not torch.cuda.is_available() or 'CUDAExecutionProvider' not in ort.get_available_providers():raise RuntimeError('자세 CUDA 환경을 확인하세요.')
        opt.enable_profiling=True;opt.profile_file_prefix=str(STORE/'pose-cuda')
    pose=object.__new__(RTMPose3d);pose.session=ort.InferenceSession(str(MODEL),sess_options=opt,providers=['CUDAExecutionProvider','CPUExecutionProvider'] if cuda else ['CPUExecutionProvider'])
    if cuda and 'CUDAExecutionProvider' not in pose.session.get_providers():raise RuntimeError('자세 CUDA 초기화 실패 · CPU 대체 실행 차단')
    pose.session.disable_fallback()
    pose.model_input_size=(288,384);pose.mean=np.array((123.675,116.28,103.53));pose.std=np.array((58.395,57.12,57.375));pose.z_range=2.1744869;pose.to_openpose=False;pose.backend='onnxruntime';ENGINE=pose
    return pose,time.perf_counter()-start

def image_only_assets(frame,path):
    """Keep the usual immutable artifact contract with explicitly empty geometry."""
    if not frame['people'] or any(p.get('spatialEligible',True) for p in frame['people']):
        raise ValueError('코트 위치가 있는 인물은 공간 자세 처리 과정이 필요합니다.')
    digest=hashlib.sha256(b'{}').hexdigest()
    write(path/'meshes.json',dict(schema='kbl-mpfb-mesh/v1',id='image-only-'+frame['jobId'],
          geometrySha256=digest,assets={},generator='RTMW3D image keypoints; no 3D geometry'))
    return dict(frame,model='RTMW3D-X 384x288',modelSha256=MODEL_SHA,poseSource='image-only-inferred',
                depthMeasured=False,poseMeasured=False,meshSha256=digest,meshBuildSeconds=0,
                limitations=['Image keypoints only; court coordinates unresolved',
                             'No camera calibration, 3D geometry, or occlusion result'])

def mesh_build_outputs(path,clip_id,completed):
    row=path/(clip_id+'.json');meshes=path/(clip_id+'-meshes.json')
    if completed.returncode or not row.is_file() or not meshes.is_file():
        raise RuntimeError('인체 메시 생성 실패. 저장된 이전 자세는 유지됩니다.')
    return row,meshes

def process(job,frame,media,parent):
    try:
        with lease(folder(job)/'process.lock') as acquired:
            if acquired:_process(job,copy.deepcopy(frame),media,parent)
    finally:
        with LOCK:ACTIVE.pop(job,None)

def _process(job,frame,media,parent):
    path=folder(job);s=status(job);start=time.perf_counter()
    def stage(label):
        ticket=path/'transport.json'
        if ticket.exists():
            transport=json.loads(ticket.read_text())
            if transport.get('progress'):s['progress']=transport['progress']
        s.update(state='running',stage=label,updatedAt=now());write(path/'status.json',s)
    try:
        from pose_delta import reuse_complete
        reused=reuse_complete(frame,path,STORE,MODEL_SHA,PIPELINE_VERSION)
        if reused:
            reused.update(totalSeconds=time.perf_counter()-start,frameUrl=f'/pose-assets/{job}/frame.jpg',meshUrl=f'/pose-assets/{job}/meshes.json')
            write(path/'result.json',reused)
            s.update(state='complete',stage='변경 없는 자세·인체 재사용 · GPU 재계산 없음',totalSeconds=reused['totalSeconds'],result=reused,completedAt=now());write(path/'status.json',s);return
        import gpu_bridge
        if gpu_bridge.enabled():
            remote=gpu_bridge.pose(job,frame,media,parent,stage)
            row=json.loads((path/'result.json').read_text());row['remoteSeconds']=row['totalSeconds'];row['totalSeconds']=time.perf_counter()-start
            row['transport']=remote;write(path/'result.json',row)
            s.update(state='complete',stage='T4 영상 관절 준비 완료 · 코트 좌표 보정 대기' if row.get('poseSource')=='image-only-inferred' else 'T4 자세·인체 메시 준비 완료',totalSeconds=row['totalSeconds'],result=row,completedAt=now());write(path/'status.json',s)
            return
        if os.environ.get('KBL_GPU_WORKER')!='1' and os.environ.get('KBL_ALLOW_LOCAL_INFERENCE')!='1':
            raise RuntimeError('T4 연결이 필요합니다. 로컬 고부하 추론은 실행하지 않으며 저장된 결과는 유지됩니다.')
        import cv2
        from fit_pose import fit
        cv2.setNumThreads(1);stage('원본 프레임 읽는 중')
        if parent:
            import shutil
            if folder(parent['jobId'])!=path:shutil.copyfile(folder(parent['jobId'])/'frame.jpg',path/'frame.jpg')
            frame['poseSeconds']=[];frame['loadSeconds']=0
        else:
            cap=cv2.VideoCapture(str(media));cap.set(cv2.CAP_PROP_POS_FRAMES,frame['frameIndex']);ok,img=cap.read();decoded=int(round(cap.get(cv2.CAP_PROP_POS_FRAMES)))-1;cap.release()
            if not ok or decoded!=frame['frameIndex'] or img.shape[:2]!=(1080,1920):raise RuntimeError('요청한 원본 프레임을 읽지 못했습니다.')
            cv2.imwrite(str(path/'frame.jpg'),img)
            reused=frame.pop('reusedPredictions',{});pending=[p for p in frame['people'] if p['id'] not in reused]
            frame['poseSeconds']=[];frame['loadSeconds']=0;frame['reusedPredictionCount']=len(reused);frame['inferredPredictionCount']=len(pending)
            if pending:
                stage('RTMW3D 관절 추정 · '+('T4 CUDA' if os.environ.get('KBL_POSE_DEVICE')=='cuda' else '로컬 CPU'))
                from work_progress import update
                update('관절 추정',0,len(pending),'명')
                model,load=engine();t=time.perf_counter()
                for source_key in dict.fromkeys(p.get('sourceImageUrl') if p.get('imageSource')=='wide' else None for p in pending):
                    group=[p for p in pending if (p.get('sourceImageUrl') if p.get('imageSource')=='wide' else None)==source_key]
                    source_image=img
                    if source_key:
                        import base64,numpy as np
                        raw=frame.get('sourceImages',{}).get(source_key)
                        if not raw:raise RuntimeError('광각 관절 원본이 누락됐습니다.')
                        content=base64.b64decode(raw['base64'],validate=True)
                        if hashlib.sha256(content).hexdigest()!=raw['sha256']:raise RuntimeError('광각 관절 원본 해시 불일치')
                        source_image=cv2.imdecode(np.frombuffer(content,np.uint8),cv2.IMREAD_COLOR)
                        if source_image is None or source_image.shape[:2]!=(1080,1920):raise RuntimeError('광각 관절 이미지 규격 불일치')
                    xyz,scores,_,xy=model(source_image,[p['pixelBox'] for p in group])
                    for i,p in enumerate(group):p.update(keypoints=xy[i,:17].tolist(),scores=scores[i,:17].tolist(),depth=xyz[i,:17,2].tolist())
                frame['poseSeconds']=[time.perf_counter()-t];frame['loadSeconds']=load
                update('관절 추정',len(pending),len(pending),'명')
                if os.environ.get('KBL_POSE_DEVICE')=='cuda':
                    from collections import Counter
                    events=json.loads(Path(model.session.end_profiling()).read_text())
                    counts=Counter(e.get('args',{}).get('provider') for e in events if e.get('cat')=='Node')
                    if not counts['CUDAExecutionProvider']:raise RuntimeError('자세 CUDA 커널 실행 증거가 없습니다.')
                    frame['executionAudit']={'providers':model.session.get_providers(),'kernels':dict(counts)}
            for p in frame['people']:
                if p['id'] in reused:p.update(copy.deepcopy(reused[p['id']]))
                p['rawPrediction']={k:copy.deepcopy(p[k]) for k in ('keypoints','scores','depth')}
                manual=frame.get('preservedManual',{}).get(p['id'],{})
                p.update(copy.deepcopy(manual))
                for joint,point in manual.get('manualJoints',{}).items():p['keypoints'][int(joint)]=copy.deepcopy(point)
        image_only=not any(p.get('spatialEligible',True) for p in frame['people'])
        stage('영상 관절 검증 · 코트 좌표 보정 대기' if image_only else '관절 검증 · MPFB 인체 메시 생성')
        frame=fit(frame);frame['device']='T4-CUDA' if os.environ.get('KBL_POSE_DEVICE')=='cuda' else 'local-cpu';frame['manualJointCount']=sum(len(p.get('manualJoints',{})) for p in frame['people']);frame['manualArmCount']=sum(len(p.get('manualArms3D',{})) for p in frame['people'])
        write(path/'fitted.json',dict(model='RTMW3D-X 384x288',modelSha256=MODEL_SHA,frames=[frame]))
        if image_only:row=image_only_assets(frame,path)
        else:
            blender=Path(os.environ.get('KBL_BLENDER',str(ROOT/'runtime/kbl-mpfb/Blender.app/Contents/MacOS/Blender')))
            env=dict(os.environ,BLENDER_USER_CONFIG=str(ROOT/'runtime/kbl-mpfb/blender-config'))
            with (path/'build.log').open('w') as log:
                run=subprocess.run([str(blender),'-b','-t','2','--python-exit-code','1','--python',str(ROOT/'scripts/kbl_grayzone/build_pose_assets.py'),'--','--input',str(path/'fitted.json'),'--output',str(path),'--revision',job],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
            row_path,meshes_path=mesh_build_outputs(path,frame['clipId'],run)
            row=json.loads(row_path.read_text())
            meshes_path.replace(path/'meshes.json')
        row['totalSeconds']=time.perf_counter()-start
        row['frameUrl']=f'/pose-assets/{job}/frame.jpg';row['meshUrl']=f'/pose-assets/{job}/meshes.json'
        write(path/'result.json',row)
        s.update(state='complete',stage='자세 준비 완료',totalSeconds=row['totalSeconds'],result=row,completedAt=now());write(path/'status.json',s)
    except RecoverableJobError as e:
        s.update(state='interrupted',stage='연결 복구 대기',error=str(e),resumeAvailable=True,updatedAt=now());write(path/'status.json',s)
    except Exception as e:
        s.update(state='failed',stage='자세 작업 실패',error=str(e)[:500]);write(path/'status.json',s)
