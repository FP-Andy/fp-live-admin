"""Experimental, video-only pose refitting; saved analysis remains untouched."""
import copy,math,os,re,subprocess
from pathlib import Path
import numpy as np
from scipy.optimize import least_squares
from job_store import atomic

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
# Match pose_jobs: a Linux worker can supply its installed Blender explicitly,
# while existing local Mac installations keep the same default.
BLENDER=Path(os.environ.get('KBL_BLENDER') or ROOT/'runtime/kbl-mpfb/Blender.app/Contents/MacOS/Blender')

class UnsafeArmRetargetError(RuntimeError):
 """A candidate failed the rig's arm safety check."""

def prepare(scene,pose):
 frame=copy.deepcopy(pose);frame.pop('meshReuseSource',None)
 entities={e['id']:e for e in scene['state']['entities']}
 for p in frame['people']:
  e=entities.get(p['id'])
  if e and e['role']=='player' and p.get('accepted') and p.get('spatialEligible',True):
   p['bodyHeading']=e.get('bodyHeading',0.) or 0.
   # A previous mesh build may have removed a plausible arm solely because
   # its twist was ambiguous for the *old* torso heading. Retry that evidence
   # under the reviewed map heading, without changing manual 3D corrections.
   xyz=np.asarray(p.get('jointWorld',[]),float);usable=p.get('jointUsable',[])
   if xyz.shape==(17,3) and len(usable)==17 and np.isfinite(xyz).all():
    from fit_pose import guard_arm_chains
    for side,(a,b,c) in [('l',(5,7,9)),('r',(6,8,10))]:
     upper,lower='upperarm_'+side,'lowerarm_'+side
     quality=p.get('armQuality',{}).get(side,{})
     if p.get('manualArms3D',{}).get(side) or quality.get('reason')!='ambiguous-arm-twist' or not all(usable[i] for i in (a,b,c)):continue
     u,v=xyz[b]-xyz[a],xyz[c]-xyz[b];lu,lv=np.linalg.norm(u),np.linalg.norm(v)
     if not (.10<lu<.85 and .10<lv<.85):continue
     pair,guard=guard_arm_chains({upper:(u/lu).tolist(),lower:(v/lv).tolist()},xyz)
     if upper in pair and lower in pair:
      p.setdefault('directions',{}).update(pair);p.setdefault('armQuality',{})[side]=guard[side]
      p['fallbackBones']=[n for n in p.get('fallbackBones',[]) if n not in (upper,lower)]
 return {'model':frame['model'],'modelSha256':frame['modelSha256'],'frames':[frame]}

def heading_needs_leg_check(person,entity):
 """A large heading rotation requires leg evidence before changing a mesh."""
 if not entity or entity.get('role')!='player' or not person.get('accepted') or not person.get('spatialEligible',True) or person.get('imageSource','broadcast')!='broadcast':return False
 try:
  source=person.get('meshBodyHeading');source=person.get('bodyHeading') if source is None else source;delta=float(entity['bodyHeading'])-float(source)
  return abs(math.atan2(math.sin(delta),math.cos(delta)))>=math.radians(35)
 except (KeyError,TypeError,ValueError):return False

def orientation_probe_fitted(scene,pose):
 """Rebuild only plausible direction-rotation cases as a temporary reference."""
 entities={e['id']:e for e in scene['state']['entities']};people=[]
 for p in pose['people']:
  e=entities.get(p['id'])
  if not heading_needs_leg_check(p,e) or p.get('manualArms3D') or p.get('manualBodyHeading'):continue
  if not all(n in p.get('directions',{}) for n in ('thigh_l','calf_l','thigh_r','calf_r')):continue
  people.append(copy.deepcopy(p))
 if not people:return None
 frame=copy.deepcopy(pose);frame.pop('meshReuseSource',None);frame['people']=people
 return {'model':frame['model'],'modelSha256':frame['modelSha256'],'frames':[frame]}

def build(data,path,tag):
 if not BLENDER.is_file():raise RuntimeError('자세 보정에 필요한 로컬 Blender를 찾을 수 없습니다.')
 path.mkdir(parents=True,exist_ok=True);atomic(path/'fitted.json',data)
 clip=data['frames'][0]['clipId']
 if not re.fullmatch(r'[a-z0-9-]+',clip):raise ValueError('자세 영상 식별자를 확인하세요.')
 env={**os.environ,'BLENDER_USER_CONFIG':str(ROOT/'runtime/kbl-mpfb/blender-config')}
 command=[str(BLENDER),'--background','--factory-startup','--threads','2','--python-exit-code','1','--python',str(HERE/'build_pose_assets.py'),'--','--input',str(path/'fitted.json'),'--output',str(path),'--revision',tag]
 with (path/'build.log').open('wb') as log:
  completed=subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
 if completed.returncode:
  log=(path/'build.log').read_text(errors='replace')
  if 'AssertionError: Unsafe arm retarget' in log:raise UnsafeArmRetargetError('안전하지 않은 팔 자세 보정 후보를 제외했습니다.')
  raise RuntimeError('자세 인체 생성에 실패했습니다. 로컬 Blender 실행 상태를 확인하세요.')
 import json
 try:
  row=json.loads((path/(clip+'.json')).read_text());mesh=json.loads((path/(clip+'-meshes.json')).read_text())
 except (OSError,ValueError) as exc:raise RuntimeError('보정 인체 결과를 확인할 수 없습니다.') from exc
 if row.get('clipId')!=clip or row.get('frameIndex')!=data['frames'][0]['frameIndex'] or not isinstance(mesh.get('assets'),dict):raise RuntimeError('보정 인체의 출처를 확인하세요.')
 return row,mesh

