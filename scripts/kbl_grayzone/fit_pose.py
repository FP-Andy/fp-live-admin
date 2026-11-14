"""Lift RTMW3D root-relative depth through a provisional court camera.
Not metric ground truth: single planar nine-anchor camera, height prior and inferred
hidden-joint depth. Never substitute head/torso orientation for referee gaze.
"""
import json,math
from pathlib import Path
import cv2,numpy as np
THRESHOLD=.30
PIPELINE_VERSION='mpfb-image-pose-v5'
# Conservative prototype acceptance limits, not a medical range-of-motion model.
MAX_ELBOW_FLEXION=145.
BONES={'upperarm_l':(5,7),'lowerarm_l':(7,9),'upperarm_r':(6,8),'lowerarm_r':(8,10),'thigh_l':(11,13),'calf_l':(13,15),'thigh_r':(12,14),'calf_r':(14,16)}

def body_direction(xyz,usable):
 """Conservative torso-facing heuristic; support is not calibrated accuracy or gaze.

 Canonical +X is forward; anatomical left is +Y. A shoulder-only estimate
 can silently reverse when an occluded left/right keypoint is swapped.
 """
 shoulder=xyz[5,:2]-xyz[6,:2];hip=xyz[11,:2]-xyz[12,:2]
 sw=float(np.linalg.norm(shoulder));hw=float(np.linalg.norm(hip))
 heading=math.atan2(-shoulder[0],shoulder[1]);reasons=[];delta=None
 if not all(usable[i] for i in (5,6,11,12)):reasons.append('torso-keypoints-unreliable')
 if not .12<=sw<=.70 or not .10<=hw<=.55:reasons.append('torso-axis-foreshortened')
 if sw>1e-6 and hw>1e-6:
  delta=math.degrees(math.acos(float(np.clip(shoulder@hip/(sw*hw),-1,1))))
  if delta>40:reasons.append('shoulder-hip-disagreement')
  if not reasons:
   axis=.75*shoulder/sw+.25*hip/hw
   heading=math.atan2(-axis[0],axis[1])
 return {'heading':float(heading),'status':'uncertain' if reasons else 'estimated',
         'source':'shoulder-hip-geometry','reasons':reasons,'axisDifferenceDegrees':delta,
         'shoulderWidth':sw,'hipWidth':hw,'gazeMeasured':False}

def guard_arm_chains(directions,xyz):
 directions=dict(directions);quality={}
 for side,ids in [('l',(5,7,9)),('r',(6,8,10))]:
  upper,lower='upperarm_'+side,'lowerarm_'+side;a,b,c=ids
  reason=None;angle=None
  if upper not in directions or lower not in directions:reason='incomplete-arm-chain'
  else:
   u=np.array(directions[upper]);v=np.array(directions[lower])
   angle=math.degrees(math.acos(float(np.clip(u@v,-1,1))))
   lengths=[np.linalg.norm(xyz[b]-xyz[a]),np.linalg.norm(xyz[c]-xyz[b])]
   if min(lengths)<.1 or max(lengths)/min(lengths)>2.:reason='inconsistent-arm-lengths'
   elif angle>MAX_ELBOW_FLEXION:reason='excessive-elbow-flexion'
  if reason:
   directions.pop(upper,None);directions.pop(lower,None)
  quality[side]={'status':'fallback-neutral' if reason else 'supported','reason':reason,'inferredFlexionDegrees':angle}
 return directions,quality

def camera(anchors):
 obj=np.float32([[x,y,0] for y in [0,7.5,15] for x in [0,14,28]])
 K=np.array([[1100.,0,960],[0,1100,540],[0,0,1]])
 flags=cv2.CALIB_USE_INTRINSIC_GUESS|cv2.CALIB_FIX_ASPECT_RATIO|cv2.CALIB_FIX_PRINCIPAL_POINT|cv2.CALIB_ZERO_TANGENT_DIST|cv2.CALIB_FIX_K2|cv2.CALIB_FIX_K3
 err,K,d,rv,tv=cv2.calibrateCamera([obj],[np.float32(anchors)],(1920,1080),K,np.zeros(5),flags=flags)
 R=cv2.Rodrigues(rv[0])[0]
 # Court x-right/y-near/z-up is the display convention. Planar calibration's
 # positive normal points below the court; reflect only that unconstrained axis.
 if (-R.T@tv[0])[2,0]<0:R[:,2]*=-1
 return K,d,R,tv[0].ravel(),err

