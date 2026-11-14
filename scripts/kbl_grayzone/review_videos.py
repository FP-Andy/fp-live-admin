"""Read verified video artifacts only; rendering needs a separate worker.

Artifacts stay inside a case, and are usable only while the saved source scene
and original broadcast are unchanged. A filename supplied by a client is never
used as a filesystem path without strict validation.
"""
import hashlib,json,re
from pathlib import Path
import case_store,broadcast_reconstruction
from video_safety import has_position_only,position_only

ID=re.compile(r'^[a-f0-9]{24}$')
EVENT=re.compile(r'^review-[0-9]+$')
def sha(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def folder(key,event):
 if key not in case_store.CASES or not EVENT.fullmatch(event):raise ValueError('판독 장면을 확인하세요.')
 root=case_store.CASES[key].resolve();p=root/'review-videos'/event
 if p.is_symlink() or p.parent.is_symlink() or not p.resolve().is_relative_to(root):raise ValueError('영상 저장 위치를 확인하세요.')
 return p
def inspect(key,event,job):
 if not ID.fullmatch(job):raise ValueError('영상 ID를 확인하세요.')
 root=case_store.CASES[key].resolve();p=folder(key,event);meta=p/(job+'.json');video=p/(job+'.mp4')
 if meta.is_symlink() or video.is_symlink() or not meta.is_file() or not video.is_file():raise ValueError('저장된 영상을 찾을 수 없습니다.')
 if not meta.resolve().is_relative_to(root) or not video.resolve().is_relative_to(root):raise ValueError('영상 저장 위치를 확인하세요.')
 data=json.loads(meta.read_text())
 if not isinstance(data,dict):raise ValueError('영상 출처 정보를 확인하세요.')
 case=case_store.load_case(key);record=next(e for e in case['events'] if e['id']==event)
 scene=root/'reconstructions'/event/'current.json'
 if scene.is_symlink() or not scene.is_file():raise ValueError('현재 저장된 공간 장면이 없습니다.')
 current=broadcast_reconstruction.current(key,event,strict=True)
 if has_position_only(current):
  expected=sorted(e['id'] for e in current['state']['entities'] if position_only(e))
  representation=(data.get('schema'),data.get('positionOnlyRepresentation'))
  if representation not in (('courtside-review-video/v2','marker-only'),('courtside-review-video/v3','neutral-standing-assumption')) or data.get('positionOnlyPeople')!=expected:raise RuntimeError('광각에서 위치만 관측된 심판의 시점은 사용할 수 없습니다.')
 broadcast=record.get('broadcast') or {};name=broadcast.get('file','')
 if not isinstance(name,str) or Path(name).name!=name:raise ValueError('원본 영상 경로를 확인하세요.')
 source=root/'broadcast'/name
 if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):raise ValueError('원본 영상을 찾을 수 없습니다.')
 expected=(data.get('schema') in ('courtside-review-video/v1','courtside-review-video/v2','courtside-review-video/v3') and data.get('caseId')==key and data.get('eventId')==event and data.get('videoId')==job and data.get('sceneSha256')==sha(scene) and data.get('captureId')==current.get('captureId') and data.get('frameIndex')==record.get('selectedBroadcastFrame') and data.get('sourceSha256')==broadcast.get('sha256')==sha(source))
 if not expected:raise RuntimeError('저장된 장면이나 원본이 바뀌어 영상을 다시 만들어야 합니다.')
 if current.get('poseVariantId') and data.get('poseMode')!='refit':
  if data.get('poseVariantId')!=current['poseVariantId'] or data.get('poseMeshSha256')!=current.get('poseMeshSha256'):raise RuntimeError('영상과 리포트의 보정 자세가 달라 다시 제작해야 합니다.')
 if 'refereeDigest' in data:
  import video_jobs
  from job_store import digest
  if data['refereeDigest']!=digest(video_jobs.referee_labels(key,event,current)):raise RuntimeError('심판 배정이 바뀌어 영상을 다시 만들어야 합니다.')
 if data.get('videoSha256')!=sha(video):raise ValueError('영상 파일이 변경됐습니다.')
 return data,video
def catalog(key):
 import video_jobs
 case=case_store.load_case(key);rows=[];jobs={e['id']:[] for e in case['events']}
 for path in video_jobs.ROOT.glob('*/status.json'):
  try:
   row=video_jobs.status(path.parent.name)
   if row.get('caseId')==key and row.get('eventId') in jobs:jobs[row['eventId']].append(row)
  except (OSError,ValueError,KeyError,TypeError,json.JSONDecodeError):continue
 for event in case['events']:
  eid=event['id'];p=folder(key,eid);items=[]
  for f in sorted(p.glob('*.json'),reverse=True) if p.is_dir() else []:
   if not ID.fullmatch(f.stem):continue
   try:
    m,_=inspect(key,eid,f.stem)
    items.append({'id':f.stem,'state':'ready','download':f'/case-review-video/{key}/{eid}/{f.stem}.mp4','positionOnlyRepresentation':m.get('positionOnlyRepresentation'),'playerOrientation':m.get('playerOrientation','map'),'poseMode':m.get('poseMode','map'),**({'fallbackPeople':m['fallbackPeople']} if isinstance(m.get('fallbackPeople'),list) and all(isinstance(x,str) for x in m['fallbackPeople']) else {}),**({'positionOnlyPeople':m['positionOnlyPeople']} if isinstance(m.get('positionOnlyPeople'),list) and all(isinstance(x,str) for x in m['positionOnlyPeople']) else {})})
   except RuntimeError as e:items.append({'id':f.stem,'state':'stale','message':'광각 심판의 위치만 확인돼 시점 검수가 필요합니다.' if '위치만 관측된' in str(e) else '장면이나 원본이 바뀌어 다시 제작해야 합니다.'})
   except (OSError,ValueError,KeyError,StopIteration,json.JSONDecodeError):items.append({'id':f.stem,'state':'error','message':'영상의 출처 또는 파일을 확인할 수 없습니다.'})
  rows.append({'eventId':eid,'number':event['number'],'items':items,'jobs':sorted(jobs[eid],key=lambda x:x.get('createdAt',''),reverse=True)[:10]})
 try:video_jobs.executable();available=video_jobs.enabled()
 except RuntimeError:available=False
 return {'caseId':key,'renderAvailable':available,'renderVersion':video_jobs.VERSION,'events':rows}
def file(key,event,job):return inspect(key,event,job)[1]