def append_optimized_candidate(candidates,optimized,count,path):
 """Discard only an unsafe optional refinement; keep the verified first fit."""
 if not count:return False
 try:second,mesh=build(optimized,path,'refit2')
 except UnsafeArmRetargetError:return True
 candidates.append((second,mesh))
 return False

def project_points(person,entity,camera,mode):
 if person.get('imageSource')=='wide':camera=person.get('cameraOverride')
 if not isinstance(camera,dict):return {}
 try:
  R=np.asarray(camera['worldToCamera'],float);t=np.asarray(camera['translation'],float);K=np.asarray(camera['K'],float)
  angle=float(entity.get('bodyHeading',0.) or 0.);c,s=math.cos(angle),math.sin(angle);out={}
  for side,ids in [('l',(5,7,9)),('r',(6,8,10))]:
   a=person.get('armRig',{}).get(side);quality=person.get('armQuality',{}).get(side,{})
   # A neutral fallback is still the actual baseline mesh and must be scored:
   # omitting it makes it impossible to select a recovered supported arm.
   if not a:continue
   shoulder=np.asarray(a['shoulder'],float)
   for idx,offset in zip(ids,(np.zeros(3),np.asarray(a['elbow'],float),np.asarray(a['wrist'],float))):
    if not person['jointUsable'][idx] or person['scores'][idx]<.3:continue
    p=shoulder+offset;q=R@np.array([c*p[0]-s*p[1]+entity['x'],s*p[0]+c*p[1]+entity['y'],p[2]])+t
    if q[2]<=.05:continue
    uv=K@q;uv=uv[:2]/uv[2];obs=np.asarray(person['keypoints'][idx],float)
    if np.all(np.isfinite(uv)) and np.all(np.isfinite(obs)):out[idx]=float(np.linalg.norm(uv-obs))
  return out
 except (KeyError,TypeError,ValueError,IndexError):return {}

def optimize(fitted,trial,scene):
 """Adjust supported arms only, constrained by bone lengths and prior direction."""
 fitted=copy.deepcopy(fitted);persons={p['id']:p for p in fitted['frames'][0]['people']};entities={e['id']:e for e in scene['state']['entities']};count=0
 for p in trial['people']:
  e=entities.get(p['id']);original=persons.get(p['id'])
  if not e or not original or e['role']!='player' or not p.get('accepted') or p.get('imageSource')=='wide':continue
  camera=trial.get('camera');
  if not isinstance(camera,dict):continue
  try:
   R=np.asarray(camera['worldToCamera'],float);t=np.asarray(camera['translation'],float);K=np.asarray(camera['K'],float);angle=float(e.get('bodyHeading',0.) or 0.);c,s=math.cos(angle),math.sin(angle);rot=np.array([[c,-s,0],[s,c,0],[0,0,1]])
   box=p['pixelBox'];scale=math.hypot(box[2]-box[0],box[3]-box[1]);
   if scale<1:continue
   for side,ids in [('l',(7,9)),('r',(8,10))]:
    a=p.get('armRig',{}).get(side);quality=p.get('armQuality',{}).get(side,{})
    if not a or quality.get('status')=='fallback-neutral' or p.get('manualArms3D',{}).get(side):continue
    if not all(p['jointUsable'][i] and p['scores'][i]>=.3 for i in ids):continue
    origin=rot@np.asarray(a['shoulder'],float)+np.array([e['x'],e['y'],0]);L1=float(a['upperLength']);L2=float(a['lowerLength']);el=np.asarray(a['elbow'],float);wr=np.asarray(a['wrist'],float)
    if min(L1,L2,np.linalg.norm(el),np.linalg.norm(wr-el))<1e-5:continue
    u=rot@(el/np.linalg.norm(el));v=rot@((wr-el)/np.linalg.norm(wr-el));obs=np.asarray([p['keypoints'][i] for i in ids],float);scores=np.asarray([p['scores'][i] for i in ids],float)
    def unit(q):return q/max(1e-9,np.linalg.norm(q))
    def residual(z):
     u1=unit(z[:3]);u2=unit(z[3:]);points=[origin+u1*L1,origin+u1*L1+u2*L2];uv=[]
     for point in points:
      q=K@(R@point+t);uv.append(q[:2]/max(q[2],.01))
     err=((np.asarray(uv)-obs)/scale*np.sqrt(scores)[:,None]).ravel();bend=max(0.,math.cos(math.radians(145))-float(u1@u2))*3
     return np.r_[err,(u1-u)*.12,(u2-v)*.12,bend]
    initial=np.r_[u,v];solved=least_squares(residual,initial,max_nfev=80)
    if not solved.success or np.linalg.norm(residual(solved.x)[:4])+1e-5>=np.linalg.norm(residual(initial)[:4]):continue
    original['directions']['upperarm_'+side]=unit(solved.x[:3]).tolist();original['directions']['lowerarm_'+side]=unit(solved.x[3:]).tolist();count+=1
  except (KeyError,IndexError,TypeError,ValueError,FloatingPointError):continue
 return fitted,count

