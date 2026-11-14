"""Durable, case-scoped CPU video jobs with immutable inputs and safe publish."""
import copy,hashlib,json,math,os,re,shutil,signal,subprocess,sys,threading,time,uuid
from pathlib import Path
from job_store import atomic,busy,digest,lease,now
import case_store,broadcast_reconstruction as reconstruction,broadcast_pose,pose_jobs,review_videos,report_inputs
import storage_policy,report_assets
from video_safety import has_position_only

ROOT=case_store.ROOT/'outputs/kbl-video-jobs'
HERE=Path(__file__).resolve().parent
VERSION='courtside-cpu-video-v5-mannequin'
def enabled():return os.environ.get('KBL_VIDEO_RENDER_ENABLED','1')=='1'
def folder(job):
 if not re.fullmatch(r'[a-f0-9]{24}',str(job)):raise ValueError('영상 작업 ID를 확인하세요.')
 return ROOT/job
def sha(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(path):return json.loads(Path(path).read_text())
def executable():
 p=os.environ.get('KBL_FFMPEG') or shutil.which('ffmpeg') or str(case_store.ROOT/'runtime/kbl-cv/tools/ffmpeg')
 if not Path(p).is_file() or not os.access(p,os.X_OK):raise RuntimeError('영상 인코더 FFmpeg를 찾을 수 없습니다.')
 return str(Path(p).resolve())
def referee_labels(case,event,scene):
 data=case_store.load_case(case);saved=report_inputs.read(case).get('events',{}).get(event,{});mapping=report_inputs.assignments(data,scene,saved);names={r['number']:r['name'] for r in data.get('referees',[]) if 'number' in r and 'name' in r}
 for entity in scene.get('state',{}).get('entities',[]):
  evidence=(scene.get('sceneEvidence') or {}).get('identities',{}).get(entity['id'],{})
  if entity['id'] not in mapping and evidence.get('basis')=='operator-roster-match' and evidence.get('number') in names:mapping[entity['id']]=evidence['number']
 return {k:{'number':v,'name':names.get(v,'')} for k,v in mapping.items()}

def delivery_result(case,event,job):
 try:
  import video_delivery
  return video_delivery.deliver(case,event,job)
 except Exception as exc:
  from diagnostics import safe
  detail=safe(exc)[:250] if isinstance(exc,(ValueError,RuntimeError,OSError)) else '전달 폴더를 확인해 주세요.'
  return {'state':'failed','message':detail}

def video_pose_with_camera(case,event,pose):
 """Derive an illustrative camera from the saved court for 2D-only poses.

 Do not lift 2D joints or change the saved pose, scene, or report. The video
 uses the same neutral figures as the stored image-only reconstruction.
 """
 if isinstance(pose.get('camera'),dict):return pose
 if pose.get('poseSource') not in ('image-only-inferred','map-bound-refit') or any(p.get('accepted') for p in pose.get('people',[])):
  raise ValueError('저장된 3D 카메라 보정이 필요합니다.')
 _,_,packet,frame=reconstruction.context(case,event,require_floor=False)
 if not frame.get('courtRevision') or not frame.get('court',{}).get('visuallyReviewed'):
  raise ValueError('영상 카메라를 만들려면 검토된 코트 보정이 필요합니다.')
 try:
  _,camera=broadcast_pose.camera_inputs(frame,[{'spatialEligible':True}])
  if not isinstance(camera,dict):raise ValueError('저장된 코트에서 영상 카메라를 계산하지 못했습니다.')
  provenance={'method':'saved-reviewed-court','courtRevision':frame['courtRevision'],
   'anchorRMSEPixels':camera['anchorRMSEPixels'],'provisional':True}
 except ValueError as exc:
  if str(exc)!='중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.':raise
  import video_map_camera
  scene=reconstruction.current(case,event,strict=True)
  camera,provenance=video_map_camera.estimate(frame,packet,scene)
 if not isinstance(camera,dict):raise ValueError('저장된 코트에서 영상 카메라를 계산하지 못했습니다.')
 result=copy.deepcopy(pose);result['camera']=camera
 result['videoCameraProvenance']=provenance
 return result

def validate_shared_geometry(scene,pose):
 """Reject a video if its bodies differ from the saved visibility model."""
 people={p.get('id'):p for p in pose.get('people',[])}
 variant=bool(scene.get('poseVariantId'))
 for entity in scene.get('state',{}).get('entities',[]):
  p=people.get(entity.get('id'))
  if not p or not p.get('accepted') or p.get('role')!=entity.get('role'):continue
  x,y=p.get('x'),p.get('y')
  matched=entity.get('positionSource')=='manual' or (isinstance(x,(int,float)) and isinstance(y,(int,float)) and math.hypot(x-entity['x'],y-entity['y'])<.001)
  saved_uses_pose=matched and not (variant and entity['role']=='referee')
  video_uses_pose=entity['role']!='referee' and p.get('spatialEligible',True)
  if bool(saved_uses_pose)!=bool(video_uses_pose):
   raise ValueError('저장된 시야 계산과 영상 인체 형상이 다릅니다. 공간 장면에서 공유 자세를 적용하고 확인해 주세요.')

def inputs(case,event,player_orientation='map',allow_incomplete_crew=False):
 if player_orientation not in ('map','source','refit'):raise ValueError('선수 자세 적용 방식을 확인하세요.')
 if case not in case_store.CASES or not re.fullmatch(r'review-\d+',str(event)):raise ValueError('경기와 장면을 확인하세요.')
 root=case_store.CASES[case].resolve();data=case_store.load_case(case);entry=next((e for e in data['events'] if e['id']==event),None)
 if not entry:raise ValueError('판독 장면을 찾을 수 없습니다.')
 scene=reconstruction.current(case,event,strict=True);point=scene['state'].get('reviewPoint');refs=scene.get('crewAnalysis',{}).get('rows',[])
 if not point and not any(e['id']==scene['state'].get('targetId') for e in scene['state']['entities']):raise ValueError('2D 코트에서 판독 지점 또는 대상 인물을 먼저 저장하세요.')
 from video_safety import position_only
 ref_ids=[r['id'] for r in refs];ref_ids.extend(e['id'] for e in scene['state']['entities'] if e['role']=='referee' and position_only(e) and e['id'] not in ref_ids)
 if len(set(ref_ids))!=len(ref_ids) or len(ref_ids) not in ((2,3) if allow_incomplete_crew else (3,)):raise ValueError('세 심판의 위치와 관측 근거를 먼저 확인하세요.')
 job=scene.get('poseJobId')
 if not job:raise ValueError('저장된 3D 관절 자세가 필요합니다.')
 pose=broadcast_pose.validate_pose(case,event,job,scene['state']['entities'])
 variant=scene.get('poseVariantId')
 if variant:
  import pose_variant
  pose,_,_=pose_variant.load(case,event,variant,scene['state'],pose)
  if player_orientation=='source':raise ValueError('공유 보정 자세 장면에서는 2D 지도 방향 영상을 사용하세요.')
 validate_shared_geometry(scene,pose)
 pose=video_pose_with_camera(case,event,pose)
 broadcast=entry.get('broadcast') or {};name=broadcast.get('file','')
 if not isinstance(name,str) or Path(name).name!=name:raise ValueError('중계 원본을 확인하세요.')
 source=root/'broadcast'/name
 if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root) or sha(source)!=broadcast.get('sha256'):raise ValueError('중계 원본이 변경됐습니다.')
 scene_file=root/'reconstructions'/event/'current.json';mesh=(pose_variant.folder(case,event,variant) if variant else pose_jobs.folder(job))/'meshes.json';library=case_store.ROOT/'apps/web/public/kbl-grayzone/assets/humans/mpfb-court-v1.json';font=report_assets.report_assets_dir()/'KBLJump_B.ttf'
 for p in (scene_file,mesh,library,font,HERE/'video_cpu_worker.py',HERE/'video_renderer_cpu.py',HERE/'video_depth.py',HERE/'video_depth_raster.cpp',HERE/'video_safety.py',HERE/'video-assets/procedural-court.png'):
  if p.is_symlink() or not p.is_file():raise ValueError('영상 제작에 필요한 저장 파일이 없습니다.')
 if player_orientation=='refit':
  import video_pose_refit
  if not video_pose_refit.BLENDER.is_file():raise RuntimeError('자세 보정에 필요한 로컬 Blender를 찾을 수 없습니다.')
 labels=referee_labels(case,event,scene)
 identity={'case':case,'event':event,'capture':scene['captureId'],'frame':entry.get('selectedBroadcastFrame'),'scene':sha(scene_file),'source':sha(source),'mesh':sha(mesh),'pose':digest(pose),'library':sha(library),'font':sha(font),'referees':labels,'playerOrientation':player_orientation,'renderer':sha(HERE/'video_renderer_cpu.py'),'depth':sha(HERE/'video_depth.py'),'depthRaster':sha(HERE/'video_depth_raster.cpp'),'worker':sha(HERE/'video_cpu_worker.py'),'safety':sha(HERE/'video_safety.py'),'texture':sha(HERE/'video-assets/procedural-court.png'),'version':VERSION}
 if allow_incomplete_crew:identity['allowIncompleteCrew']=True
 if player_orientation=='refit':identity.update(refit=sha(HERE/'video_pose_refit.py'),rig=sha(HERE/'build_pose_assets.py'),rigAssets=sha(HERE/'build_mpfb_assets.py'),armIK=sha(HERE/'arm_ik.py'))
 if type(identity['frame']) is not int:raise ValueError('중계 판독 프레임을 먼저 선택하세요.')
 return {'case':data,'entry':entry,'scene':scene,'pose':pose,'source':source,'sceneFile':scene_file,'mesh':mesh,'library':library,'font':font,'identity':identity,'fingerprint':digest(identity)}
