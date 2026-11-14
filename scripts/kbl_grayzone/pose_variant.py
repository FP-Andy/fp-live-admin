"""Immutable map-bound pose shared by spatial analysis, reports and video."""
import copy,hashlib,json,re,shutil,tempfile,uuid
from pathlib import Path
import case_store,broadcast_pose
import storage_policy
from job_store import atomic,digest,lease,now

def folder(case,event,variant):
 if case not in case_store.CASES or not re.fullmatch(r'review-\d+',str(event)) or not re.fullmatch(r'[a-f0-9]{24}',str(variant)):raise ValueError('보정 자세 식별자를 확인하세요.')
 return case_store.CASES[case]/'reconstructions'/event/'pose-variants'/variant

def state_signature(state):
 return digest(sorted(({k:e.get(k) for k in ('id','role','x','y','bodyHeading')} for e in state['entities']),key=lambda x:x['id']))

def mesh_digest(assets):return hashlib.sha256(json.dumps(assets,separators=(',',':')).encode()).hexdigest()

def load(case,event,variant,state,base):
 p=folder(case,event,variant)
 try:
  meta=json.loads((p/'meta.json').read_text());pose=json.loads((p/'pose.json').read_text());mesh=json.loads((p/'meshes.json').read_text())
 except (OSError,ValueError) as exc:raise RuntimeError('보정 자세 자료가 없습니다. 다시 생성하세요.') from exc
 if meta.get('caseId')!=case or meta.get('eventId')!=event or meta.get('variantId')!=variant or meta.get('basePoseJobId')!=base.get('jobId') or meta.get('baseMeshSha256')!=base.get('meshSha256') or meta.get('stateSignature')!=state_signature(state):raise RuntimeError('배치·방향 또는 기본 자세가 바뀌었습니다. 보정 자세를 다시 생성하세요.')
 if mesh.get('schema')!='kbl-mpfb-mesh/v1' or mesh.get('geometrySha256')!=mesh_digest(mesh.get('assets')) or pose.get('meshSha256')!=mesh['geometrySha256']:raise RuntimeError('보정 자세 메시가 변경됐습니다.')
 if digest(pose)!=meta.get('poseDigest'):raise RuntimeError('보정 자세 정보가 변경됐습니다.')
 if {p['id'] for p in pose['people']}!={p['id'] for p in base['people']}:raise RuntimeError('보정 자세 인물 목록이 변경됐습니다.')
 for person in pose['people']:
  if person.get('accepted') and person.get('spatialEligible',True) and person.get('meshKey') not in mesh['assets']:raise RuntimeError('보정 인체 메시가 누락됐습니다.')
 return pose,mesh,meta

def pending_placed_people(scene,pose):
 entities={e['id']:e for e in scene['state']['entities']}
 return [p for p in pose['people'] if (e:=entities.get(p['id'])) and e['role']=='player' and not p.get('spatialEligible',True) and p.get('imageSource','broadcast')=='broadcast']

def lift_placed_people(case,event,scene,pose,mesh,path):
 """Lift reviewed image joints for players placed after image-only inference.

 Keep the saved map positions and all existing geometry; only players that
 already have a position and lack a spatial pose are candidates. Camera and
 single-image depth remain inferred, and all manual 2D joints are preserved.
 """
 import broadcast_reconstruction as reconstruction,video_pose_refit as refit
 from fit_pose import fit
 entities={e['id']:e for e in scene['state']['entities']};missing=[]
 for person in pending_placed_people(scene,pose):
  entity=entities.get(person['id'])
  if any(len(person.get(k,[]))!=17 for k in ('keypoints','scores','depth')):raise ValueError('배치된 선수의 관절 자료가 부족합니다. 관절 검수를 확인하세요.')
  p=copy.deepcopy(person);p.update(role='player',x=entity['x'],y=entity['y'],spatialEligible=True,spatialReason=None)
  missing.append(p)
 if not missing:return None
 _,_,_,frame=reconstruction.context(case,event,require_floor=False)
 anchors,camera=broadcast_pose.camera_inputs(frame,missing)
 if isinstance(pose.get('camera'),dict):camera=copy.deepcopy(pose['camera'])
 fitted=copy.deepcopy(pose);fitted.update(people=missing,anchors=anchors,cameraOverride=camera)
 fitted=fit(fitted)
 row,new_mesh=refit.build(refit.prepare(scene,fitted),path,'placed2d')
 built={p['id']:p for p in row['people'] if p.get('accepted') and p.get('meshKey') in new_mesh.get('assets',{})}
 if not built:raise RuntimeError('배치된 선수의 관절로 안전한 3D 인체를 만들지 못했습니다.')
 result=copy.deepcopy(pose);result['camera']=camera
 result['people']=[copy.deepcopy(built.get(p['id'],p)) for p in pose['people']]
 result['limitations']=[s for s in result.get('limitations',[]) if s not in ('Image keypoints only; court coordinates unresolved','No camera calibration, 3D geometry, or occlusion result')]
 result['limitations'].append('Reviewed 2D joints lifted using saved map positions and a provisional court camera; depth is inferred.')
 merged=copy.deepcopy(mesh);merged.setdefault('assets',{}).update(new_mesh['assets'])
 audit={p['id']:{'method':'placed-reviewed-2d-joints','cameraSource':camera.get('source','saved-pose-camera'),'depth':'inferred'} for p in missing if p['id'] in built}
 return result,merged,audit

