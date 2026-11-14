"""Resumable numeric clock indexing and bounded multi-camera synchronization.

Game and shot digits are read from lossless source crops. Two numeric clock
sequences must agree before the GPU can verify geometry at that timestamp.
"""
import json,math,time
from pathlib import Path
import cv2,numpy as np
from job_store import atomic,digest,lease
from clock_numeric import parse_game,parse_shot,VERSION as OCR_VERSION
VERSION='wide-clock-numeric-v3-'+OCR_VERSION

def source_rows(mid):
    import wide_preparation as prep
    data=prep.read(mid);rows=data.get('recordings',[])
    selected=next((r for r in rows if r['session_id']==data.get('selectedSessionId')),None)
    if not selected:return None,[]
    return selected,[(p,prep.part_path(mid,selected['session_id'],p['index']),prep.cache_info(mid,selected['session_id'],p)) for p in selected['parts'] if prep.cache_info(mid,selected['session_id'],p)]

def extract(path,seconds):
    cap=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);fps=cap.get(cv2.CAP_PROP_FPS);total=round(cap.get(cv2.CAP_PROP_FRAME_COUNT));index=round(seconds*fps)
    if 1<=fps<=120 and 0<=seconds<total/fps:index=min(total-1,index)
    if not 1<=fps<=120 or not 0<=index<total:cap.release();raise ValueError('광각 시점이 영상 범위를 벗어났습니다.')
    cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();actual=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;cap.release()
    if not ok or actual!=index:raise RuntimeError('광각 기준 프레임 읽기에 실패했습니다.')
    return image,index,fps

def sample_clip(path,seconds,folder,regions=None,broadcast=False):
    """Read source pixels and preserve frame/decoder PTS, one decoder at a time."""
    import clock_numeric
    cv2.setNumThreads(1);cap=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);fps=cap.get(cv2.CAP_PROP_FPS);total=int(cap.get(cv2.CAP_PROP_FRAME_COUNT));images=[];rows=[]
    result=[]
    def flush():
        proposals=[clock_numeric.broadcast_regions(im) if broadcast else regions or clock_numeric.regions(im) for im in images]
        reads=clock_numeric.read_images(images,folder,proposals)
        result.extend({**r,**v} for r,v in zip(rows,reads));images.clear();rows.clear()
    try:
        for t in sorted(set(seconds)):
            index=round(t*fps)
            if not 0<=index<total:continue
            cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read()
            if not ok:continue
            pts=cap.get(cv2.CAP_PROP_POS_MSEC)/1000
            # PTS is retained; average FPS is only used to locate a nearby frame.
            rows.append({'time':pts if pts>0 or index==0 else index/fps,'frameIndex':index,'fps':fps,
                'width':image.shape[1],'height':image.shape[0],
                'timestampBasis':'decoder-pts' if pts>0 or index==0 else 'nominal-fps'})
            images.append(image)
            if len(images)>=4:flush()
        if images:flush()
        return result
    finally:cap.release()

def build_index(mid,stage=lambda s:None,max_seconds=180):
    import wide_preparation as prep,clock_numeric
    cv2.setNumThreads(1);row,parts=source_rows(mid)
    if not row or not parts:return {'state':'source-pending','samples':[]}
    root=prep.folder(mid)/'clock-index';root.mkdir(exist_ok=True)
    file=root/(row['session_id']+'-numeric.json');data=json.loads(file.read_text()) if file.exists() else {'version':VERSION,'samples':{}}
    if data.get('version')!=VERSION:data={'version':VERSION,'samples':{}}
    valid={(p['index'],c['sha256']) for p,_,c in parts}
    data['samples']={k:s for k,s in data['samples'].items() if (s['part'],s['sourceSha256']) in valid}
    start=time.monotonic();total=sum(max(1,math.ceil(p['duration']/15)) for p,_,_ in parts);done=0
    with lease(root/'numeric-index.lock') as acquired:
        if not acquired:return {'state':'indexing','samples':list(data['samples'].values())}
        for part,path,cache in parts:
            for seconds in np.arange(0,part['duration'],15):
                key=digest([cache['sha256'],float(seconds),VERSION])
                if key in data['samples']:done+=1;continue
                if time.monotonic()-start>max_seconds:
                    atomic(file,data);return {'state':'partial','samples':list(data['samples'].values())}
                stage(f'광각 숫자 시계 색인 · {done}/{total}개 ({round(done/total*100)}%)')
                readings=sample_clip(path,[float(seconds)],root/'numeric-ocr')
                if readings:
                    reading=readings[0];data['samples'][key]={**reading,'part':part['index'],'sourceSha256':cache['sha256'],'seconds':reading['time'],'globalSeconds':part['start_seconds']+reading['time']}
                done+=1;atomic(file,data)
    samples=sorted(data['samples'].values(),key=lambda s:s['globalSeconds'])
    return {'state':'complete','samples':samples,'readableSamples':sum(s['status']=='read' for s in samples),'totalSamples':len(samples)}

