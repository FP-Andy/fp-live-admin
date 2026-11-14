"""Case/intake uniform palette and conservative, frame-local colour suggestions.

Only players receive a team hint. Roles and manual team overrides are independent.
"""
import json,re,threading
from pathlib import Path
from functools import lru_cache
import cv2,numpy as np
LOCK=threading.RLock()
DEFAULT={'revision':0,'configured':False,'home':'#bc1735','away':'#f4f0df','samples':{}}

def path(scope,key):
 import case_store
 if scope=='cases':
  if key not in case_store.CASES:raise ValueError('등록되지 않은 경기입니다.')
  return case_store.CASES[key]/'uniforms.json'
 if scope=='intake':
  import review_intake
  data=review_intake.load(key)
  return path('cases',data['linkedCaseId']) if data.get('linkedCaseId') else review_intake.folder(key)/'uniforms.json'
 raise ValueError('색상 저장 범위를 확인하세요.')

def load(scope,key):
 p=path(scope,key)
 return json.loads(p.read_text()) if p.exists() else dict(DEFAULT,samples={})

def link_intake(key,case_id):
 """Carry an intake palette into its case, without replacing an existing one."""
 import review_intake
 with LOCK:
  source=review_intake.folder(key)/'uniforms.json';target=path('cases',case_id)
  if source.exists() and not target.exists():
   target.parent.mkdir(parents=True,exist_ok=True)
   temp=target.with_suffix('.tmp');temp.write_bytes(source.read_bytes());temp.replace(target)

def save(scope,key,payload):
 with LOCK:
  old=load(scope,key)
  if payload.get('revision')!=old['revision']:raise RuntimeError('다른 창에서 유니폼 색상이 변경됐습니다. 다시 불러오세요.')
  clean={}
  for team in ('home','away'):
   value=payload.get(team)
   if not isinstance(value,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',value):raise ValueError('홈·어웨이 색상은 #RRGGBB 형식이어야 합니다.')
   clean[team]=value.lower()
  if clean['home']==clean['away']:raise ValueError('홈·어웨이 색상을 다르게 지정하세요.')
  samples={};raw_samples=payload.get('samples',{})
  if not isinstance(raw_samples,dict):raise ValueError('색상 추출 정보를 확인하세요.')
  for team,s in raw_samples.items():
   if team not in ('home','away') or not isinstance(s,dict):raise ValueError('색상 추출 정보를 확인하세요.')
   if not isinstance(s.get('frameIndex'),int) or s['frameIndex']<0:raise ValueError('추출 프레임을 확인하세요.')
   samples[team]={'frameIndex':s['frameIndex'],'mediaId':str(s.get('mediaId',''))[:100],'eventId':str(s.get('eventId',''))[:100],'source':'frame-colour-pick'}
  value={**clean,'samples':samples,'revision':old['revision']+1,'configured':True}
  p=path(scope,key);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2));tmp.replace(p)
  return value

@lru_cache(maxsize=3)
def frame_image(file,index,sha):
 cap=cv2.VideoCapture(file);cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();actual=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;cap.release()
 if not ok or actual!=index:return None
 return image

def classify(crop,palette):
 if crop is None or crop.size<30 or not palette.get('configured'):return ('unknown',0.)
 rgb=np.float32([[[int(palette[k][i:i+2],16)/255 for i in (1,3,5)] for k in ('home','away')]])
 refs=cv2.cvtColor(rgb,cv2.COLOR_RGB2Lab)[0]
 if np.linalg.norm(refs[0]-refs[1])<18:return ('unknown',0.)
 lab=cv2.cvtColor(crop.astype(np.float32)/255,cv2.COLOR_BGR2Lab).reshape(-1,3)
 distances=np.linalg.norm(lab[:,None,:]-refs[None,:,:],axis=2)
 winner=np.argmin(distances,axis=1);ordered=np.sort(distances,axis=1)
 supported=(ordered[:,0]<38)&(ordered[:,1]-ordered[:,0]>12)
 votes=np.array([np.mean(supported&(winner==i)) for i in (0,1)])
 best=int(votes.argmax());margin=float(votes[best]-votes[1-best])
 if votes[best]<.20 or margin<.12:return ('unknown',margin)
 return (('home','away')[best],round(margin,3))

def annotate(packet,case_id,event,index):
 palette=load('cases',case_id);packet['uniforms']=palette
 frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
 if not frame:return packet
 import case_store
 image=frame_image(str(case_store.CASES[case_id]/'broadcast'/event['broadcast']['file']),index,packet['inputSha256']) if palette['configured'] else None
 for b in frame['boxes']:
  team,confidence='unknown',0.
  source_image=image
  if b.get('imageSource')=='wide' and image is not None:
   import multiview
   source=b.get('sourceImageUrl','').split('/')
   try:source_image=cv2.imread(str(multiview.image_file(case_id,event['id'],index,source[-1].split('.')[0])))
   except (ValueError,OSError,KeyError):source_image=None
  if b['roleHint']=='player' and source_image is not None:
   x1,y1,x2,y2=[v*s for v,s in zip(b['box'],[packet['width'],packet['height']]*2)];w=x2-x1;h=y2-y1
   crop=source_image[max(0,int(y1+.18*h)):min(source_image.shape[0],int(y1+.55*h)),max(0,int(x1+.25*w)):min(source_image.shape[1],int(x2-.25*w))]
   team,confidence=classify(crop,palette)
  b.update(team=team,teamSource='uniform-colour' if team!='unknown' else 'unresolved',teamConfidence=confidence)
 return packet
