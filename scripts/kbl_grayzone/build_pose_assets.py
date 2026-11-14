"""Retarget accepted observed limbs onto the MPFB rig, bake exact display/collision meshes."""
import sys,json,time,hashlib,math
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'scripts/kbl_grayzone'))
import build_mpfb_assets as m
from mathutils import Vector,Matrix
import bpy
from arm_ik import solve_arm
ROOT=Path.cwd()
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--input',type=Path,default=ROOT/'outputs/kbl-pose-20261023/fitted.json');parser.add_argument('--output',type=Path,default=ROOT/'apps/web/public/kbl-grayzone/assets/poses');parser.add_argument('--revision',default='')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
OUT=args.output;OUT.mkdir(parents=True,exist_ok=True)
d=json.loads(args.input.read_text());neutral=m.set_pose
current=None
# Dual-quaternion deformation avoids the elbow collapsing during hinge motion.
for modifier in m.h.modifiers:
 if modifier.type=='ARMATURE':modifier.use_deform_preserve_volume=True

def align(name,world):
 b=m.rig.pose.bones[name];head=b.head.copy();desired=Vector((world[1],-world[0],world[2]))
 if desired.length<1e-6:return
 rot=(b.tail-head).rotation_difference(desired)
 b.matrix=Matrix.Translation(head)@rot.to_matrix().to_4x4()@Matrix.Translation(-head)@b.matrix;bpy.context.view_layer.update()
def rotate(b,rotation):
 head=b.head.copy();b.matrix=Matrix.Translation(head)@rotation.to_matrix().to_4x4()@Matrix.Translation(-head)@b.matrix;bpy.context.view_layer.update()
def arm_chain(side,p):
 from mathutils import Quaternion
 upper='upperarm_'+side;lower='lowerarm_'+side
 if upper not in p['directions'] or lower not in p['directions']:return
 a=m.rig.pose.bones[upper];b=m.rig.pose.bones[lower]
 u=Vector((p['directions'][upper][1],-p['directions'][upper][0],p['directions'][upper][2])).normalized()
 v=Vector((p['directions'][lower][1],-p['directions'][lower][0],p['directions'][lower][2])).normalized()
 rest_u=(a.tail-a.head).normalized();rest_v=(b.tail-b.head).normalized()
 pole=rest_u.cross(rest_v).normalized();swing=rest_u.rotation_difference(u);swung_pole=swing@pole
 bend=u.angle(v);desired_pole=u.cross(v)
 # Nearly straight arms don't provide a stable bending plane; retain the rig's
 # plane, rather than allowing tiny 2D noise to spin the wrist through 180°.
 if bend<math.radians(8):desired_pole=swung_pole
 else:desired_pole.normalize()
 twist=math.atan2(u.dot(swung_pole.cross(desired_pole)),swung_pole.dot(desired_pole))
 audit=p['armQuality'][side];audit['shoulderTwistDegrees']=math.degrees(twist)
 if abs(twist)>math.radians(110.01):
  audit.update(status='fallback-neutral',reason='ambiguous-arm-twist')
  p['directions'].pop(upper);p['directions'].pop(lower)
  p['fallbackBones']=list(dict.fromkeys(p['fallbackBones']+[upper,lower]));return
 rotate(a,Quaternion(u,twist)@swing)
 current_v=(b.tail-b.head).normalized()
 current_bend=math.atan2(desired_pole.dot(u.cross(current_v)),u.dot(current_v))
 rotate(b,Quaternion(desired_pole,bend-current_bend))
 final_u=(a.tail-a.head).normalized();final_v=(b.tail-b.head).normalized()
 applied=math.degrees(final_u.angle(final_v));audit['appliedFlexionDegrees']=applied
 audit['hingePlaneErrorDegrees']=math.degrees(final_u.cross(final_v).normalized().angle(desired_pole)) if bend>1e-4 else 0
 audit['connectedErrorMetres']=(b.head-a.tail).length
 assert applied<=145.01 and audit['connectedErrorMetres']<1e-4,'Unsafe arm retarget'
 assert audit['hingePlaneErrorDegrees']<.1,'Elbow hinge-plane drift'