def candidate_windows(samples,game,shot=None):
    # Coarse samples locate the game time; fine search requires BOTH clocks.
    readings=sorted([s for s in samples if s.get('status')=='read'],key=lambda s:s['globalSeconds']);windows=[]
    for row in readings:
        if abs(row['game']-game)>20:continue
        center=row['globalSeconds']+row['game']-game
        if not any(abs(center-w['center'])<18 for w in windows):windows.append({'center':center,'sample':row})
    return windows

def locate(mid,image,stage=lambda s:None,source_path=None,frame_index=None):
    """Dual-clock numeric sequence matching; no visual-signature fallback."""
    import wide_preparation as prep,clock_numeric
    root=prep.folder(mid)/'clock-index';root.mkdir(parents=True,exist_ok=True)
    def unavailable(reason,**extra):return {'state':'needs-review','reason':reason,'candidates':[],'frameAccurateSyncVerified':False,**extra}
    if source_path is None or frame_index is None:return unavailable('broadcast-sequence-required')
    cap=cv2.VideoCapture(str(source_path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);fps=cap.get(cv2.CAP_PROP_FPS);cap.release()
    if not 1<=fps<=120:return unavailable('broadcast-fps-invalid')
    selected=frame_index/fps
    primary=sample_clip(source_path,np.arange(max(0,selected-3),selected+3,.1).tolist()+[selected],root/'numeric-ocr',broadcast=True)
    target=min(primary,key=lambda r:abs(r['frameIndex']-frame_index)) if primary else {}
    if target.get('status')!='read':return unavailable('broadcast-dual-clock-unreadable')
    if len(clock_numeric.transitions(primary,'game'))+len(clock_numeric.transitions(primary,'shot'))<3:return unavailable('broadcast-clocks-static-or-unreadable')
    indexed=build_index(mid,stage);row,parts=source_rows(mid)
    if not row or len(parts)!=len(row['parts']):return {'state':'source-pending','reason':'source-cache-incomplete','candidates':[]}
    if indexed['state']!='complete':return {'state':'source-pending','reason':'numeric-clock-index-incomplete','candidates':[]}
    windows=candidate_windows(indexed['samples'],target['game'],target['shot'])
    if not windows:return unavailable('wide-dual-clock-unreadable-or-not-found')
    if len(windows)>8:return unavailable('too-many-clock-windows')
    started=time.monotonic();chosen=[]
    for n,window in enumerate(windows):
        if time.monotonic()-started>120:return unavailable('alignment-search-budget')
        stage(f'경기·공격 시계 숫자 대조 · {n+1}/{len(windows)}구간')
        coarse=[];roi=[v['regions'] for v in window['sample'].get('readings',[]) if v.get('game') is not None and v.get('shot') is not None][:2]
        # Read each source segment with its own frame time, including boundaries.
        def scan(start,end,step):
            values=[]
            for p,path,cache in parts:
                lo=max(start,p['start_seconds']);hi=min(end,p['start_seconds']+p['duration']-.04)
                if lo>hi:continue
                reads=sample_clip(path,np.arange(lo-p['start_seconds'],hi-p['start_seconds'],step),root/'numeric-ocr',regions=roi or None)
                for r in reads:values.append({**r,'time':p['start_seconds']+r['time'],'part':p['index'],'seconds':r['time'],'sourceSha256':cache['sha256'],'sessionId':row['session_id']})
            return values
        coarse=scan(window['center']-20,window['center']+20,1.)
        hits=[r for r in coarse if r.get('status')=='read' and abs(r['game']-target['game'])<=1 and abs(r['shot']-target['shot'])<=1]
        centers=[]
        for hit in hits:
            if not any(abs(hit['time']-t)<4 for t in centers):centers.append(hit['time'])
        for center in centers:
            if time.monotonic()-started>120:return unavailable('alignment-search-budget')
            secondary=scan(center-4,center+4,.1)
            result=clock_numeric.align_sequences(primary,secondary,target['time'])
            if result['state']!='matched':continue
            # Use a decoded source PTS, including frames where OCR was blank.
            # Average frame rate is not an exact frame-to-time mapping for VFR.
            exact=min(secondary,key=lambda r:abs(r['time']-result['time']))
            quantization=abs(exact['time']-result['time'])
            if exact['timestampBasis']!='decoder-pts' or result['uncertaintySeconds']+quantization>.2:continue
            result={**result,'uncertaintySeconds':result['uncertaintySeconds']+quantization,'selectedFrameTime':exact['time']}
            candidate={k:exact[k] for k in ('part','seconds','frameIndex','fps','sourceSha256','sessionId')}
            candidate.update(globalSeconds=exact['time'],clockAlignment=result)
            if not any(abs(candidate['globalSeconds']-c['globalSeconds'])<.5 for c in chosen):chosen.append(candidate)
    if len(chosen)>1:return unavailable('multiple-clock-sequences',matches=chosen)
    if not chosen:return unavailable('no-verified-dual-clock-sequence')
    return {'state':'candidates','method':'numeric-game-and-shot-clock-transitions; geometry verification required','candidates':chosen,'frameAccurateSyncVerified':False}
