"""One immutable private T4 job; stage artifacts then export without credentials."""
import os
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ.setdefault(k,'2')
import collections,hashlib,json,sys,tarfile,time,traceback
from pathlib import Path
import cv2,numpy as np,torch
ROOT=Path.cwd();cv2.setNumThreads(2);torch.set_num_threads(2)

def track(request,folder):
    from basketball_detector import BasketballDetector
    from broadcast_tracking import video,atomic
    from broadcast_frame_processing import classify,court_prediction
    from broadcast_geometry import estimate_court
    event=request['payload']['event'];index=request['payload']['selectedFrame'];source=Path(request['source'])
    detector=BasketballDetector(threads=2,device='cuda',profile_dir=folder/'profiles')
    probe=cv2.VideoCapture(str(source));probe.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=probe.read();probe.release()
    if not ok:raise RuntimeError('CUDA 검증 프레임을 읽지 못했습니다.')
    detector.predict(image)
    profile=detector.session.end_profiling();counts=collections.Counter(e.get('args',{}).get('provider') for e in json.loads(Path(profile).read_text()) if e.get('cat')=='Node')
    if not counts['CUDAExecutionProvider']:raise RuntimeError('CUDA 커널 실행을 확인할 수 없습니다.')
    from work_progress import update
    video(detector,source,folder/'tracks.json',event,index,end_seconds=event.get('broadcastSelection',{}).get('actionWindowSeconds',12),processing=request['payload'].get('processing'),selected_is_broadcast=True,progress=lambda done,total:update('객체·공 추적',done,total,'프레임',folder/'progress.json'))
    packet=json.loads((folder/'tracks.json').read_text());cap=cv2.VideoCapture(str(source));start=time.monotonic()
    role_sha=None;by_frame={f['frameIndex']:f for f in packet['frames']}
    first=min(by_frame);last=max(by_frame);cap.set(cv2.CAP_PROP_POS_FRAMES,first)
    role_done=0
    update('선수·심판·운영 인력 분류',0,len(by_frame),'프레임',folder/'progress.json')
    for at in range(first,last+1):
        ok,image=cap.read()
        if not ok:raise RuntimeError('역할 분류용 원본 프레임을 읽지 못했습니다.')
        if at not in by_frame:continue
        f=by_frame[at]
        role_sha=classify(image,f['boxes'],device='cuda');role_done+=1
        update('선수·심판·운영 인력 분류',role_done,len(by_frame),'프레임',folder/'progress.json')
        if at%90==0:print(f'roles {at-first}/{last-first}',flush=True)
    role_seconds=time.monotonic()-start
    # Precise calibration only at the chosen evidence frame. No static camera
    # assumption is propagated over a panning/cut broadcast sequence.
    f=next(f for f in packet['frames'] if f['frameIndex']==index)
    cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();cap.release()
    update('선택 프레임 코트 기준점 계산',0,1,'프레임',folder/'progress.json')
    start=time.monotonic();raw=court_prediction(image);preds=raw.get('predictions',[])
    points=max(preds,key=lambda p:p.get('confidence',0)).get('keypoints',[]) if preds else []
    court=estimate_court(points,packet['width'],packet['height']);f['court']=court;f['floorPositions']=[]
    atomic(folder/'court-raw.json',raw)
    if not court.get('imageToCourt'):
        from broadcast_court import infer
        court,attempts=infer(image,court_prediction)
        court['recoveryMethod']='same-frame Roboflow retry; original and mirrored input'
        court['requiresVisualReview']=True
        f['court']=court;atomic(folder/'court-recovery-attempts.json',attempts)
    if court['status']=='provisional':
        H=np.array(court['imageToCourt']);w,h=packet['width'],packet['height']
        for b in f['boxes']:
            x,y=b['footpointPixels']
            if y>=.97*h or x<3 or x>w-3 or (.2*w<x<.85*w and y>.86*h):continue
            pos=cv2.perspectiveTransform(np.array([[[x,y]]],np.float64),H)[0,0]
            if np.isfinite(pos).all() and -2<pos[0]<30 and -2<pos[1]<17:f['floorPositions'].append({'id':b['id'],'role':b['roleHint'],'xy':pos.tolist(),'status':'bbox-footpoint-proxy','source':'broadcast','approvedForOcclusion':False})
    packet['roleClassifier']={'modelSha256':role_sha,'device':'cuda'};packet['staffClassSupported']=True
    packet['roleProcessing']={'wallSeconds':role_seconds}
    packet['courtSummary']={'wallSeconds':time.monotonic()-start,'execution':'roboflow-serverless','selectedFrame':index,'status':court['status']}
    packet['executionAudit']={'device':torch.cuda.get_device_name(0),'detectorKernels':dict(counts),'profilingScope':'one real selected frame, same fail-closed CUDA session used for all tracking','roleDevice':'cuda','courtDevice':'roboflow-serverless'}
    packet['datasetId']+='-role-'+role_sha[:12]+f'-f{index}-gpu-v1'
    atomic(folder/'tracks.json',packet)
    return {'trackingSeconds':packet['summary']['wallSeconds'],'roleSeconds':role_seconds,'courtSeconds':packet['courtSummary']['wallSeconds'],'videoSeconds':packet['summary']['videoSeconds'],'sampledFrames':len(packet['frames']),'selectedPeople':len(f['boxes']),'courtStatus':court['status'],'executionAudit':packet['executionAudit']}

