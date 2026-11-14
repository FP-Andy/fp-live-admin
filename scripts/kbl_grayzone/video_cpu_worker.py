"""Render one immutable reviewed scene; invoked only by the local job runner.

The camera and bodies are illustrations derived from saved review inputs.
No object detection, inference, network access, or source data mutation occurs.
"""
import hashlib,json,math,os,subprocess,sys,types
from pathlib import Path
import cv2,numpy as np
from PIL import Image,ImageDraw,ImageFont
from scipy.spatial.transform import Rotation,Slerp
from video_safety import position_only

def sha(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(path):return json.loads(Path(path).read_text())
def emit(stage,done=0,total=0):print(json.dumps({'stage':stage,'done':done,'total':total},ensure_ascii=False),flush=True)
def mesh_data(scene,pose,assets,library,player_orientation='map'):
 if player_orientation not in ('map','source'):raise ValueError('선수 자세 적용 방식을 확인하세요.')
 verts=[];faces=[];colors=[];actors=[];offset=0;fallback=[]
 meshes={**library,**assets};people={p['id']:p for p in pose['people']}
 for e in scene['state']['entities']:
  # Referees, including a position-only wide reference, use a stationary
  # neutral body. This is a visual assumption, never a tracked pose.
  p=people.get(e['id']);usable=e['role']!='referee' and p and p.get('accepted') and p.get('role')==e['role'] and p.get('spatialEligible',True)
  key=p.get('meshKey') if usable else ('referee-neutral' if e['role']=='referee' else 'player-neutral')
  if not usable and e['role']!='referee':fallback.append(e['id'])
  if key not in meshes:raise ValueError('저장된 인체 메시가 없습니다: '+e['id'])
  a=meshes[key];v=np.asarray(a['positions'],dtype=np.float32).reshape(-1,3).astype(np.float64);v[:,2]*=(1.82 if e['role']=='referee' else 1.75 if e['role']=='staff' else 1.9)/1.9
  heading=e.get('bodyHeading',0) or 0
  if usable:heading-=p.get('meshBodyHeading',p.get('bodyHeading',heading)) or 0
  # The source-frame option preserves the original fitted mesh orientation.
  # Referee eye headings and all stored 2D positions/headings stay unchanged.
  # Explicit reviewer 3D arm edits remain attached to the reviewed body pose.
  if usable and e['role']=='player' and player_orientation=='source' and not p.get('manualArms3D') and not p.get('manualBodyHeading'):
   heading=0.
  x=v[:,0].copy();y=v[:,1].copy();v[:,0]=x*math.cos(heading)-y*math.sin(heading)+e['x'];v[:,1]=x*math.sin(heading)+y*math.cos(heading)+e['y'];verts.append(v)
  uniform=scene['uniforms'].get(e.get('team'),'#969ba4');ref=e['role']=='referee';palette={'skin':'#81929f','jersey':'#b9bec7' if ref else uniform,'shorts':'#20242c' if ref else uniform,'trim':'#f3f0e7','shoes':'#242832','sole':'#c2c3c5'}
  for part in a['parts']:
   if part['material'] in ('hair','eyes','iris'):continue
   f=np.asarray(part['indices'],dtype=np.int64).reshape(-1,3)+offset;faces.append(f);actors.extend([e['id']]*len(f));colors.append(np.tile(tuple(bytes.fromhex(palette.get(part['material'],'#999999').lstrip('#'))),(len(f),1)))
  offset+=len(v)
 if not verts:raise ValueError('저장된 코트 인물이 없습니다.')
 return {'vertices':np.concatenate(verts),'faces':np.concatenate(faces),'colors':np.concatenate(colors),'actor':np.asarray(actors)},fallback

def camera_plan(scene,pose,referees=None,allow_incomplete_crew=False):
 """Broadcast camera → full court → referee views → broadcast camera."""
 rows=list(scene['crewAnalysis']['rows']);entities={e['id']:e for e in scene['state']['entities']};point=scene['state'].get('reviewPoint')
 known={r['id'] for r in rows}
 rows.extend({'id':e['id']} for e in entities.values() if e['role']=='referee' and position_only(e) and e['id'] not in known)
 if len(rows) not in ((2,3) if allow_incomplete_crew else (3,)) or len({r['id'] for r in rows})!=len(rows):raise ValueError('세 심판의 위치와 시점 가정을 먼저 확인하세요.')
 if not point:
  point=entities.get(scene['state'].get('targetId'))
  if not point:raise ValueError('2D 코트의 판독 지점 또는 대상 인물을 먼저 지정하세요.')
 K=np.asarray(pose['camera']['K'],float);R0=np.asarray(pose['camera']['worldToCamera'],float);t0=np.asarray(pose['camera']['translation'],float)
 c0=-R0.T@t0;target=np.array([point['x'],point['y'],scene['state'].get('targetHeight',1.1)]);conversion=np.diag([1.,-1.,1.]);points=[]
 def look(c,destination):
  f=np.asarray(destination,float)-c;norm=np.linalg.norm(f)
  if norm<.1:raise ValueError('판독 지점과 카메라 위치를 확인하세요.')
  f/=norm;right=np.cross([0.,0.,1.],f);norm=np.linalg.norm(right)
  if norm<1e-5:raise ValueError('카메라 방향을 확인하세요.')
  right/=norm;return np.array([right,-np.cross(f,right),f])
 def add(c,R,focal,duration,label='',hide=None):
  points.append((np.asarray(c,float),Rotation.from_matrix(conversion@R),float(focal),duration,label,hide))
 # Full-court keyframe is fitted to the court, both baskets and all people.
 bounds=[[0,0,0],[28,0,0],[28,15,0],[0,15,0],[1.2,7.5,4.1],[26.8,7.5,4.1]]
 for e in entities.values():bounds.extend(([e['x'],e['y'],0],[e['x'],e['y'],1.95]))
 bounds=np.asarray(bounds,float)
 # Stay on the broadcast camera's side of the court: crossing to the opposite
 # side while interpolating orientation can point the lens away from the floor.
 side=c0[:2]-np.array([14.,7.5]);norm=float(np.linalg.norm(side))
 if norm<1e-6:side=np.array([0.,-1.]);norm=1.
 xy=np.array([14.,7.5])+side/norm*20.;overview=np.array([xy[0],xy[1],25.]);overview_R=look(overview,[14.,7.5,.6]);q=(bounds-overview)@overview_R.T
 if np.min(q[:,2])<=.1:raise ValueError('전체 코트 카메라를 구성할 수 없습니다.')
 fx=np.max(np.abs(q[:,0]/q[:,2]));fy=np.max(np.abs(q[:,1]/q[:,2]));overview_focal=.90*min(960/max(fx,1e-6),540/max(fy,1e-6))
 shared=bool(scene.get('poseVariantId'))
 eye_focal=min(960/math.tan(math.radians(scene['state']['hfov'])/2),540/math.tan(math.radians(scene['state']['vfov'])/2)) if shared else 1920/(2*math.tan(math.radians(100)/2));focal=float(K[0,0])
 add(c0,R0,focal,0);add(c0,R0,focal,.5);add(overview,overview_R,overview_focal,1.5);add(overview,overview_R,overview_focal,1.0,'전체 코트')
 for i,row in enumerate(rows):
  e=entities.get(row['id'])
  if not e or e['role']!='referee':raise ValueError('시점에 사용할 심판의 위치와 방향을 확인하세요.')
  heading=row.get('heading')
  if heading is None and not position_only(e):heading=e.get('viewHeading',e.get('bodyHeading'))
  if heading is None:heading=math.atan2(target[1]-e['y'],target[0]-e['x'])
  theta=float(heading);eye=np.array([e['x']+(0 if shared else .1*math.cos(theta)),e['y']+(0 if shared else .1*math.sin(theta)),1.65]);direction=np.array([math.cos(theta),math.sin(theta),0 if shared else -.08]);eye_R=look(eye,eye+direction)
  # Transits stay above the court; only the selected referee view descends.
  above=np.array([eye[0],eye[1],8.]);above_R=look(above,target)
  assigned=(referees or {}).get(e['id'],{});identity=f" · #{assigned['number']} {assigned.get('name','')}" if assigned.get('number') is not None else ''
  label=f'심판 {i+1}{identity} · 시점 가정'
  add(above,above_R,eye_focal,.8);add(eye,eye_R,eye_focal,.7,hide=e['id']);add(eye,eye_R,eye_focal,1.1,label,e['id']);add(above,above_R,eye_focal,.7,hide=e['id'])
 add(overview,overview_R,overview_focal,1.0);add(c0,R0,focal,1.5);add(c0,R0,focal,.5)
 frames=[]
 for a,b in zip(points,points[1:]):
  distance=np.linalg.norm(b[0]-a[0]);angle=np.degrees((b[1]*a[1].inv()).magnitude());duration=max(b[3],distance*1.5/13.,angle*1.5/100.);count=max(1,round(duration*30));slerp=Slerp([0,1],Rotation.concatenate([a[1],b[1]]))
  for j in range(count):
   u=(j+1)/count;u=u*u*(3-2*u);c=a[0]*(1-u)+b[0]*u;R=conversion@slerp([u]).as_matrix()[0]
   hide=b[5] if b[5] and np.linalg.norm(c-b[0])<.65 else a[5] if a[5] and np.linalg.norm(c-a[0])<.65 else None
   frames.append((R,-R@c,hide,b[4],a[2]*(1-u)+b[2]*u))
 return frames,K,R0,t0

def main(job_dir):
 job=Path(job_dir);data=read(job/'inputs.json');scene=read(job/'scene.json');pose=read(job/('render-pose.json' if data.get('experimentalPose') else 'pose.json'));assets=read(job/('render-meshes.json' if data.get('experimentalPose') else 'meshes.json'))['assets'];library=read(job/'human-library.json')['assets'];source=Path(data['sourcePath']);ffmpeg=data['ffmpegPath']
 for name,expected in data['inputHashes'].items():
  path=source if name=='source' else job/name
  if sha(path)!=expected:raise ValueError('영상 제작 입력이 변경됐습니다: '+name)
 cap=cv2.VideoCapture(str(source));fps=cap.get(cv2.CAP_PROP_FPS);count=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));w=round(cap.get(cv2.CAP_PROP_FRAME_WIDTH));h=round(cap.get(cv2.CAP_PROP_FRAME_HEIGHT));idx=data['frameIndex']
 if (w,h)!=(1920,1080) or abs(fps-30)>.01 or not 0<=idx<count-1:raise ValueError('현재 제작기는 1920×1080, 30fps 중계 클립만 지원합니다.')
 cap.set(cv2.CAP_PROP_POS_FRAMES,idx);ok,still=cap.read();cap.release()
 if not ok:raise ValueError('선택한 중계 프레임을 읽지 못했습니다.')
 orientation=data.get('playerOrientation','map');mesh,fallback=mesh_data(scene,pose,assets,library,orientation);frames,K,R,t=camera_plan(scene,pose,data.get('referees'),data.get('allowIncompleteCrew',False));context=types.ModuleType('video_scene_context');context.pose=pose;context.scene=scene;context.R=R;context.t=t;sys.modules['video_scene_context']=context
 import video_renderer_cpu as render
 render.prepare(mesh,{});font=ImageFont.truetype(data['fontPath'],34);insert=job/'insert.tmp.mp4';output=job/'output.tmp.mp4'
 command=[ffmpeg,'-n','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','bgr24','-s','1920x1080','-r','30','-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p',str(insert)]
 proc=subprocess.Popen(command,stdin=subprocess.PIPE);emit('3D 장면 생성',0,len(frames))
 try:
  for i,(R,t,hide,label,focal) in enumerate(frames):
   render.K[:]=K;render.K[0,0]=render.K[1,1]=focal;im=render.draw(None,R,t,hide)
   if scene.get('poseVariantId') and label.startswith('심판 '):
    half_w=min(960,int(round(focal*math.tan(math.radians(scene['state']['hfov'])/2))));half_h=min(540,int(round(focal*math.tan(math.radians(scene['state']['vfov'])/2))))
    im[:540-half_h,:]=0;im[540+half_h:,:]=0;im[:,:960-half_w]=0;im[:,960+half_w:]=0
   alpha=min(1.,(i+1)/14,(len(frames)-i)/14);im=cv2.addWeighted(im,alpha,still,1-alpha,0)
   if alpha>.8:
    image=Image.fromarray(cv2.cvtColor(im,cv2.COLOR_BGR2RGB));d=ImageDraw.Draw(image);d.rectangle((25,25,1200 if data.get('experimentalPose') else 900,85),fill=(14,24,38));d.text((40,32),'자세 보정 비교본 · 시야 분석과 형상이 다를 수 있음' if data.get('experimentalPose') else '2D 배치 기반 3D 재구성' if pose.get('videoCameraProvenance',{}).get('method')=='saved-map-and-image-footpoints' else '3D 재구성 · 선수 중계 자세 가정' if orientation=='source' else '3D 재구성 · 자세와 시점 가정',font=font,fill='white')
    if data.get('allowIncompleteCrew') and len(scene['crewAnalysis']['rows'])==2:
     note='심판 2명 시점 · 나머지 1명 위치 미확인';bounds=d.textbbox((40,104),note,font=font);d.rectangle((25,97,bounds[2]+20,157),fill=(14,24,38));d.text((40,104),note,font=font,fill='white')
    if label:
     bounds=d.textbbox((40,984),label,font=font);d.rectangle((25,975,min(1900,bounds[2]+20),1040),fill=(14,24,38));d.text((40,984),label,font=font,fill='white')
    im=cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR)
   proc.stdin.write(im.tobytes())
   if i%30==0:emit('3D 장면 생성',i,len(frames))
 finally:proc.stdin.close()
 if proc.wait()!=0:raise RuntimeError('3D 화면 인코딩에 실패했습니다.')
 emit('원본 영상과 연결',0,1);cut=idx+1;duration=len(frames)/30
 probe=subprocess.run([ffmpeg,'-hide_banner','-i',str(source)],capture_output=True,text=True);audio='Audio:' in probe.stderr
 vf=f'[0:v]split=2[b][a];[b]trim=end_frame={cut},setpts=N/(30*TB),setsar=1[v0];[1:v]trim=end_frame={len(frames)},setpts=N/(30*TB),setsar=1[v1];[a]trim=start_frame={cut},setpts=N/(30*TB),setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]'
 if audio:
  vf+=f';[0:a]asplit=2[ab][aa];[ab]atrim=end={cut/30:.9f},asetpts=PTS-STARTPTS[a0];anullsrc=r=48000:cl=stereo,atrim=duration={duration:.9f}[a1];[aa]atrim=start={cut/30:.9f},asetpts=PTS-STARTPTS[a2];[a0][a1][a2]concat=n=3:v=0:a=1[a]'
 cmd=[ffmpeg,'-n','-hide_banner','-loglevel','error','-i',str(source),'-i',str(insert),'-filter_complex',vf,'-map','[v]']+(['-map','[a]','-c:a','aac','-b:a','128k'] if audio else ['-an'])+['-r','30','-fps_mode','cfr','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',str(output)]
 subprocess.run(cmd,check=True);subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-i',str(output),'-f','null','-'],check=True);capture=cv2.VideoCapture(str(output));actual=round(capture.get(cv2.CAP_PROP_FRAME_COUNT))
 if actual!=count+len(frames):raise ValueError('완성 영상의 프레임 수가 원본과 일치하지 않습니다.')
 original=cv2.VideoCapture(str(source));diffs=[]
 try:
  for a,b in ((0,0),(idx,idx),(cut,cut+len(frames)),(count-1,actual-1)):
   original.set(cv2.CAP_PROP_POS_FRAMES,a);capture.set(cv2.CAP_PROP_POS_FRAMES,b);ok1,one=original.read();ok2,two=capture.read()
   if not ok1 or not ok2:raise ValueError('원본 전후 프레임을 검증하지 못했습니다.')
   difference=float(np.abs(one.astype(np.float32)-two.astype(np.float32)).mean());diffs.append(difference)
   if difference>=8:raise ValueError('원본 재개 프레임 검증에 실패했습니다.')
 finally:original.release();capture.release()
 for name,expected in data['inputHashes'].items():
  if sha(source if name=='source' else job/name)!=expected:raise ValueError('제작 중 입력이 변경되어 결과를 보관하지 않았습니다.')
 (job/'result.json').write_text(json.dumps({'videoSha256':sha(output),'sourceFrames':count,'outputFrames':actual,'selectedFrame':idx,'resumeSourceFrame':cut,'insertFrames':len(frames),'frameDifference':diffs,'fallbackPeople':fallback,'positionOnlyPeople':sorted(e['id'] for e in scene['state']['entities'] if position_only(e)),'playerOrientation':orientation,'modelStyle':'uniform-mannequin-v1','audioPresent':audio,'caveat':('확인된 두 심판 시점만 표시하며 세 번째 심판의 위치와 시점은 확인되지 않았습니다. ' if data.get('allowIncompleteCrew') and len(scene['crewAnalysis']['rows'])==2 else '')+('영상 카메라는 저장된 2D 배치를 바탕으로 구성했고 선수는 기본 자세입니다. ' if pose.get('videoCameraProvenance',{}).get('method')=='saved-map-and-image-footpoints' else '영상 카메라는 검토된 코트 기준점으로 산출한 추정값이며 2D 관절은 3D에 반영하지 않은 기본 자세입니다. ' if pose.get('videoCameraProvenance') else '')+('자세 보정 비교본이며 기존 리포트 시야 계산과 형상이 다를 수 있습니다. ' if data.get('experimentalPose') else '')+('선수의 몸 방향은 중계 프레임 추정으로 2D 지도 몸 방향과 다를 수 있고, 이에 따라 시야 가림이 달라질 수 있습니다. ' if orientation=='source' else '')+'선택된 정지 장면의 자세·시점·카메라는 추정입니다. 심판은 서 있는 기본 자세이며 광각 위치 전용 심판의 몸과 시점도 가정입니다.'},ensure_ascii=False));emit('영상 검증 완료',1,1)
if __name__=='__main__':main(sys.argv[1])