def body_vector(v,p):
 c=math.cos(p['meshBodyHeading']);s=math.sin(p['meshBodyHeading']);x,y,z=-v.y,v.x,v.z
 return Vector((c*x+s*y,-s*x+c*y,z))
def rig_targets(side,p):
 a=m.rig.pose.bones['upperarm_'+side];b=m.rig.pose.bones['lowerarm_'+side]
 return {'elbow':list(body_vector(a.tail-a.head,p)*m.scale),'wrist':list(body_vector(b.tail-a.head,p)*m.scale)}
def to_world(v,p):
 c=math.cos(p['meshBodyHeading']);s=math.sin(p['meshBodyHeading']);x,y,z=v
 return [c*x-s*y,s*x+c*y,z]
def pose(_):
 neutral('neutral');p=current
 if not p:return
 p['meshBodyHeading']=p['bodyHeading'] if p.get('autoAccepted',p['accepted']) else 0.
 b=m.rig.pose.bones['Root'];b.matrix=Matrix.Rotation(p['meshBodyHeading'],4,'Z')@b.matrix;bpy.context.view_layer.update()
 if p.get('autoAccepted',p['accepted']):align('spine_01',p['spineDirection'])
 p['armRig']={}
 for side in ('l','r'):
  a=m.rig.pose.bones['upperarm_'+side];b=m.rig.pose.bones['lowerarm_'+side]
  matrices=(a.matrix.copy(),b.matrix.copy());shoulder=body_vector(a.head,p)*m.scale;shoulder.z-=m.zmin*m.scale
  info={'shoulder':list(shoulder),'upperLength':(a.tail-a.head).length*m.scale,'lowerLength':(b.tail-b.head).length*m.scale,
   'neutralUpper':list(body_vector((a.tail-a.head).normalized(),p)),'neutralLower':list(body_vector((b.tail-b.head).normalized(),p))}
  arm_chain(side,p);info['autoTargets']=rig_targets(side,p)
  target=p.get('manualArms3D',{}).get(side)
  if target:
   a.matrix=matrices[0];bpy.context.view_layer.update();b.matrix=matrices[1];bpy.context.view_layer.update()
   solved=solve_arm(target,info)
   p['manualArms3D'][side]={k:solved[k] for k in ('elbow','wrist')}
   p['directions']['upperarm_'+side]=to_world(solved['upper'],p);p['directions']['lowerarm_'+side]=to_world(solved['lower'],p)
   p['armQuality'][side]={'status':'manual','reason':'reviewer-3d','limited':solved['limited'],'inferredFlexionDegrees':None}
   arm_chain(side,p)
   if p['armQuality'][side]['status']!='manual':raise ValueError('수동 팔 변환에 실패했습니다. 이전 개정을 유지합니다.')
   p['fallbackBones']=[n for n in p['fallbackBones'] if n not in ('upperarm_'+side,'lowerarm_'+side)]
  info.update(rig_targets(side,p));p['armRig'][side]=info
 for name,v in p['directions'].items():
  if 'arm' not in name:align(name,v)
 # Preserve the exact leg-rig joints in body-local coordinates so that
 # map-heading candidates can be checked against their own rendered mesh.
 p['legRig']={}
 for side in ('l','r'):
  a=m.rig.pose.bones['thigh_'+side];b=m.rig.pose.bones['calf_'+side]
  hip=body_vector(a.head,p)*m.scale;hip.z-=m.zmin*m.scale
  p['legRig'][side]={'hip':list(hip),'knee':list(body_vector(a.tail-a.head,p)*m.scale),'ankle':list(body_vector(b.tail-a.head,p)*m.scale)}
 # Fingers/head keep their rig-relative pose. Reviewer targets are not observations.
