"""Operator-confirmed cross-view sequence evidence; never inference or verdicts.

A frame pair is an anchor, not proof of a whole sequence. All edited evidence is
bound to both video hashes and the pair revision; previous files are immutable.
"""
import copy,hashlib,json,math,re
from pathlib import Path
import cv2,numpy as np
from job_store import atomic,digest,lease,now

CHECKS=('start','middle','end')

def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def stamp(path,index):
    if type(index)!=int or index<0:raise ValueError('프레임 번호를 확인하세요.')
    cap=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    try:
        fps=float(cap.get(cv2.CAP_PROP_FPS));total=round(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not math.isfinite(fps) or not 1<=fps<=120 or index>=total:raise ValueError('영상 프레임 범위를 확인하세요.')
        cap.set(cv2.CAP_PROP_POS_FRAMES,index);ok,image=cap.read();actual=round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1;pts=cap.get(cv2.CAP_PROP_POS_MSEC)/1000
        if not ok or actual!=index or not math.isfinite(pts) or (index>0 and pts<=0):raise ValueError('영상의 실제 프레임 시각을 확인할 수 없습니다.')
        return {'frameIndex':index,'pts':round(pts,6),'fps':fps,'frames':total,'width':image.shape[1],'height':image.shape[0]}
    finally:cap.release()

def span(path):
    cap=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    try:total=round(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    finally:cap.release()
    if total<2:raise ValueError('광각 구간의 프레임이 부족합니다.')
    first=stamp(path,0);prev=stamp(path,total-2);last=stamp(path,total-1);step=last['pts']-prev['pts']
    if step<=0 or step>.25 or first['pts']<0 or first['pts']>.25:raise ValueError('광각 조각의 시간 기준을 확인할 수 없습니다.')
    return {'firstPts':first['pts'],'lastPts':last['pts'],'endPts':round(last['pts']+step,6),'fps':last['fps'],'frames':total,'lastFrameSeconds':round(step,6)}

def boundary(left,right):
    if left.get('sessionId')!=right.get('sessionId') or right.get('part')!=left.get('part',-2)+1:return {'state':'unavailable','reason':'연속 녹화 조각이 아닙니다.'}
    gap=(right['startSeconds']+right['firstPts'])-(left['startSeconds']+left['endPts']);tol=max(left['lastFrameSeconds'],right['lastFrameSeconds'])*1.5
    state='contiguous-metadata' if abs(gap)<=tol else 'gap' if gap>0 else 'overlap'
    return {'state':state,'gapSeconds':round(gap,6),'toleranceSeconds':round(tol,6),'verified':'시간정보 대조만 수행 · 실제 중복·누락 화면은 사람 확인 필요'}

def context(key,eid):
    import review_intake,wide_pairing
    data=review_intake.load(key);event=next((e for e in data['events'] if e['id']==eid),None)
    if not event:raise ValueError('판독 장면을 확인하세요.')
    sel=event.get('selection') or {};pair=sel.get('widePair')
    if not pair or sel.get('wideChoice')!='paired':raise ValueError('먼저 중계·광각의 같은 순간을 확정하세요.')
    item=next((m for m in data['media'] if m['id']==sel.get('mediaId')),None)
    if not item or item.get('sha256')!=sel.get('sourceSha256') or pair.get('broadcastSha256')!=item.get('sha256') or pair.get('broadcastFrame')!=sel.get('frameIndex'):raise ValueError('선택한 중계 원본 또는 프레임이 바뀌었습니다.')
    rows=wide_pairing.sources(data,eid);source=next((r for r in rows if r.get('id')==pair['sourceId']),None)
    if not source or source.get('sourceSha256')!=pair.get('sourceSha256'):raise ValueError('선택한 광각 원본이 바뀌었거나 준비되지 않았습니다.')
    media=review_intake.media_path(key,item['id']);ident={'broadcastSha256':item['sha256'],'broadcastFrame':sel['frameIndex'],'wideSha256':pair['sourceSha256'],'wideFrame':pair['frameIndex'],'pairRevision':pair['revision'],'wideSourceId':pair['sourceId']}
    return data,event,item,pair,rows,source,Path(media),ident

def path(key,eid):
    import review_intake
    if not re.fullmatch(r'review-\d+',eid):raise ValueError('판독 장면을 확인하세요.')
    return review_intake.folder(key)/'sequence-sync'/f'{eid}.json'

def source_rows(key,eid,rows,source,broadcast,wide,last_broadcast):
    if all(k in source for k in ('part','sessionId','matchId','startSeconds')):
        # Select all locally available parts covering the broadcast clip.
        # Missing parts remain gaps and are never fetched or silently skipped.
        same=sorted((r for r in rows if r.get('sessionId')==source['sessionId'] and r.get('matchId')==source['matchId'] and 'startSeconds' in r),key=lambda r:r['startSeconds'])
        origin=float(source['startSeconds'])+wide['pts']-broadcast['pts']
        lo=origin;hi=origin+last_broadcast['pts']+1/broadcast['fps']
        candidates=[]
        for i,r in enumerate(same):
            start=float(r['startSeconds']);end=float(same[i+1]['startSeconds']) if i+1<len(same) else start+float(r.get('duration',60))
            if r.get('id')==source.get('id') or (start<=hi and end>=lo):candidates.append(r)
    else:candidates=[source]
    result=[]
    for r in sorted(candidates,key=lambda x:x.get('part',0)):
        if not r.get('sourceSha256') or not Path(r['path']).is_file():continue
        if sha(r['path'])!=r['sourceSha256']:continue
        sample=span(r['path']);result.append({'id':r['id'],'sha256':r['sourceSha256'],'part':r.get('part'),'sessionId':r.get('sessionId'),
            'startSeconds':float(r.get('startSeconds',0)),'url':f'/api/intake/{key}/wide/{eid}/media/{r["id"]}.mp4',**sample})
    for i,r in enumerate(result):r['previousBoundary']=boundary(result[i-1],r) if i else None
    return result

def view(key,eid):
    data,event,item,pair,rows,source,media,identity=context(key,eid)
    if sha(media)!=identity['broadcastSha256'] or sha(source['path'])!=identity['wideSha256']:raise ValueError('원본 파일 해시가 저장된 선택과 다릅니다.')
    b=stamp(media,identity['broadcastFrame']);w=stamp(source['path'],identity['wideFrame']);last_broadcast=stamp(media,b['frames']-1);segments=source_rows(key,eid,rows,source,b,w,last_broadcast)
    source_row=next((s for s in segments if s['id']==pair['sourceId']),None)
    if not source_row:raise ValueError('기준 광각 구간의 시간을 확인할 수 없습니다.')
    p=path(key,eid);record=json.loads(p.read_text()) if p.exists() else None
    stale=bool(record and record.get('identity')!=identity)
    if stale:record=None
    review=[]
    if record:
        court=record.get('court') or {};checks=record.get('checkpoints') or {}
        for observation in record.get('observations',[]):
            cp=checks.get(observation.get('checkpoint')) or {};wide=cp.get('wide') or {};broadcast=cp.get('broadcast') or {}
            same=(observation.get('wideSourceId')==cp.get('wideSourceId') and observation.get('wideFrame')==wide.get('frameIndex') and observation.get('broadcastFrame')==broadcast.get('frameIndex') and any(seg['id']==cp.get('wideSourceId') and seg['sha256']==cp.get('wideSha256') for seg in segments))
            if observation.get('visibility')=='wide-observed':same=bool(same and court and observation.get('courtRevision')==digest(court))
            review.append({'id':observation.get('id'),'checkpoint':observation.get('checkpoint'),'state':'current' if same else 'needs-review'})
    selected_checkpoint=None
    if pair.get('method')=='operator-frame-pair' and pair.get('scope')=='selected-instant' and pair.get('confirmedAt'):
        selected_checkpoint={'broadcast':b,'wide':w,'wideSourceId':source_row['id'],'wideSha256':source_row['sha256'],
            'wideGlobalPts':round(source_row['startSeconds']+w['pts'],6),'differenceSeconds':0.0,'anchorId':'start',
            'confirmed':True,'confirmedAt':pair['confirmedAt'],'boundaryIssues':[],'basis':'saved-operator-frame-pair'}
    scoped=coverage(record,segments)
    if record:
        record=copy.deepcopy(record)
        record['verifiedRanges']=scoped['verifiedRanges']
        record['syncStatus']='cut-needs-anchor' if scoped['unresolvedBreakFrames'] else 'verified-ranges' if scoped['verifiedRanges'] else 'checkpoints-only'
    return {'identity':identity,'anchor':{'broadcast':b,'wide':w,'wideGlobalPts':round(source_row['startSeconds']+w['pts'],6)},
        'segments':segments,'record':record,'selectedCheckpoint':selected_checkpoint,'coverage':scoped,'stale':stale,'observationReview':review,'version':digest([identity,record]),
        'guidance':'기준점은 한 순간입니다. 시작·중간·끝을 직접 확인하고, 컷·슬로모션·구간 경계는 별도로 검수하세요.'}

def active_anchor(state,record,pts):
    """Return the last explicitly reviewed anchor; never cross a marked cut."""
    base={**state['anchor'],'id':'start'}
    anchors=[base]+[a for a in record.get('extraAnchors',[]) if a['broadcast']['pts']<=pts]
    anchor=max(anchors,key=lambda x:x['broadcast']['pts'])
    if anchor['id']!='start' and not any(x['id']==anchor['wideSourceId'] and x['sha256']==anchor['wideSha256'] for x in state['segments']):raise ValueError('새 기준의 광각 원본이 없거나 변경됐습니다. 다시 확인하세요.')
    left,right=sorted((anchor['broadcast']['pts'],pts))
    if any(left < x['broadcast']['pts'] <= right or (anchor['id']=='start' and x['broadcast']['pts']==anchor['broadcast']['pts'] and pts>=anchor['broadcast']['pts']) for x in record.get('breaks',[])):
        raise ValueError('표시된 전환 이후에는 같은 순간을 새 기준으로 저장해야 합니다.')
    return anchor

def segment_fingerprint(segments,ids):
    selected=[{k:s.get(k) for k in ('id','sha256','part','startSeconds','firstPts','endPts','previousBoundary')} for s in segments if s['id'] in ids]
    return digest(selected) if len(selected)==len(ids) else None

def coverage(record,segments):
    record=record or {};anchors=[a for a in record.get('extraAnchors',[]) if any(s['id']==a.get('wideSourceId') and s['sha256']==a.get('wideSha256') for s in segments)];breaks=record.get('breaks',[])
    ranges=[r for r in record.get('verifiedRanges',[]) if r.get('segmentIds') and r.get('segmentDigest')==segment_fingerprint(segments,r['segmentIds'])]
    unresolved=[]
    for i,b in enumerate(breaks):
        end=breaks[i+1]['broadcast']['pts'] if i+1<len(breaks) else float('inf')
        if not any(b['broadcast']['pts']<=a['broadcast']['pts']<end for a in anchors):unresolved.append(b['broadcast']['frameIndex'])
    return {'verifiedRanges':ranges,'unresolvedBreakFrames':unresolved,'default':'unverified','method':'operator-reviewed ranges only; not automatic continuity proof'}

def finite(v):return type(v) in (int,float) and math.isfinite(v)

def court_map(points,side):
    if not isinstance(points,list) or not 4<=len(points)<=20:raise ValueError('같은 코트 바닥 기준점을 네 개 이상 지정하세요.')
    pixels=[];floor=[];names=set()
    for p in points:
        if not isinstance(p,dict):raise ValueError('코트 기준점 형식을 확인하세요.')
        name=p.get('name');xy=p.get('court');xy_img=p.get(side)
        if not isinstance(name,str) or not name.strip() or name in names or len(name)>80:raise ValueError('코트 기준점 이름은 중복 없이 입력하세요.')
        if not isinstance(xy,list) or len(xy)!=2 or not all(finite(v) for v in xy) or not (0<=xy[0]<=28 and 0<=xy[1]<=15):raise ValueError('코트 기준 좌표를 확인하세요.')
        if not isinstance(xy_img,list) or len(xy_img)!=2 or not all(finite(v) for v in xy_img) or any(v<0 for v in xy_img):raise ValueError('영상 기준점 좌표를 확인하세요.')
        names.add(name);floor.append(xy);pixels.append(xy_img)
    a=np.array(pixels,dtype=np.float64);b=np.array(floor,dtype=np.float64)
    if cv2.contourArea(cv2.convexHull(a.astype(np.float32)))<100 or cv2.contourArea(cv2.convexHull(b.astype(np.float32)))<1:raise ValueError('한 직선에 몰리지 않은 코트 기준점을 선택하세요.')
    H,_=cv2.findHomography(a,b,0)
    if H is None or not np.isfinite(H).all() or abs(np.linalg.det(H))<1e-12:raise ValueError('코트 좌표 변환을 확인할 수 없습니다.')
    pred=cv2.perspectiveTransform(a.reshape(-1,1,2),H).reshape(-1,2);errors=np.linalg.norm(pred-b,axis=1)
    if not np.isfinite(errors).all() or max(errors)>.75:raise ValueError('기준점이 서로 맞지 않습니다. 같은 바닥 선을 다시 확인하세요.')
    return {'imageToCourt':H.tolist(),'fitMaxMeters':round(float(max(errors)),4),'independentHoldoutVerified':False,'coordinateSystem':'operator-labelled 28m x 15m floor'}

def save(key,eid,payload):
    if not isinstance(payload,dict):raise ValueError('저장할 동기화 내용을 확인하세요.')
    file=path(key,eid)
    with lease(file.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('동기화 기록을 저장 중입니다.')
        state=view(key,eid)
        if payload.get('version')!=state['version']:raise RuntimeError('선택 또는 동기화 기록이 바뀌었습니다. 다시 불러오세요.')
        data,event,item,pair,rows,source,media,identity=context(key,eid)
        old=json.loads(file.read_text()) if file.exists() else None
        active=state['record'];record=copy.deepcopy(active) if active else {'schema':'kbl-sequence-sync/v1','identity':identity,'checkpoints':{},'observations':[],'revision':0}
        op=payload.get('operation')
        if op=='checkpoint':
            label=payload.get('label');sid=payload.get('wideSourceId');bf=payload.get('broadcastFrame');wf=payload.get('wideFrame')
            if label not in CHECKS or payload.get('confirmed') is not True:raise ValueError('화면을 비교하고 확인해 주세요.')
            seg=next((s for s in state['segments'] if s['id']==sid),None);row=next((r for r in rows if r.get('id')==sid),None)
            if not seg or not row or sha(row['path'])!=seg['sha256']:raise ValueError('광각 원본 또는 구간을 확인하세요.')
            b=stamp(media,bf);w=stamp(row['path'],wf)
            for value,frame_data in [(payload.get('broadcastDisplayedPts'),b),(payload.get('wideDisplayedPts'),w)]:
                if not finite(value) or abs(value-frame_data['pts'])>max(.004,.55/frame_data['fps']):raise ValueError('표시된 프레임과 저장할 프레임이 다릅니다. 다시 확인하세요.')
            if label=='start' and (bf!=identity['broadcastFrame'] or sid!=identity['wideSourceId'] or wf!=identity['wideFrame']):raise ValueError('시작 확인은 저장된 기준 프레임 쌍이어야 합니다.')
            anchor=active_anchor(state,record,b['pts']);predicted=anchor['wideGlobalPts']+(b['pts']-anchor['broadcast']['pts']);actual=seg['startSeconds']+w['pts'];error=round(actual-predicted,6)
            boundary_issues=[s['previousBoundary'] for s in state['segments'] if s['previousBoundary'] and s['previousBoundary']['state']!='contiguous-metadata' and min(predicted,anchor['wideGlobalPts'])<=s['startSeconds']<=max(predicted,anchor['wideGlobalPts'])]
            record['checkpoints'][label]={'broadcast':b,'wide':w,'wideSourceId':sid,'wideSha256':seg['sha256'],'wideGlobalPts':round(actual,6),'differenceSeconds':error,'anchorId':anchor['id'],'confirmed':True,'confirmedAt':now(),'boundaryIssues':boundary_issues}
            ordered=[record['checkpoints'][x]['broadcast']['pts'] for x in CHECKS if x in record['checkpoints']]
            if any(a>=b for a,b in zip(ordered,ordered[1:])):raise ValueError('시작·중간·끝은 시간 순서대로 서로 다른 프레임이어야 합니다.')
            record['verifiedRanges']=[];record['syncStatus']='checkpoints-only'
        elif op=='break':
            frame=payload.get('broadcastFrame');displayed=payload.get('broadcastDisplayedPts');kind=payload.get('kind');note=payload.get('note','')
            if kind not in ('cut','replay','slow-motion','unknown') or payload.get('confirmed') is not True or not isinstance(note,str) or len(note)>300:raise ValueError('중계 전환·끊김 확인 내용을 입력하세요.')
            b=stamp(media,frame)
            if not finite(displayed) or abs(displayed-b['pts'])>max(.004,.55/b['fps']):raise ValueError('표시된 중계 프레임을 다시 확인하세요.')
            row={'broadcast':b,'kind':kind,'note':note.strip(),'confirmedAt':now()}
            record['breaks']=[x for x in record.get('breaks',[]) if x['broadcast']['frameIndex']!=frame]+[row]
            record['breaks'].sort(key=lambda x:x['broadcast']['pts']);record['verifiedRanges']=[];record['syncStatus']='cut-needs-anchor'
        elif op=='remove-break':
            frame=payload.get('broadcastFrame')
            if type(frame)!=int or payload.get('confirmed') is not True:raise ValueError('취소할 전환 표시를 확인하세요.')
            old_breaks=record.get('breaks',[]);record['breaks']=[x for x in old_breaks if x['broadcast']['frameIndex']!=frame]
            if len(old_breaks)==len(record['breaks']):raise ValueError('취소할 전환 표시가 없습니다.')
            record['verifiedRanges']=[];record['syncStatus']='checkpoints-only'
        elif op=='anchor':
            sid=payload.get('wideSourceId');bf=payload.get('broadcastFrame');wf=payload.get('wideFrame')
            if payload.get('confirmed') is not True:raise ValueError('두 영상의 같은 순간을 직접 확인해 주세요.')
            seg=next((s for s in state['segments'] if s['id']==sid),None);row=next((r for r in rows if r.get('id')==sid),None)
            if not seg or not row or sha(row['path'])!=seg['sha256']:raise ValueError('광각 원본 또는 구간을 확인하세요.')
            b=stamp(media,bf);w=stamp(row['path'],wf)
            for value,frame_data in [(payload.get('broadcastDisplayedPts'),b),(payload.get('wideDisplayedPts'),w)]:
                if not finite(value) or abs(value-frame_data['pts'])>max(.004,.55/frame_data['fps']):raise ValueError('표시된 프레임과 저장할 프레임이 다릅니다.')
            if b['pts']<=state['anchor']['broadcast']['pts']:raise ValueError('추가 기준은 시작 기준 이후에 지정하세요.')
            extra={'id':'F'+str(bf)+'-'+digest([sid,wf])[:12],'broadcast':b,'wide':w,'wideSourceId':sid,'wideSha256':seg['sha256'],'wideGlobalPts':round(seg['startSeconds']+w['pts'],6),'confirmedAt':now()}
            record['extraAnchors']=[x for x in record.get('extraAnchors',[]) if x['broadcast']['frameIndex']!=bf]+[extra]
            record['extraAnchors'].sort(key=lambda x:x['broadcast']['pts']);record['verifiedRanges']=[];record['syncStatus']='checkpoints-only'
        elif op=='verify-range':
            first=payload.get('from');last=payload.get('to');checks=record.get('checkpoints',{})
            if payload.get('confirmed') is not True or first not in CHECKS or last not in CHECKS or first not in checks or last not in checks:raise ValueError('범위 전체를 직접 검수하고 양끝 확인 지점을 선택하세요.')
            a,b=checks[first],checks[last];lo,hi=a['broadcast']['pts'],b['broadcast']['pts']
            if lo>=hi:raise ValueError('검수 범위는 시간 순서대로 선택하세요.')
            aa=active_anchor(state,record,lo);ab=active_anchor(state,record,hi)
            if aa['id']!=ab['id'] or a.get('anchorId','start')!=aa['id'] or b.get('anchorId','start')!=ab['id']:raise ValueError('같은 기준점에 속한 확인 지점으로 범위를 다시 지정하세요.')
            if any(lo < x['broadcast']['pts'] <= hi for x in record.get('breaks',[])) or any(abs(x.get('differenceSeconds',999))>.1 or x.get('boundaryIssues') for x in (a,b)):
                raise ValueError('전환 또는 미확인 간격이 있는 범위는 확인 완료로 저장할 수 없습니다.')
            wa,wb=sorted((a['wideGlobalPts'],b['wideGlobalPts']))
            ids=[s['id'] for s in state['segments'] if s['startSeconds']+s['firstPts']<=wb+.001 and s['startSeconds']+s['endPts']>=wa-.001]
            if not ids:raise ValueError('검수 범위의 광각 원본이 없습니다.')
            verified={'from':first,'to':last,'startFrame':a['broadcast']['frameIndex'],'endFrame':b['broadcast']['frameIndex'],'startPts':lo,'endPts':hi,'anchorId':aa['id'],'segmentIds':ids,'segmentDigest':segment_fingerprint(state['segments'],ids),'review':'operator-confirmed-full-range','confirmedAt':now()}
            record['verifiedRanges']=[r for r in record.get('verifiedRanges',[]) if (r['from'],r['to'])!=(first,last)]+[verified];record['syncStatus']='verified-ranges'
        elif op=='court':
            label=payload.get('checkpoint');cp=record['checkpoints'].get(label)
            if not cp and label=='start' and state.get('selectedCheckpoint'):
                cp=copy.deepcopy(state['selectedCheckpoint']);record['checkpoints']['start']=cp;record['syncStatus']='checkpoints-only'
            if not cp or payload.get('confirmed') is not True:raise ValueError('먼저 같은 순간을 직접 확인하세요.')
            points=payload.get('points');bm=court_map(points,'broadcast');wm=court_map(points,'wide')
            for point in points:
                for side,frame in [('broadcast',cp['broadcast']),('wide',cp['wide'])]:
                    if not (point[side][0]<frame['width'] and point[side][1]<frame['height']):raise ValueError('기준점이 영상 밖에 있습니다.')
            basket=payload.get('basketA','');attack=payload.get('homeAttacks','unconfirmed')
            if not isinstance(basket,str) or not basket.strip() or len(basket)>120 or attack not in ('A','B','unconfirmed'):raise ValueError('같은 골대와 공격 방향 확인값을 입력하세요.')
            record['court']={'basketA':basket.strip(),'homeAttacks':attack,'teamDirectionBasis':'operator-confirmed' if attack!='unconfirmed' else 'unconfirmed','checkpoint':label,'wideSourceId':cp['wideSourceId'],'wideFrame':cp['wide']['frameIndex'],'broadcastFrame':cp['broadcast']['frameIndex'],'points':copy.deepcopy(points),'broadcastMap':bm,'wideMap':wm,'confirmed':True,'confirmedAt':now(),'status':'operator-confirmed-floor; accuracy-unverified'}
        elif op=='observation':
            label=payload.get('checkpoint');cp=record['checkpoints'].get(label);court=record.get('court');oid=payload.get('officialId');status=payload.get('visibility');note=payload.get('note','')
            if not cp or not isinstance(oid,str) or not re.fullmatch(r'R[1-3]|unknown-[a-zA-Z0-9_-]{1,32}',oid) or status not in ('wide-observed','not-observed') or not isinstance(note,str) or len(note)>300:raise ValueError('심판·관측 상태·확인 근거를 확인하세요.')
            if payload.get('confirmed') is not True:raise ValueError('영상에서 심판을 직접 확인하세요.')
            row={'id':oid,'checkpoint':label,'broadcastFrame':cp['broadcast']['frameIndex'],'broadcastPts':cp['broadcast']['pts'],'wideFrame':cp['wide']['frameIndex'],'widePts':cp['wide']['pts'],'wideSourceId':cp['wideSourceId'],'wideSha256':cp['wideSha256'],'visibility':status,'note':note.strip(),'review':'operator-confirmed','savedAt':now()}
            if status=='wide-observed':
                if not court or court['checkpoint']!=label or court['wideSourceId']!=cp['wideSourceId'] or court['wideFrame']!=cp['wide']['frameIndex'] or court['broadcastFrame']!=cp['broadcast']['frameIndex']:raise ValueError('이 순간의 공통 코트 기준점을 먼저 확인하세요.')
                box=payload.get('wideBox')
                if not isinstance(box,list) or len(box)!=4 or not all(finite(v) for v in box) or not (0<=box[0]<box[2]<=cp['wide']['width'] and 0<=box[1]<box[3]<=cp['wide']['height']):raise ValueError('광각 영상의 심판 박스를 확인하세요.')
                foot=[(box[0]+box[2])/2,box[3]]
                mapped=cv2.perspectiveTransform(np.array(foot,dtype=float).reshape(1,1,2),np.array(court['wideMap']['imageToCourt']))[0,0]
                manual=payload.get('manualXY')
                if manual is not None and (not isinstance(manual,list) or len(manual)!=2 or not all(finite(v) for v in manual)):raise ValueError('수동 코트 좌표를 확인하세요.')
                xy=np.array(manual if manual is not None else mapped,dtype=float)
                if xy.shape!=(2,) or not np.isfinite(xy).all() or not(-2<=xy[0]<=30 and -2<=xy[1]<=17):raise ValueError('코트 밖 위치입니다. 기준점과 심판 발을 다시 확인하세요.')
                if manual is not None and (payload.get('manualConfirmed') is not True or not note.strip()):raise ValueError('수동 위치와 수정 근거를 확인하세요.')
                row.update(wideBox=box,wideFoot=foot,xy=xy.tolist(),mappedXY=mapped.tolist(),positionSource='manual-court-placement' if manual is not None else 'wide-floor-map',positionStatus='operator-reviewed-estimate',uncertainty='미측정 · 코트 보정 및 동기 검수 필요',courtRevision=digest(court))
            existing=next((v for v in record['observations'] if (v['id'],v['checkpoint'])==(oid,label)),None)
            if existing and payload.get('replace') is not True:raise ValueError('같은 심판 기록이 있습니다. 기존 기록과 중복 여부를 확인하세요.')
            record['observations']=[v for v in record['observations'] if (v['id'],v['checkpoint'])!=(oid,label)]+[row]
        else:raise ValueError('동기화 작업을 확인하세요.')
        if old:
            hist=file.parent/'history';atomic(hist/f'{eid}-{old.get("revision",0)}-{digest(old)[:12]}.json',old)
        record['revision']+=1;record['updatedAt']=now();atomic(file,record)
        return view(key,eid)


def for_case(case_id,eid):
    """Read the same, authorized intake record without inferring or changing it."""
    import case_store
    case=case_store.load_case(case_id);event=next((e for e in case.get('events',[]) if e['id']==eid),None)
    if not event or not case.get('intakeId'):raise ValueError('연결된 판독 자료가 없습니다.')
    result=view(case['intakeId'],eid);pair=(event.get('broadcastSelection') or {}).get('widePair') or {}
    if pair.get('revision')!=result['identity']['pairRevision'] or event.get('selectedBroadcastFrame')!=result['identity']['broadcastFrame']:
        return {**result,'record':None,'stale':True,'guidance':'현재 분석과 동기 기준이 다릅니다. 다시 확인하세요.'}
    return result