def status(job):
 data=read(folder(job)/'status.json')
 if data['state'] in ('queued','running') and time.time()-data.get('_createdEpoch',0)>10 and not busy(folder(job)/'process.lock'):
  try:
   review_videos.inspect(data['caseId'],data['eventId'],job)
   data={**data,'state':'complete','stage':'검증된 영상 복구 완료'}
  except (ValueError,RuntimeError,KeyError,OSError,StopIteration):data={**data,'state':'interrupted','stage':'제작이 중단됐습니다. 다시 시도할 수 있습니다.'}
 return {k:v for k,v in data.items() if not k.startswith('_')}
def submit(case,event,player_orientation='map',allow_incomplete_crew=False):
 if not enabled():raise RuntimeError('이 작업 서버에서는 영상 제작이 비활성화돼 있습니다.')
 ffmpeg=executable();prepared=inputs(case,event,player_orientation,True) if allow_incomplete_crew else inputs(case,event,player_orientation);fingerprint=prepared['fingerprint']
 with lease(ROOT/'submit.lock') as acquired:
  if not acquired:raise RuntimeError('영상 작업을 등록 중입니다. 다시 시도하세요.')
  for p in ROOT.glob('*/status.json'):
   try:
    d=read(p)
    if d.get('caseId')==case and d.get('eventId')==event and d.get('fingerprint')==fingerprint:
     saved=status(d['jobId'])
     if saved['state'] in ('queued','running'):return {'job':saved}
     if saved['state']=='complete':
      review_videos.inspect(case,event,d['jobId'])
      d['result']={**d.get('result',{}),'delivery':delivery_result(case,event,d['jobId'])};atomic(p,d)
      return {'job':status(d['jobId'])}
   except (OSError,ValueError,KeyError,RuntimeError,StopIteration):continue
  # Final publication uses a filesystem clone when supported. Reserve space
  # for temporary encodes and a full-copy fallback without triple-counting.
  need=max(768*1024**2,prepared['source'].stat().st_size*2+256*1024**2)
  if storage_policy.free_bytes(ROOT)<need+2*1024**3:raise RuntimeError('저장 공간이 부족합니다. 여유 공간 확보 후 다시 시도하세요.')
  job=uuid.uuid4().hex[:24];path=folder(job);path.mkdir(parents=True,exist_ok=False)
  for name,src in [('scene.json',prepared['sceneFile']),('meshes.json',prepared['mesh']),('human-library.json',prepared['library'])]:shutil.copyfile(src,path/name)
  atomic(path/'pose.json',prepared['pose'])
  hashes={name:sha(path/name) for name in ('scene.json','pose.json','meshes.json','human-library.json')};hashes['source']=prepared['identity']['source']
  spec={'sourcePath':str(prepared['source']),'frameIndex':prepared['identity']['frame'],'ffmpegPath':ffmpeg,'fontPath':str(prepared['font']),'inputHashes':hashes,'fingerprint':fingerprint,'caseId':case,'eventId':event,'captureId':prepared['identity']['capture'],'sceneSha256':prepared['identity']['scene'],'referees':prepared['identity']['referees'],'playerOrientation':'map' if player_orientation=='refit' else player_orientation,'poseMode':player_orientation,'experimentalPose':player_orientation=='refit'}
  if allow_incomplete_crew:spec['allowIncompleteCrew']=True
  atomic(path/'inputs.json',spec);data={'jobId':job,'caseId':case,'eventId':event,'fingerprint':fingerprint,'state':'queued','stage':'영상 제작 대기','createdAt':now(),'_createdEpoch':time.time()};atomic(path/'status.json',data)
  try:
   with (path/'runner.log').open('ab') as log:subprocess.Popen([sys.executable,str(HERE/'video_jobs.py'),'--run',job],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
  except OSError as exc:data.update(state='failed',stage='영상 작업을 시작하지 못했습니다.',error=str(exc));atomic(path/'status.json',data);raise RuntimeError('영상 작업을 시작하지 못했습니다.') from exc
  return {'job':status(job)}
def run(job):
 path=folder(job);data=read(path/'status.json');spec=read(path/'inputs.json')
 with lease(path/'process.lock') as mine:
  if not mine:return
  try:
   with lease(ROOT/'worker.lock') as worker:
    if not worker:raise RuntimeError('다른 영상 제작이 진행 중입니다. 완료 후 다시 시도하세요.')
    data.update(state='running',stage='영상 입력 확인',updatedAt=now());atomic(path/'status.json',data)
    mode=spec.get('poseMode',spec.get('playerOrientation','map'))
    prepare=lambda: inputs(data['caseId'],data['eventId'],mode,True) if spec.get('allowIncompleteCrew') else inputs(data['caseId'],data['eventId'],mode)
    if prepare()['fingerprint']!=spec['fingerprint']:raise RuntimeError('제작 전 판독 자료가 변경됐습니다. 다시 시도하세요.')
    if spec.get('experimentalPose'):
     import video_pose_refit as refit
     scene=read(path/'scene.json');pose=read(path/'pose.json');base=read(path/'meshes.json');fitted=refit.prepare(scene,pose)
     data.update(stage='2D 방향 유지 · 자세 보정 중',updatedAt=now());atomic(path/'status.json',data)
     first,mesh1=refit.build(fitted,path/'refit-first','refit1')
     optimized,count=refit.optimize(fitted,first,scene)
     candidates=[(first,mesh1)]
     unsafe_skipped=refit.append_optimized_candidate(candidates,optimized,count,path/'refit-second')
     selected,meshes,audit=refit.select(scene,pose,base,candidates)
     atomic(path/'render-pose.json',selected);atomic(path/'render-meshes.json',meshes);atomic(path/'refit-audit.json',{'selected':audit,'optimizedChains':count,'unsafeOptimizationSkipped':unsafe_skipped,'caveat':'영상 비교용이며 리포트의 시야 계산에는 반영되지 않음'})
     for name in ('render-pose.json','render-meshes.json'):spec['inputHashes'][name]=sha(path/name)
     spec.update(renderPoseFile='render-pose.json',renderMeshFile='render-meshes.json');atomic(path/'inputs.json',spec)
    with (path/'render-error.log').open('wb') as errors:
     proc=subprocess.Popen([sys.executable,str(HERE/'video_cpu_worker.py'),str(path)],stdout=subprocess.PIPE,stderr=errors,text=True,start_new_session=True,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
     def timeout():
      if proc.poll() is None:
       try:os.killpg(proc.pid,signal.SIGTERM)
       except ProcessLookupError:pass
     watchdog=threading.Timer(1800,timeout);watchdog.daemon=True;watchdog.start()
     try:
      for line in proc.stdout:
       try:
        progress=json.loads(line);data.update(state='running',stage=progress['stage'],progress={'completed':progress['done'],'total':progress['total']},updatedAt=now());atomic(path/'status.json',data)
       except (ValueError,KeyError,TypeError):pass
      code=proc.wait()
     finally:watchdog.cancel()
    if code:raise RuntimeError('영상 생성에 실패했습니다. 입력·카메라 경로를 확인한 뒤 다시 시도하세요.')
    result=read(path/'result.json');output=path/'output.tmp.mp4'
    if not output.is_file() or sha(output)!=result.get('videoSha256'):raise RuntimeError('완성 영상 검증에 실패했습니다.')
    if result.get('playerOrientation','map')!=spec.get('playerOrientation','map'):raise RuntimeError('선수 자세 적용 방식이 요청과 다릅니다.')
    if result.get('modelStyle')!='uniform-mannequin-v1':raise RuntimeError('마네킹 인체 모델 검증에 실패했습니다.')
    if prepare()['fingerprint']!=spec['fingerprint']:raise RuntimeError('제작 중 판독 자료 또는 영상 코드가 변경돼 결과를 보관하지 않았습니다.')
    dest=review_videos.folder(data['caseId'],data['eventId']);dest.mkdir(parents=True,exist_ok=True);video=dest/(job+'.mp4');meta=dest/(job+'.json')
    if video.exists() or meta.exists():raise RuntimeError('같은 영상 ID가 이미 있습니다.')
    # The metadata is published last: an incomplete copy is never downloadable.
    from video_delivery import clone_or_copy
    staged=dest/('.video-'+uuid.uuid4().hex+'.tmp')
    try:
     clone_or_copy(output,staged,dest)
     if sha(staged)!=result['videoSha256']:raise RuntimeError('영상 저장 검증에 실패했습니다.')
     try:os.link(staged,video)
     except OSError as exc:
      import errno
      if exc.errno not in (errno.EPERM,errno.EXDEV,errno.EOPNOTSUPP,errno.ENOTSUP):raise
      try:
       with staged.open('rb') as src,video.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024);dst.flush();os.fsync(dst.fileno())
       if sha(video)!=result['videoSha256']:raise RuntimeError('영상 저장 검증에 실패했습니다.')
      except FileExistsError:raise
      except Exception:video.unlink(missing_ok=True);raise
    finally:staged.unlink(missing_ok=True)
    from video_safety import position_only
    expected=sorted(e['id'] for e in read(path/'scene.json')['state']['entities'] if position_only(e))
    if result.get('positionOnlyPeople')!=expected:raise RuntimeError('광각 위치 표식 검증에 실패했습니다.')
    snapshot=read(path/'scene.json');camera_provenance=read(path/'pose.json').get('videoCameraProvenance')
    atomic(meta,{'schema':'courtside-review-video/v3','caseId':data['caseId'],'eventId':data['eventId'],'videoId':job,'captureId':spec['captureId'],'frameIndex':spec['frameIndex'],'sceneSha256':spec['sceneSha256'],'sourceSha256':spec['inputHashes']['source'],'videoSha256':result['videoSha256'],'caveat':result['caveat'],'fallbackPeople':result['fallbackPeople'],'positionOnlyPeople':expected,'positionOnlyRepresentation':'neutral-standing-assumption','playerOrientation':spec.get('playerOrientation','map'),'poseMode':spec.get('poseMode','map'),'modelStyle':result['modelStyle'],'refereeDigest':digest(spec.get('referees',{})),**({'videoCameraProvenance':camera_provenance} if camera_provenance else {}),**({'poseVariantId':snapshot['poseVariantId'],'poseMeshSha256':snapshot['poseMeshSha256']} if snapshot.get('poseVariantId') and not spec.get('experimentalPose') else {})})
    delivery=delivery_result(data['caseId'],data['eventId'],job)
    data.update(state='complete',stage='영상 제작 완료',completedAt=now(),result={'fallbackPeople':result['fallbackPeople'],'positionOnlyPeople':expected,'caveat':result['caveat'],'delivery':delivery});atomic(path/'status.json',data)
  except Exception as exc:
   from diagnostics import safe
   message=safe(exc)[:300] if isinstance(exc,(ValueError,RuntimeError)) else '영상 제작을 마치지 못했습니다. 입력과 서버 상태를 확인해 주세요.'
   data.update(state='failed',stage='영상 제작 확인 필요',error=message,completedAt=now());atomic(path/'status.json',data)
  finally:
   # Keep the published video and compact audit inputs, not duplicate encodes.
   for name in ('insert.tmp.mp4','output.tmp.mp4'):
    try:(path/name).unlink(missing_ok=True)
    except OSError:pass
   for name in ('refit-first','refit-second'):
    try:shutil.rmtree(path/name,ignore_errors=True)
    except OSError:pass
if __name__=='__main__' and len(sys.argv)==3 and sys.argv[1]=='--run':run(sys.argv[2])