def select(scene,baseline,base_mesh,candidates,baseline_probe=None,enforce_leg_checks=False):
 """Choose per player only with comparable 2D evidence and lower error."""
 entities={e['id']:e for e in scene['state']['entities']};base={p['id']:p for p in baseline['people']};rows=copy.deepcopy(baseline);assets=dict(base_mesh['assets']);chosen={}
 for row,mesh in candidates:assets.update(mesh['assets'])
 lookups=[{p['id']:p for p in row['people']} for row,_ in candidates]
 probe_people={p['id']:p for p in baseline_probe[0]['people']} if baseline_probe else {}
 for i,p in enumerate(rows['people']):
  e=entities.get(p['id']);original=base[p['id']]
  if not e or e['role']!='player' or not p.get('accepted') or p.get('manualArms3D') or p.get('manualBodyHeading'):continue
  available=[('baseline',original)]+[(f'refit-{n+1}',lookup[p['id']]) for n,lookup in enumerate(lookups) if p['id'] in lookup and lookup[p['id']].get('accepted')]
  observations=[project_points(q,e,baseline.get('camera'),'map') for _,q in available]
  if len(observations)<2:continue
  common=set.intersection(*(set(x) for x in observations))
  box=original.get('pixelBox') or [0,0,0,0];scale=math.hypot(box[2]-box[0],box[3]-box[1])
  if scale<1:continue
  # The old selector examined only arms. A large difference between the map
  # heading and the mesh's source heading can rotate both feet to the opposite
  # screen locations. Score actual rebuilt leg rigs against the saved image
  # joints, only when the reference rebuild matches the original shoe meshes.
  from pose_orientation import baseline_leg_rig_matches_mesh,leg_reprojection,leg_candidate_is_safer
  probe=probe_people.get(p['id']);leg_before=None;leg_after={}
  if probe and baseline_probe:
   old_asset=base_mesh.get('assets',{}).get(original.get('meshKey'));probe_asset=baseline_probe[1].get('assets',{}).get(probe.get('meshKey'))
   if old_asset and probe_asset and baseline_leg_rig_matches_mesh(original,probe,old_asset,probe_asset):
    leg_before=leg_reprojection(probe,e,baseline.get('camera'))
    for n,(_,candidate) in enumerate(available[1:],1):leg_after[n]=leg_reprojection(candidate,e,baseline.get('camera'))
  if leg_before and len(common)>=2:
   admissible=[]
   for n in range(1,len(available)):
    after=leg_after.get(n)
    if not leg_candidate_is_safer(leg_before,after,scale):continue
    arm_before=float(np.mean([observations[0][k] for k in common]));arm_after=float(np.mean([observations[n][k] for k in common]))
    if arm_after>arm_before+scale*.035 or any(observations[n][k]>observations[0][k]+scale*.08 for k in common):continue
    admissible.append((float(np.mean(list(after['direct'].values()))),n))
   if admissible:
    _,best=min(admissible);after=leg_after[best]
    chosen[p['id']]={'method':available[best][0],'criterion':'map-heading-leg-reprojection-v1','points':4,'before':round(float(np.mean(list(leg_before['direct'].values())))/scale,4),'after':round(float(np.mean(list(after['direct'].values())))/scale,4),'armPoints':len(common)}
    rows['people'][i]=copy.deepcopy(available[best][1]);continue
  if len(common)<2:continue
  # For a large-heading mismatch, an unavailable leg probe must not silently
  # let an arm-only change alter unverified leg geometry.
  if (probe or (enforce_leg_checks and heading_needs_leg_check(original,e))) and not leg_before:continue
  score=[float(np.mean([x[k] for k in common]))/scale for x in observations]
  best=int(np.argmin(score))
  if best and leg_before and not leg_after.get(best):continue
  # If reliable leg evidence exists, never pick an arm-only improvement that
  # causes a major leg regression. Without it retain the old arm-only policy.
  if best and leg_before and leg_after.get(best):
   a=leg_after[best];b=leg_before
   if np.mean(list(a['direct'].values()))>np.mean(list(b['direct'].values()))+scale*.035 or any(a['direct'][k]>b['direct'][k]+scale*.08 for k in b['direct']):continue
  if best and score[best]<score[0]*.95 and all(observations[best][k]<=observations[0][k]+scale*.08 for k in common):
   chosen[p['id']]={'method':available[best][0],'points':len(common),'before':round(score[0],4),'after':round(score[best],4)};rows['people'][i]=copy.deepcopy(available[best][1])
 return rows,{'assets':assets},chosen