def pose(request,folder):
    import pose_jobs
    job=request['jobId'];frame=request['payload']['frame'];path=pose_jobs.folder(job);path.mkdir(parents=True,exist_ok=True)
    pose_jobs.write(path/'status.json',{'jobId':job,'state':'queued'})
    parent=None
    if request['payload'].get('corrected'):
        cap=cv2.VideoCapture(request['source']);cap.set(cv2.CAP_PROP_POS_FRAMES,frame['frameIndex']);ok,image=cap.read();cap.release()
        if not ok:raise RuntimeError('수정 자세의 원본 프레임을 읽지 못했습니다.')
        cv2.imwrite(str(path/'frame.jpg'),image);parent=frame
    pose_jobs.process(job,frame,Path(request['source']),parent)
    s=pose_jobs.status(job)
    if s['state']!='complete':raise RuntimeError(s.get('error','GPU 자세 처리 실패'))
    import shutil
    for name in ['result.json','meshes.json','frame.jpg','fitted.json']:shutil.copyfile(path/name,folder/name)
    r=s['result'];return {'poseSeconds':sum(r['poseSeconds']),'meshSeconds':r['meshBuildSeconds'],'people':len(r['people']),'device':r['device'],'executionAudit':r.get('executionAudit')}

def main():
    p=Path(sys.argv[1]);r=json.loads(p.read_text());folder=p.parent;start=time.monotonic()
    os.environ['KBL_PROGRESS_FILE']=str(folder/'progress.json')
    from work_progress import update
    update('T4 원본 검증')
    result={'jobId':r['jobId'],'inputSha256':r['sha256'],'workerCodeSha256':r['workerCodeSha256'],'state':'failed'}
    try:
        if not torch.cuda.is_available():raise RuntimeError('T4 CUDA 사용 불가')
        with Path(r['source']).open('rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=r['sha256']:raise RuntimeError('전송된 원본 해시 불일치')
        from wide_worker import run as wide_assist
        operations={'tracking':track,'pose':pose,'wide-assist':wide_assist}
        if r['operation'] not in operations:raise ValueError('지원하지 않는 GPU 작업입니다.')
        result.update(operations[r['operation']](r,folder));result['state']='complete'
    except Exception as e:
        # No request URLs, auth values, or arbitrary network exceptions exported.
        result['error']=str(e)[:500] if isinstance(e,(ValueError,RuntimeError)) else type(e).__name__
        traceback.print_exc()
    update('계산 완료' if result['state']=='complete' else '계산 중단',1 if result['state']=='complete' else None,1,'작업')
    result['workerSeconds']=time.monotonic()-start
    (folder/'gpu-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    with tarfile.open(folder/'result.building.tar','w') as tar:
        for name in ['gpu-result.json','tracks.json','court-raw.json','result.json','meshes.json','frame.jpg','fitted.json','wide-result.json','wide-frame.jpg']:
            if (folder/name).exists():tar.add(folder/name,arcname=name)
    (folder/'result.building.tar').replace(folder/'result.tar')
    print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