def fit(frame):
 override=frame.get('cameraOverride');calibration=None
 if any(p.get('spatialEligible',True) for p in frame['people']):
  if override:
   K,d,R,t=(np.array(override[k]) for k in ('K','distortion','worldToCamera','translation'));err=override['anchorRMSEPixels']
  else:K,d,R,t,err=camera(frame['anchors'])
  calibration={'K':K.tolist(),'distortion':d.ravel().tolist(),'worldToCamera':R.tolist(),'translation':t.tolist(),'anchorRMSEPixels':err,'provisional':True}
 out=[]
 for p in frame['people']:
  if p.get('spatialEligible') is False:
   # Keep all image joints editable without inventing a court location/depth.
   image_only=dict(p,accepted=False,autoAccepted=False,status='image-only',directions={},fallbackBones=list(BONES))
   for key in ('meshKey','eyeLocal','armRig','jointWorld','bodyHeading','meshBodyHeading','bodyDirection'):image_only.pop(key,None)
   out.append(image_only);continue
  local=p.get('cameraOverride') or calibration
  K,d,R,t=(np.array(local[k]) for k in ('K','distortion','worldToCamera','translation'))
  q=np.array(p['keypoints']);s=np.array(p['scores']);h=1.82 if p['role'].startswith('ref') else 1.9
  rays=cv2.undistortPoints(q.reshape(-1,1,2),K,d).reshape(-1,2);rays=np.column_stack([rays,np.ones(len(q))])
  # Upstream rtmlib 0.0.15 uses image-height for z; this ONNX z head has 576
  # bins => input z-size 288. Correct differences by 384/288 and center at hips.
  depth=np.array(p['depth'])*384/288;depth-=depth[[11,12]].mean()
  zroot=(R@np.array([p['x'],p['y'],h*.52])+t)[2]
  xyz=(rays*(zroot+depth)[:,None]-t)@R
  manual=p.get('manualJoints',{})
  usable=(s>=THRESHOLD)|np.array([str(i) in manual for i in range(17)])
  box=p['pixelBox'];pad=(box[3]-box[1])*.15
  # A reviewer can place an extended limb outside the detector's tight crop.
  usable&=((q[:,0]>=box[0]-pad)&(q[:,0]<=box[2]+pad)&(q[:,1]>=box[1]-pad)&(q[:,1]<=box[3]+pad))|np.array([str(i) in manual for i in range(17)])
  torso=all(usable[i] for i in [5,6,11,12]);dirs={};reasons={}
  direction=body_direction(xyz,usable);heading=direction['heading']
  # Shoulder/hip support is required before deforming any limb on this body.
  for name,(a,b) in BONES.items():
   delta=xyz[b]-xyz[a];length=float(np.linalg.norm(delta));expected=.33 if 'arm' in name else .43
   if torso and usable[a] and usable[b] and .10<length<.85:
    dirs[name]=(delta/length).tolist()
   else:reasons[name]='low-confidence / unsupported torso / implausible segment'
  spine=(xyz[[5,6]].mean(0)-xyz[[11,12]].mean(0));spine/=max(1e-8,np.linalg.norm(spine))
  # Avoid upside-down or almost horizontal torsos from unresolved overlaps.
  accepted=torso and spine[2]>.55 and len(dirs)>=2
  if not accepted:dirs={}
  dirs,arm_quality=guard_arm_chains(dirs,xyz)
  accepted=accepted and len(dirs)>=2
  if not accepted:dirs={}
  manual=bool(p.get('manualArms3D'))
  out.append(dict(p,accepted=bool(accepted or manual),autoAccepted=bool(accepted),bodyHeading=float(heading),bodyDirection=direction,directions=dirs,armQuality=arm_quality,spineDirection=spine.tolist(),jointWorld=xyz.tolist(),jointUsable=usable.tolist(),fallbackBones=[n for n in BONES if n not in dirs],status='partial-manual' if manual else 'partial-estimated' if accepted else 'fallback-neutral'))
 # Fit the secondary rays through their own camera, then fill unsupported world
 # bone chains. Primary keypoints and all operator edits remain untouched.
 from multiview_geometry import fill_missing_bones
 merged=[]
 for p in out:
  secondary=p.get('widePose')
  if secondary and p.get('imageSource','broadcast')=='broadcast' and p.get('spatialEligible',True):
   secondary=dict(secondary,x=p['x'],y=p['y'],spatialEligible=True)
   secondary.pop('widePose',None)
   other=fit({'people':[secondary],'cameraOverride':secondary['cameraOverride'],'anchors':frame.get('anchors',[])})['people'][0]
   p=fill_missing_bones(p,other)
  merged.append(p)
 return dict(frame,pipelineVersion=PIPELINE_VERSION,people=merged,camera=calibration,threshold=THRESHOLD)

if __name__=='__main__':
 import argparse,time
 a=argparse.ArgumentParser();a.add_argument('input',type=Path);a.add_argument('output',type=Path);args=a.parse_args();d=json.loads(args.input.read_text());start=time.perf_counter();d['frames']=[fit(f) for f in d['frames']];d['fitSeconds']=time.perf_counter()-start
 args.output.write_text(json.dumps(d,ensure_ascii=False,indent=2))
 for f in d['frames']:print(f['clipId'],'accepted',sum(p['accepted'] for p in f['people']),'/',len(f['people']),'bones',sum(len(p['directions']) for p in f['people']))
