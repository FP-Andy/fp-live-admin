"""Bounded fallback when tiny scoreboard digits cannot locate an incident.

CSV entry time only narrows a search window; it is never a synchronization claim.
The T4 sees <=150 sampled frames in one small transport video, then inspects the
original source around the best layout candidates. No local detector is used.
"""
import json,re,time
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
import cv2,numpy as np
from job_store import digest,atomic
from wide_clock import source_rows,extract

def timestamp(value):
    if not isinstance(value,str):return None
    try:return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Seoul'))
    except ValueError:pass
    m=re.fullmatch(r'\s*(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*',value)
    if not m:return None
    y,month,d,ampm,h,minute,second=m.groups();h=int(h)
    if ampm:h=h%12+(12 if ampm=='오후' else 0)
    try:return datetime(int(y),int(month),int(d),h,int(minute),int(second or 0),tzinfo=ZoneInfo('Asia/Seoul'))
    except ValueError:return None

def window(recording,event):
    recorded=timestamp(event.get('recordedAt'));start=timestamp(recording.get('created_at'));end=timestamp(recording.get('stopped_at'))
    if not recorded or not start:return None
    elapsed=(recorded-start).total_seconds();duration=recording['duration']
    gap=max(0,(end-start).total_seconds()-duration) if end else 0
    # Entry delay and recording interruptions widen the search; never silently
    # subtract a guessed offset and treat it as an aligned frame.
    lo=max(0,elapsed-gap-float(event.get('reviewDurationSeconds') or 0)-600)
    hi=min(duration-.1,elapsed+30)
    if lo>=hi or hi-lo>1200:return None
    return lo,hi

def prepare(mid,event,root,stage=lambda s:None):
    recording,parts=source_rows(mid)
    if not recording or len(parts)!=len(recording['parts']):return None
    bounds=window(recording,event)
    if not bounds:return None
    times=np.linspace(*bounds,min(150,max(2,int((bounds[1]-bounds[0])/5)+1)))
    selections=[]
    for t in times:
        source=next(((p,path,cache) for p,path,cache in parts if p['start_seconds']<=t<p['start_seconds']+p['duration']),None)
        if not source:continue
        p,path,cache=source
        selections.append({'part':p['index'],'seconds':float(t-p['start_seconds']),'sourceSha256':cache['sha256'],
            'sessionId':recording['session_id'],'globalSeconds':float(t),'path':str(path)})
    root=Path(root)/digest(['wide-search-v1',selections])[:16];root.mkdir(parents=True,exist_ok=True)
    video=root/'search.mp4';manifest=root/'frames.json'
    if video.exists() and manifest.exists():return video,json.loads(manifest.read_text())
    cv2.setNumThreads(1);writer=None;rows=[];started=time.monotonic();partial=root/'search-building.mp4'
    try:
        for n,candidate in enumerate(selections):
            if time.monotonic()-started>90:raise RuntimeError('광각 후보 준비 시간 제한 · 받은 원본은 유지됩니다.')
            stage(f'광각 장면 탐색용 프레임 준비 · {n+1}/{len(selections)}개')
            try:im,index,fps=extract(candidate['path'],candidate['seconds'])
            except ValueError:continue
            im=cv2.resize(im,(1280,720))
            if writer is None:
                writer=cv2.VideoWriter(str(partial),cv2.VideoWriter_fourcc(*'mp4v'),5,(1280,720))
                if not writer.isOpened():raise RuntimeError('광각 후보 영상 인코더를 열지 못했습니다.')
            writer.write(im)
            rows.append({k:v for k,v in candidate.items() if k!='path'}|{'frameIndex':index,'seconds':index/fps,'fps':fps})
    finally:
        if writer:writer.release()
    if len(rows)<5:return None
    partial.replace(video);atomic(manifest,rows);return video,rows