def create(case,event,capture_id):
 import broadcast_reconstruction as reconstruction,video_pose_refit as refit
 root=case_store.CASES[case]/'reconstructions'/event
 with lease(root/'pose-variant.lock') as held:
  if not held:raise RuntimeError('이 장면의 자세를 보정 중입니다. 완료 후 다시 확인하세요.')
  scene=reconstruction.current(case,event,strict=True)
  if not scene or scene['captureId']!=capture_id:raise RuntimeError('저장된 공간 장면이 변경됐습니다. 다시 불러오세요.')
  base=broadcast_pose.validate_pose(case,event,scene['poseJobId'],scene['state']['entities'])
  import pose_jobs
  base_mesh=json.loads((pose_jobs.folder(base['jobId'])/'meshes.json').read_text())
  working,working_mesh=base,base_mesh
  if scene.get('poseVariantId'):
   working,working_mesh,_=load(case,event,scene['poseVariantId'],scene['state'],base)
  with tempfile.TemporaryDirectory(prefix='kbl-pose-variant-',dir=storage_policy.scratch_dir()) as name:
   tmp=Path(name)
   with lease(tmp/'.cleanup.lock') as held:
    if not held:raise RuntimeError('자세 보정 작업을 시작할 수 없습니다.')
    lifted=lift_placed_people(case,event,scene,working,working_mesh,tmp/'placed-lift')
    if lifted:
     pose,merged,audit=lifted;unsafe_optimization_skipped=False
    else:
     fitted=refit.prepare(scene,working);probe_input=refit.orientation_probe_fitted(scene,working);probe=None
     if probe_input:probe=refit.build(probe_input,tmp/'baseline-probe','orientationbase')
     first,mesh1=refit.build(fitted,tmp/'first','refit1');optimized,count=refit.optimize(fitted,first,scene);candidates=[(first,mesh1)]
     unsafe_optimization_skipped=refit.append_optimized_candidate(candidates,optimized,count,tmp/'second')
     pose,merged,audit=refit.select(scene,working,working_mesh,candidates,baseline_probe=probe,enforce_leg_checks=True)
  fresh=reconstruction.current(case,event,strict=True)
  if not fresh or fresh['captureId']!=capture_id:raise RuntimeError('보정 중 공간 장면이 바뀌었습니다. 다시 시도하세요.')
  variant=uuid.uuid4().hex[:24];assets={};pose=copy.deepcopy(pose)
  for person in pose['people']:
   if person.get('spatialEligible',True) and person.get('meshKey'):
    old=person['meshKey'];new='variant-'+variant+'-'+str(len(assets));assets[new]=merged['assets'][old];person['meshKey']=new
  sha=mesh_digest(assets);mesh={'schema':'kbl-mpfb-mesh/v1','id':'variant-'+variant,'geometrySha256':sha,'assets':assets,'generator':'map-bound constrained pose','license':base_mesh.get('license','CC0-1.0')}
  pose['meshSha256']=sha;pose['meshUrl']=f'/case-pose-variant/{case}/{event}/{variant}.json';pose['variantId']=variant;pose['poseSource']='map-bound-refit';pose['poseMeasured']=False
  meta={'selectionVersion':'map-placed-2d-v1' if lifted else 'map-heading-leg-v1','caseId':case,'eventId':event,'variantId':variant,'basePoseJobId':base['jobId'],'baseMeshSha256':base['meshSha256'],'sourceCaptureId':capture_id,'stateSignature':state_signature(scene['state']),'poseDigest':digest(pose),'meshSha256':sha,'selected':audit,'unsafeOptimizationSkipped':unsafe_optimization_skipped,'createdAt':now()}
  target=folder(case,event,variant);target.mkdir(parents=True,exist_ok=False)
  try:
   atomic(target/'pose.json',pose);atomic(target/'meshes.json',mesh);atomic(target/'meta.json',meta)
  except Exception:shutil.rmtree(target,ignore_errors=True);raise
  return {'variantId':variant,'pose':pose,'selectedCount':len(audit),'meshSha256':sha}