m.set_pose=pose
results=[]
for f in d['frames']:
 start=time.perf_counter();assets={};reused_count=0;rebuilt_count=0
 from pose_delta import mesh_cache
 # Blender's bundled Python has no OpenCV. The fitted input already pins the
 # pipeline version; importing the fitter here couples rendering to inference.
 cached=mesh_cache(f,ROOT/'outputs/kbl-pose-frames',d['modelSha256'],f['pipelineVersion'])
 from work_progress import update
 spatial_people=[p for p in f['people'] if p.get('spatialEligible',True)]
 completed_meshes=0
 update('3D 인체 생성',0,len(spatial_people),'명')
 for p in f['people']:
  if p.get('spatialEligible') is False:continue
  if p['id'] in cached:
   prior=cached[p['id']];old=prior['person'];key=old['meshKey'];assets[key]=prior['mesh']
   for name in ('meshKey','eyeLocal','armRig','legRig','meshBodyHeading','armQuality','fallbackBones','directions','manualArms3D'):
    if name in old:p[name]=old[name]
   reused_count+=1;completed_meshes+=1;update('3D 인체 생성',completed_meshes,len(spatial_people),'명');continue
  rebuilt_count+=1
  current=p;key=f"pose-{f['clipId']}-f{f['frameIndex']}-{p['id']}"+(f'-{args.revision}' if args.revision else '');role='referee' if p['role'].startswith('ref') else 'player'
  mesh=m.build(role,key);ground=min(mesh['positions'][2::3]);mesh['positions'][2::3]=[round(z-ground,6) for z in mesh['positions'][2::3]]
  for arm in p['armRig'].values():arm['shoulder'][2]-=ground
  for leg in p['legRig'].values():leg['hip'][2]-=ground
  # Eye origin follows the same deformed rig as the displayed head.
  verts,_=m.evaluated();eye=sum((verts[i] for i in m.groups['helper-l-eye']|m.groups['helper-r-eye']),Vector())/len(m.groups['helper-l-eye']|m.groups['helper-r-eye'])
  eye=Vector((-eye.y*m.scale,eye.x*m.scale,(eye.z-m.zmin)*m.scale-ground))
  mesh['eye']=list(eye);assets[key]=mesh;completed_meshes+=1;update('3D 인체 생성',completed_meshes,len(spatial_people),'명');p['meshKey']=key;p['eyeLocal']=list(eye)
 # Only immutable source metadata and keys are in frame JSON; geometry in separate library.
 digest=hashlib.sha256(json.dumps(assets,separators=(',',':')).encode()).hexdigest()
 library=dict(schema='kbl-mpfb-mesh/v1',id=f"rtmw3d-{f['clipId']}-f{f['frameIndex']}-{args.revision}",geometrySha256=digest,assets=assets,license='CC0-1.0',generator='MPFB 2.0.18 / RTMW3D-X inferred pose')
 (OUT/(f['clipId']+'-meshes.json')).write_text(json.dumps(library,separators=(',',':')))
 row=dict(f,model=d['model'],modelSha256=d['modelSha256'],poseSource='single-frame-inferred',depthMeasured=False,poseMeasured=False,meshSha256=digest,meshBuildSeconds=time.perf_counter()-start,reusedMeshCount=reused_count,rebuiltMeshCount=rebuilt_count,poseSeconds=f['poseSeconds'],limitations=['Single-camera estimated depth; provisional court camera','Unreviewed low-confidence limbs remain neutral; manual 3D arms are reviewer assumptions; hands/head articulation not fitted','Not gaze estimation or verified 3D ground truth'])
 (OUT/(f['clipId']+'.json')).write_text(json.dumps(row,ensure_ascii=False,separators=(',',':')));results.append({k:row[k] for k in ['clipId','meshBuildSeconds','meshSha256']})
 print('POSE MESH',f['clipId'],len(assets),row['meshBuildSeconds'],flush=True)
(OUT/'mesh-build.json' if args.revision else ROOT/'outputs/kbl-pose-20261023/mesh-build.json').write_text(json.dumps(results,indent=2))
