"""Private SSH job transport to the existing T4; no public inference endpoint.

Local code uploads registered media/requests only. The remote single-worker lock
serializes tracking and pose jobs. Failures never fall back to laptop inference.
"""
import copy,hashlib,json,os,shlex,subprocess,time,uuid
from pathlib import Path
from job_store import atomic,digest,now,lease,RecoverableJobError
ROOT=Path(__file__).resolve().parents[2]
CONFIG=ROOT/'runtime/kbl-cv/gpu.json'

def enabled():return CONFIG.is_file() and os.environ.get('KBL_GPU_DISABLED')!='1' and os.environ.get('KBL_GPU_WORKER')!='1'
def config():
    if not enabled():raise RuntimeError('T4 작업 연결 설정이 없습니다. GPU 워커를 준비하세요.')
    return json.loads(CONFIG.read_text())
def call(args,timeout=1800,log=None):
    result=subprocess.run(args,cwd=ROOT,stdout=log or subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    if result.returncode:raise RuntimeError('T4 작업 전송 또는 실행이 실패했습니다. GPU 상태와 작업 로그를 확인하세요.')
    return result.stdout.decode() if result.stdout else ''
def multiplex_options():
    import stat
    folder=Path('/tmp')/f'courtside-gpu-{os.getuid()}'
    try:
        folder.mkdir(mode=0o700,exist_ok=True);info=folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:return []
        return ['-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(folder/'ctl-%C')]
    except OSError:return []
def ssh(c,command,**kw):return call(['ssh','-F',c['sshConfig'],*multiplex_options(),'-o','BatchMode=yes','-o','ConnectTimeout=12',c['host'],command],**kw)
def scp(c,source,dest,**kw):return call(['scp','-q','-F',c['sshConfig'],*multiplex_options(),str(source),str(dest)],**kw)
def scp_many(c,sources,dest,**kw):
    """Transfer a job's immutable dispatch files over one SCP connection."""
    return call(['scp','-q','-F',c['sshConfig'],*multiplex_options(),*[str(p) for p in sources],str(dest)],**kw)
def ensure_running(c,stage):
    if not c.get('instanceId'):return
    import boto3
    client=boto3.client('ec2',region_name=c['region'])
    def state():return client.describe_instances(InstanceIds=[c['instanceId']])['Reservations'][0]['Instances'][0]['State']['Name']
    current=state()
    if current in ('stopped','stopping') and not c.get('autoStart',True):raise RuntimeError('사용자 요청으로 T4가 중지되어 있습니다. GPU를 다시 켠 뒤 재처리하세요. 저장된 결과는 계속 사용할 수 있습니다.')
    if current=='stopped':
        stage('기존 T4 시작 중 · 새 인스턴스를 만들지 않습니다')
        client.start_instances(InstanceIds=[c['instanceId']]);current='pending'
    end=time.monotonic()+240
    while current in ('pending','stopping') and time.monotonic()<end:
        time.sleep(5);current=state()
        if current=='stopped':client.start_instances(InstanceIds=[c['instanceId']]);current='pending'
    if current!='running':raise RuntimeError('T4가 실행 상태가 아닙니다. 저장된 선택은 유지됩니다.')
    while time.monotonic()<end:
        try:ssh(c,'docker info >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1',timeout=20);return
        except (RuntimeError,subprocess.TimeoutExpired):time.sleep(5)
    raise RuntimeError('T4 연결 준비가 지연되고 있습니다. 잠시 후 재처리하세요.')
def upload(c,media,sha,metrics=None):
    import re
    if not isinstance(sha,str) or not re.fullmatch(r'[a-f0-9]{64}',sha):raise ValueError('T4 원본 해시를 확인하세요.')
    metrics=metrics if metrics is not None else {}
    target=c['workspace']+'/media/'+sha+'.mp4'
    started=time.monotonic()
    found=ssh(c,'sha256sum '+shlex.quote(target)+' 2>/dev/null || true').split()
    valid=bool(found and found[0]==sha)
    metrics['mediaCheckSeconds']=round(time.monotonic()-started,3);metrics['mediaCacheHit']=valid
    if not valid:
        # A newly provisioned isolated worker may not have a media cache yet.
        # Create only this dedicated directory before attempting the transfer.
        ssh(c,'mkdir -p '+shlex.quote(c['workspace']+'/media'))
        temporary=target+'.upload-'+uuid.uuid4().hex
        published=False
        try:
            started=time.monotonic()
            scp(c,media,c['host']+':'+temporary)
            metrics['mediaTransferSeconds']=round(time.monotonic()-started,3);started=time.monotonic()
            # Publish only the verified transfer. A broken cache remains in
            # place until a complete, independent replacement is available.
            transferred=ssh(c,'sha256sum '+shlex.quote(temporary)+' 2>/dev/null || true').split()
            if not transferred or transferred[0]!=sha:raise RuntimeError('T4 원본 전송을 검증하지 못했습니다. 다시 시도하세요.')
            ssh(c,'mv -f '+shlex.quote(temporary)+' '+shlex.quote(target))
            published=True
            metrics['mediaPublishSeconds']=round(time.monotonic()-started,3)
        finally:
            if not published:
                try:ssh(c,'rm -f '+shlex.quote(temporary),timeout=20)
                except (RuntimeError,subprocess.TimeoutExpired,OSError):pass
    return '/workspace/media/'+sha+'.mp4'

def ensure_wide_model(c):
    """Stage the already-owned, hash-pinned wide detector once; no training."""
    local=ROOT/'runtime/kbl-cv/models/kbl-refree-v1';meta=json.loads((local/'manifest.json').read_text())
    target=c['workspace']+'/runtime/kbl-cv/models/kbl-refree-v1';model=target+'/'+meta['onnxFile']
    current=ssh(c,'sha256sum '+shlex.quote(model)+' 2>/dev/null || true',timeout=20).split()
    if not current or current[0]!=meta['sha256']:
        with (local/meta['onnxFile']).open('rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=meta['sha256']:raise ValueError('광각 모델 해시 불일치')
        ssh(c,'mkdir -p '+shlex.quote(target))
        scp(c,local/meta['onnxFile'],c['host']+':'+model+'.upload')
        ssh(c,'mv '+shlex.quote(model+'.upload')+' '+shlex.quote(model))
    scp(c,local/'manifest.json',c['host']+':'+target+'/manifest.json')
    return {'modelId':meta['modelId'],'sha256':meta['sha256']}
def worker_bundle():
    """Only Python source, never runtime credentials or media; activated under job lock."""
    import tarfile
    files=sorted(p for p in (ROOT/'scripts/kbl_grayzone').glob('*.py') if not p.name.startswith('test_'))
    digest=hashlib.sha256()
    for path in files:digest.update(path.name.encode()+b'\0'+path.read_bytes())
    sha=digest.hexdigest();dest=ROOT/'runtime/kbl-cv/worker-code'/f'{sha}.tar.gz';dest.parent.mkdir(parents=True,exist_ok=True)
    if not dest.exists():
        with tarfile.open(dest,'w:gz') as tar:
            for path in files:tar.add(path,arcname=str(path.relative_to(ROOT)))
    return dest,sha
def request_identity(operation,payload,sha):
    # Editorial/roster updates do not change the tracking input.
    if operation=='tracking':
        event=payload['event']
        payload={'selectedFrame':payload['selectedFrame'],'eventId':event['id'],
                 'video':{k:event['broadcast'].get(k) for k in ('fps','frames','width','height','durationSeconds')},
                 'window':event.get('broadcastSelection',{}).get('actionWindowSeconds',12),
                 **({'processing':payload['processing']} if payload.get('processing') else {}),
                 **({'trackingContract':payload['trackingContract']['fingerprint']} if payload.get('trackingContract') else {})}
    return digest({'operation':operation,'inputSha256':sha,'payload':payload})

def runner_script(c,remote,job,cache_job=None):
    q=shlex.quote
    import re
    # A separate staging workspace can share the real worker's lock so its
    # synthetic jobs do not run concurrently with normal T4 jobs.
    worker_lock=c.get('workerLock') or c['workspace']+'/worker.lock'
    from pathlib import PurePosixPath
    if not isinstance(worker_lock,str):raise ValueError('T4 작업 잠금 경로를 확인하세요.')
    lock_path=PurePosixPath(worker_lock)
    if not lock_path.is_absolute() or lock_path.name!='worker.lock' or '..' in lock_path.parts:
        raise ValueError('T4 작업 잠금 경로를 확인하세요.')
    stage_options=[]
    if any(k in c for k in ('stageReadOnlyPoseModel','stageOfflineWorker','stageUser','stageReadOnlyBlender','stageReadOnlyMpfb')):
        work=PurePosixPath(c['workspace'])
        if (os.environ.get('COURTSIDE_GPU_STAGING_MODE')!='1' or not work.is_absolute() or '..' in work.parts
            or not re.fullmatch(r'courtside-stage-[a-f0-9]{24}',work.name) or lock_path.parent==work):
            raise ValueError('격리 T4 시험 작업 공간을 확인하세요.')
        model=c.get('stageReadOnlyPoseModel');user=c.get('stageUser')
        if (not isinstance(model,str) or not PurePosixPath(model).is_absolute() or '..' in PurePosixPath(model).parts
            or not model.endswith('/runtime/kbl-pose/rtmw3d-x.onnx') or any(ch in model for ch in ',\n\r')):
            raise ValueError('시험 자세 모델의 읽기 전용 경로를 확인하세요.')
        if c.get('stageOfflineWorker') is not True or not isinstance(user,str) or not re.fullmatch(r'[0-9]+:[0-9]+',user):
            raise ValueError('격리 T4 시험 권한을 확인하세요.')
        stage_options=['--network','none','--user',user,'-e','HOME=/tmp','-e','PYTHONDONTWRITEBYTECODE=1',
            '--mount','type=bind,src='+model+',dst=/workspace/runtime/kbl-pose/rtmw3d-x.onnx,readonly']
        blender=c.get('stageReadOnlyBlender');mpfb=c.get('stageReadOnlyMpfb')
        if blender is not None or mpfb is not None:
            def safe_path(value):
                return isinstance(value,str) and PurePosixPath(value).is_absolute() and '..' not in PurePosixPath(value).parts and not any(ch in value for ch in ',\n\r')
            if (not safe_path(blender) or not re.fullmatch(r'blender-[0-9][a-zA-Z0-9._-]*-linux-x64',PurePosixPath(blender).name)
                or PurePosixPath(blender).parent.name!='runtime' or not safe_path(mpfb)
                or not mpfb.endswith('/runtime/kbl-mpfb/mpfb2-master')):
                raise ValueError('시험 인체 메시 도구의 읽기 전용 경로를 확인하세요.')
            stage_options.extend(['--mount','type=bind,src='+blender+',dst=/workspace/runtime/blender,readonly',
                                  '--mount','type=bind,src='+mpfb+',dst=/workspace/runtime/kbl-mpfb/mpfb2-master,readonly'])
    docker=['docker','run','--rm',*stage_options,'--gpus','all','--cpus','3','--memory','10g',
        '--name','kbl-job-'+job,'-e','KBL_GPU_WORKER=1','-e','OMP_NUM_THREADS=2','-e','OPENBLAS_NUM_THREADS=2',
        '-e','KBL_POSE_DEVICE=cuda','-e','KBL_BLENDER=/workspace/runtime/blender/blender',
        '-v',c['workspace']+':/workspace','-w','/workspace',c['image'],'python',
        'scripts/kbl_grayzone/gpu_worker.py','/workspace/jobs/'+job+'/request.json']
    # A detached runner survives the API/SSH connection. A second resume either
    # observes this runner's lock or sees its atomically published archive.
    cache=''
    if cache_job:
        if not re.fullmatch('[a-f0-9]{24}',cache_job):raise ValueError('재사용 자세 ID가 올바르지 않습니다.')
        cache_path=c['workspace']+'/outputs/kbl-pose-cache/'+cache_job
        cache=f'mkdir -p {q(cache_path)}\ntar -xzf {q(remote+"/reuse-cache.tar.gz")} -C {q(cache_path)}\n'
    return f'''#!/bin/sh
exec 8>{q(remote+'/dispatch.lock')}
flock -n 8 || exit 0
test ! -f {q(remote+'/result.tar')} || exit 0
set -e
trap 'printf failed > {q(remote+'/phase')}' EXIT
printf queued > {q(remote+'/phase')}
exec 9>{q(worker_lock)}
flock -x 9
printf running > {q(remote+'/phase')}
tar -xzf {q(remote+'/worker-code.tar.gz')} -C {q(c['workspace'])}
{cache}\
{shlex.join(docker)}
test -f {q(remote+'/result.tar')}
printf complete > {q(remote+'/phase')}
trap - EXIT
'''

def execute(operation,payload,media,output,stage=lambda message:None,job_id=None):
    output.mkdir(parents=True,exist_ok=True)
    with lease(output/'transport.lock') as acquired:
        if not acquired:raise RecoverableJobError('같은 T4 작업에 이미 연결 중입니다. 잠시 후 상태를 다시 확인하세요.')
        return _execute(operation,payload,media,output,stage,job_id)

def _execute(operation,payload,media,output,stage,job_id):
    start=time.monotonic();metrics={}
    with Path(media).open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
    metrics['sourceHashSeconds']=round(time.monotonic()-start,3)
    identity=request_identity(operation,payload,sha);ticket_path=output/'transport.json'
    ticket=json.loads(ticket_path.read_text()) if ticket_path.exists() else {}
    if ticket and job_id and ticket.get('identity')!=identity:
        raise RuntimeError('같은 자세 작업 ID의 입력을 바꿀 수 없습니다. 새 개정으로 처리하세요.')
    if ticket and not job_id and ticket.get('identity')!=identity and ticket.get('state') not in ('complete','failed'):
        raise RecoverableJobError('다른 입력의 기존 T4 작업 상태를 먼저 확인하세요. 실행 중인 작업을 바꾸거나 중복 실행하지 않습니다.')
    if ticket.get('identity')!=identity or (ticket.get('state')=='failed' and not job_id):
        ticket={'schema':'kbl-gpu-transport/v2','identity':identity,'jobId':job_id or uuid.uuid4().hex[:24],
                'createdAt':now(),'state':'preparing','inputSha256':sha}
        atomic(ticket_path,ticket)
    if job_id and ticket['jobId']!=job_id:raise RuntimeError('저장된 T4 작업 ID가 요청과 다릅니다.')
    if ticket.get('state')=='complete':
        result=ticket['result']
        validate_result(result,ticket,sha)
        for name,expected in ticket.get('artifacts',{}).items():
            if hashlib.sha256((output/name).read_bytes()).hexdigest()!=expected:raise RuntimeError('저장된 T4 결과가 변경됐습니다.')
        extract_result(output/'gpu-result.tar',output)
        atomic(output/'gpu-result.json',result)
        stage('저장된 T4 결과 재사용 · 재추론 없음')
        return {**result,'reusedTransportResult':True}
    c=config()
    if payload.get('trackingContract'):c={**c,'image':payload['trackingContract']['image']}
    job=ticket['jobId'];remote=c['workspace']+'/jobs/'+job
    try:
        clock=time.monotonic()
        ensure_running(c,stage)
        metrics['readySeconds']=round(time.monotonic()-clock,3)
        if not ticket.get('dispatchedAt'):
            stage('T4로 원본 연결 · 기존 업로드 재사용')
            source=upload(c,media,sha,metrics);clock=time.monotonic();ssh(c,'mkdir -p '+shlex.quote(remote))
            metrics['remoteDirectorySeconds']=round(time.monotonic()-clock,3);clock=time.monotonic()
            # Pin code before dispatch, so a reconnect never changes a running job.
            if not ticket.get('workerCodeSha256'):
                code,code_sha=worker_bundle();ticket['workerCodeSha256']=code_sha;ticket['codeFile']=str(code);atomic(ticket_path,ticket)
            request=dict(operation=operation,source=source,sha256=sha,payload=payload,jobId=job,workerCodeSha256=ticket['workerCodeSha256'])
            local=output/'gpu-request.json';atomic(local,request)
            cache_job=stage_pose_cache(operation,payload,c,remote,output)
            script=output/'runner.sh';script.write_text(runner_script(c,remote,job,cache_job))
            # Names must match the detached runner's immutable inputs. Staging
            # is per-job; an interrupted upload is retried before dispatch.
            import shutil
            staging=output/'dispatch';staging.mkdir(exist_ok=True)
            for src,name in ((Path(ticket['codeFile']),'worker-code.tar.gz'),(local,'request.json'),(script,'runner.sh')):
                shutil.copyfile(src,staging/name)
            metrics['dispatchPrepareSeconds']=round(time.monotonic()-clock,3);clock=time.monotonic()
            scp_many(c,[staging/'worker-code.tar.gz',staging/'request.json',staging/'runner.sh'],c['host']+':'+remote+'/')
            metrics['dispatchTransferSeconds']=round(time.monotonic()-clock,3)
            ticket.update(dispatchedAt=now(),state='submitted');atomic(ticket_path,ticket)
        stage('기존 T4 작업 연결 · 중복 실행 방지')
        clock=time.monotonic()
        ssh(c,'nohup sh '+shlex.quote(remote+'/runner.sh')+' >'+shlex.quote(remote+'/runner.log')+' 2>&1 </dev/null &')
        metrics['launchSeconds']=round(time.monotonic()-clock,3);clock=time.monotonic()
        deadline=time.monotonic()+1800
        while True:
            phase=ssh(c,'if test -f '+shlex.quote(remote+'/result.tar')+'; then printf complete; else cat '+shlex.quote(remote+'/phase')+' 2>/dev/null || printf queued; fi; printf "\\n"; cat '+shlex.quote(remote+'/progress.json')+' 2>/dev/null || true',timeout=25).strip()
            lines=phase.splitlines();phase=lines[0] if lines else 'queued'
            if len(lines)>1:
                try:ticket['progress']=json.loads(lines[1])
                except (ValueError,TypeError):pass
            ticket.update(state='receiving' if phase=='complete' else phase,lastSeenAt=now());atomic(ticket_path,ticket)
            if phase=='complete':break
            if phase=='failed':raise RuntimeError('T4 실행이 중단됐습니다. 같은 작업 ID로 이어받기를 누르면 저장된 결과부터 확인합니다.')
            progress=ticket.get('progress',{})
            detail=(f" · {progress['completed']}/{progress['total']}{progress.get('unit','개')}" if progress.get('total') else '')
            stage('T4 작업 순서 대기' if phase=='queued' else (progress.get('phase','T4 계산 실행 중')+detail))
            if time.monotonic()>deadline:raise TimeoutError('T4 상태 확인 제한 시간')
            time.sleep(3)
        metrics['pollUntilCompleteSeconds']=round(time.monotonic()-clock,3);clock=time.monotonic()
        stage('T4 결과 내려받기·원본 검증')
        archive=output/'gpu-result.tar';partial=archive.with_suffix('.downloading')
        scp(c,c['host']+':'+remote+'/result.tar',partial);partial.replace(archive)
        metrics['downloadSeconds']=round(time.monotonic()-clock,3);clock=time.monotonic()
        extract_result(archive,output)
        metrics['extractSeconds']=round(time.monotonic()-clock,3)
    except (RuntimeError,OSError,subprocess.TimeoutExpired) as exc:
        ticket.update(state='interrupted',lastError=type(exc).__name__,interruptedAt=now(),attemptTimings=metrics);atomic(ticket_path,ticket)
        message=str(exc) if str(exc).startswith('사용자 요청으로 T4가 중지') else 'T4 연결이 끊겼습니다. 작업 ID와 입력은 저장됐으며, 이어받을 때 기존 작업부터 확인합니다.'
        raise RecoverableJobError(message) from exc
    result=json.loads((output/'gpu-result.json').read_text())
    validate_result(result,ticket,sha)
    result['transferAndWorkerSeconds']=round(time.monotonic()-start,3)
    atomic(output/'gpu-result.json',result)
    if result.get('state')!='complete':
        ticket.update(state='failed',completedAt=now());atomic(ticket_path,ticket)
        raise RuntimeError(result.get('error','T4 처리 실패'))
    ticket.update(state='complete',completedAt=now(),result=result,attemptTimings=metrics,
                  artifacts={'gpu-result.tar':hashlib.sha256(archive.read_bytes()).hexdigest()})
    atomic(ticket_path,ticket)
    return result

def stage_pose_cache(operation,payload,c,remote,output):
    """Carry verified geometry across hosts, including local-only reuse revisions."""
    if operation!='pose':return None
    import pose_jobs,tarfile
    from pose_delta import prior_artifacts
    previous=prior_artifacts(payload['frame'],pose_jobs.STORE,pose_jobs.MODEL_SHA,pose_jobs.PIPELINE_VERSION)
    if not previous:return None
    path,old,_=previous
    if not (path/'fitted.json').exists():return None
    archive=output/'reuse-cache.tar.gz'
    with tarfile.open(archive,'w:gz',compresslevel=1) as tar:
        for name in ('result.json','meshes.json','fitted.json'):tar.add(path/name,arcname=name)
    scp(c,archive,c['host']+':'+remote+'/reuse-cache.tar.gz')
    return old['jobId']

def validate_result(result,ticket,sha):
    if result.get('inputSha256')!=sha or result.get('jobId')!=ticket['jobId']:raise RuntimeError('T4 결과의 원본·작업 ID가 다릅니다.')
    if result.get('workerCodeSha256')!=ticket.get('workerCodeSha256'):raise RuntimeError('T4 워커 코드 버전을 확인할 수 없습니다.')

def extract_result(archive,output):
    import tarfile
    with tarfile.open(archive) as tar:
        allowed={'gpu-result.json','tracks.json','court-raw.json','result.json','meshes.json','frame.jpg','fitted.json','wide-result.json','wide-frame.jpg'}
        if any(not m.isfile() or m.name not in allowed for m in tar.getmembers()):raise ValueError('T4 결과 파일 목록이 올바르지 않습니다.')
        tar.extractall(output,filter='data')

def tracking(case_id,event_id,index,stage):
    import case_store,object_cache
    case=case_store.load_case(case_id);event=next(e for e in case['events'] if e['id']==event_id)
    root=case_store.CASES[case_id];dest=root/'gpu-jobs'/f'{event_id}-f{index}'
    expected=object_cache.contract(config(),event,index,ROOT)
    source=root/'broadcast'/event['broadcast']['file'];payload={'event':event,'selectedFrame':index,'trackingContract':expected}
    # A proxy is tied to source, selected frame and window. Preserve the exact
    # physical input for in-flight or logically identical completed jobs.
    ticket_path=dest/'transport.json';request_path=dest/'gpu-request.json';manifest_path=dest/'input'/'processing.json'
    ticket=json.loads(ticket_path.read_text()) if ticket_path.exists() else {}
    prior_payload=json.loads(request_path.read_text()).get('payload',{}) if request_path.exists() else {}
    manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    ticket_sha=ticket.get('inputSha256')
    candidates=[manifest.get('processing'),prior_payload.get('processing')]
    prior_processing=next((v for v in candidates if v and v.get('processedSha256')==ticket_sha),None)
    spec=digest({'source':event['broadcast']['sha256'],'selectedFrame':index,
        'video':{k:event['broadcast'].get(k) for k in ('fps','frames','width','height','durationSeconds')},
        'seconds':event.get('broadcastSelection',{}).get('actionWindowSeconds',12)})
    pending=bool(ticket and ticket.get('state') not in ('complete','failed'))
    prior_logical=dict(prior_payload);prior_logical.pop('processing',None)
    prior_sha=(prior_logical.get('event',{}).get('broadcast',{}).get('sha256'))
    same=bool(prior_sha==event['broadcast']['sha256'] and request_identity('tracking',prior_logical,prior_sha)==request_identity('tracking',payload,prior_sha))
    resume=pending or same
    if resume and prior_processing:
        if manifest.get('spec')!=spec:raise RuntimeError('진행 중이거나 저장된 T4 작업의 프록시 입력이 달라졌습니다.')
        from tracking_proxy import prepare
        source,processing=prepare(source,event,index,dest/'input'/spec)
        if processing!=prior_processing:raise RuntimeError('진행 중이거나 저장된 T4 작업의 프록시가 달라졌습니다.')
        payload['processing']=processing
    elif not resume and os.environ.get('KBL_TRACK_PROXY_DISABLED')!='1':
        try:
            from tracking_proxy import prepare
            source,processing=prepare(source,event,index,dest/'input'/spec)
            if processing:
                atomic(manifest_path,{'spec':spec,'processing':processing})
                payload['processing']=processing
        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError):
            source=root/'broadcast'/event['broadcast']['file'];payload.pop('processing',None)
    result=execute('tracking',payload,source,dest,stage)
    packet=json.loads((dest/'tracks.json').read_text())
    if packet['inputSha256']!=event['broadcast']['sha256'] or not any(f['frameIndex']==index for f in packet['frames']):raise RuntimeError('T4 추적 결과가 선택 프레임과 다릅니다.')
    from broadcast_frame_processing import COURT_MODEL
    packet=object_cache.verified_packet(packet,expected,result.get('workerCodeSha256'),COURT_MODEL)
    from broadcast_tracking import atomic as tracking_atomic
    tracking_atomic(case_store.broadcast_root(case_id)/f'{event_id}.json',packet)
    # A new base invalidates old exact-frame supplements; preserve them in history.
    extra=root/'broadcast-frames'/f'{event_id}-{index}.json'
    if extra.exists():extra.rename(extra.with_suffix('.superseded-'+result['jobId']+'.json'))
    return result

def pose(job,frame,media,parent,stage):
    import pose_jobs
    data=copy.deepcopy(frame)
    if parent:data['reusedPredictions']={p['id']:{k:copy.deepcopy(p[k]) for k in ('keypoints','scores','depth')} for p in data['people']}
    dest=pose_jobs.folder(job)
    return execute('pose',{'frame':data,'corrected':bool(parent)},media,dest,stage,job_id=job)
