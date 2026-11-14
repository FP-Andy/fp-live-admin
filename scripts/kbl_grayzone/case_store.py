"""Local review intake and explicit frame selections, separate from verdicts."""
from datetime import datetime, timezone
import json,re
from pathlib import Path
import threading
from read_context import memoized

ROOT=Path(__file__).resolve().parents[2]
CASES={}
MANAGED=ROOT/'outputs/kbl-cases'
for _root in MANAGED.glob('*/case.json'):
    if re.fullmatch(r'[a-z0-9-]+',_root.parent.name):CASES[_root.parent.name]=_root.parent
PUBLISHED=ROOT/'outputs/kbl-role-fusion-20261023/published'
BROADCAST=ROOT/'outputs/kbl-broadcast-20261025/results'
LOCK=threading.Lock()

def broadcast_root(key):
    return CASES[key]/'broadcast-tracks'


def tracking_status(wide):
    folder=PUBLISHED/wide['id']
    if not all((folder/name).is_file() for name in ('ready.json','tracks.json','ball.json')):
        return {'state':'pending','ready':False}
    try:
        ready=json.loads((folder/'ready.json').read_text())
        tracks=json.loads((folder/'tracks.json').read_text())
        if ready.get('inputSha256')!=wide['sha256'] or tracks.get('inputSha256')!=wide['sha256'] or not ready.get('datasetId') or ready['datasetId']!=tracks.get('datasetId'):
            return {'state':'source-mismatch','ready':False}
    except (OSError,ValueError,KeyError):return {'state':'invalid-output','ready':False}
    return {'state':'unreviewed','ready':True,'datasetId':ready['datasetId'],
            'coordinateSpace':ready.get('coordinateSpace','image')}


@memoized
def load_case(key):
    if key not in CASES:raise ValueError('등록되지 않은 경기입니다.')
    root=CASES[key]
    data=json.loads((root/'case.json').read_text())
    saved=root/'selections.json'
    selections=json.loads(saved.read_text()) if saved.exists() else {'revision':0,'events':{}}
    data['revision']=selections['revision']
    import referee_roster
    referee_roster.apply(data,root)
    import case_records
    case_records.apply(data,root)
    if 'trackingCachePolicy' in data:
        import object_cache
        policy=data['trackingCachePolicy']
        object_cache.validate_policy(policy,policy.get('image','') if isinstance(policy,dict) else '')
    for event in data['events']:
        event.update(selections['events'].get(event['id'],{}))
        if 'trackingCachePolicy' in data:event['_trackingCachePolicy']=data['trackingCachePolicy']
        from job_store import digest
        event['selectionVersion']=digest({'source':(event.get('broadcast') or event.get('wide') or {}).get('sha256'),
            'broadcastFrame':event.get('selectedBroadcastFrame'),'wideFrame':event.get('selectedFrame'),**({'widePair':event['broadcastSelection']['widePair']['revision']} if event.get('broadcastSelection',{}).get('widePair') else {})})
        event['broadcastTrackingReady']=False
        if event.get('broadcast'):
            packet=broadcast_root(key)/f"{event['id']}.json"
            if packet.is_file():
                try:
                    broadcast=json.loads(packet.read_text())
                    event['broadcastTrackingReady']=broadcast.get('inputSha256')==event['broadcast']['sha256'] and broadcast.get('eventId')==event['id']
                except (OSError,ValueError,KeyError):pass
        wide=event.get('wide')
        if wide:
            event['trackingStatus']=tracking_status(wide)
            event['trackingReady']=event['trackingStatus']['ready']
            if event.get('sourceSha256') and event['sourceSha256']!=wide['sha256']:
                event.update(selectedFrame=None,selectionStatus='source-changed-reselect')
    import uniforms
    data['uniforms']=uniforms.load('cases',key)
    data['selectedCount']=sum(e.get('selectedBroadcastFrame',e.get('selectedFrame')) is not None for e in data['events'])
    return data


def tracking_packet(key,event_id):
    data=load_case(key)
    event=next((e for e in data['events'] if e['id']==event_id),None)
    if event is None:raise ValueError('등록되지 않은 판독 구간입니다.')
    if not event.get('trackingReady'):raise RuntimeError('현재 원본에 해당하는 추적 결과가 아직 없습니다.')
    folder=PUBLISHED/event['wide']['id']
    tracks=json.loads((folder/'tracks.json').read_text())
    pose=None;path=CASES[key]/'pose/predictions.json'
    if path.exists():
        prediction=json.loads(path.read_text())
        pose=next((f for f in prediction['frames'] if f['clipId']==event['wide']['id']
                   and f['frameIndex']==event['selectedFrame'] and f.get('datasetId')==tracks['datasetId']
                   and f.get('inputSha256')==event['wide']['sha256']),None)
    return {'datasetId':tracks['datasetId'],'inputSha256':tracks['inputSha256'],
            'frames':tracks['frames'],'ball':json.loads((folder/'ball.json').read_text()),
            'pose':pose,'detector':tracks['detector'],'coordinateSpace':event['trackingStatus']['coordinateSpace']}


@memoized
def broadcast_packet(key,event_id,include_objects=True,include_evidence=True,include_multiview=True):
    data=load_case(key)
    event=next((e for e in data['events'] if e['id']==event_id),None)
    if event is None:raise ValueError('등록되지 않은 판독 구간입니다.')
    if not event.get('broadcastTrackingReady'):raise RuntimeError('현재 중계 원본의 추적 결과가 없습니다.')
    result=json.loads((broadcast_root(key)/f'{event_id}.json').read_text())
    # Recheck after reading to fail closed if a result was replaced mid-request.
    if result.get('inputSha256')!=event['broadcast']['sha256'] or result.get('eventId')!=event_id:raise RuntimeError('중계 원본이 변경됐습니다.')
    index=event.get('selectedBroadcastFrame')
    extra=CASES[key]/'broadcast-frames'/f'{event_id}-{index}.json'
    if index is not None and extra.is_file():
        extension=json.loads(extra.read_text())
        if extension.get('inputSha256')!=result['inputSha256'] or extension.get('baseDatasetId')!=result['datasetId'] or extension['frame']['frameIndex']!=index:
            raise RuntimeError('선택 프레임의 분석 원본 또는 모델이 변경됐습니다. 재처리하세요.')
        result['frames']=[f for f in result['frames'] if f['frameIndex']!=index]+[extension['frame']]
        result['frames'].sort(key=lambda f:f['frameIndex'])
        result['datasetId']=extension['datasetId']
        result['selectedFrameProcessing']=extension['processing']
    import broadcast_court
    if result.get('fps'):result=broadcast_court.apply(key,event_id,result,broadcast_index(event,result['fps']))
    import wide_pairing
    pair=wide_pairing.active(event)
    if pair:result['widePairRevision']=pair['revision']
    if include_multiview:
        import multiview
        result=multiview.apply(CASES[key],event_id,result,broadcast_index(event,result['fps']))
    if include_objects:
        import broadcast_objects
        result=broadcast_objects.apply(key,event_id,result,broadcast_index(event,result['fps']))
        import uniforms
        result=uniforms.annotate(result,key,event,broadcast_index(event,result['fps']))
        import scene_evidence
        frame=next((f for f in result['frames'] if f['frameIndex']==broadcast_index(event,result['fps'])),None)
        if frame and include_evidence:scene_evidence.apply(CASES[key],event,result,frame,data.get('referees',[]))
    return result


def broadcast_index(event,fps):
    # A directly selected broadcast frame must not evaluate the FPC fallback.
    # This also supports review records without an aligned wide-camera frame.
    if event.get('selectedBroadcastFrame') is not None:return event['selectedBroadcastFrame']
    return round((event['selectedFrame']/event['wide']['fps']-event['sync']['wideAtBroadcastZero'])*fps)


def save_broadcast_selections(key,selections,revision):
    """Commit exact broadcast choices together; FPC alignment remains approximate."""
    with LOCK:
        case=load_case(key)
        if case['revision']!=revision:raise RuntimeError('다른 창에서 기준 프레임이 변경됐습니다. 다시 연결하세요.')
        changes={}
        for e in case['events']:
            choice=selections[e['id']];index=choice['frameIndex'];fps=e['broadcast']['fps']
            if choice.get('sourceSha256')!=e['broadcast']['sha256']:raise RuntimeError('선택 영상의 원본이 다릅니다.')
            if type(index)!=int or not 0<=index<round(e['broadcast']['durationSeconds']*fps):raise ValueError('중계 프레임 범위를 확인하세요.')
            from action_window import window_frames
            seconds=choice.get('actionWindowSeconds',30)
            window_frames(round(e['broadcast']['durationSeconds']*fps),fps,index,seconds)
            if (index==broadcast_index(e,fps) and seconds==e.get('broadcastSelection',{}).get('actionWindowSeconds',30)
                and choice.get('analysisMoment')==e.get('broadcastSelection',{}).get('analysisMoment')
                and (choice.get('widePair') or {}).get('revision')==(e.get('broadcastSelection',{}).get('widePair') or {}).get('revision')
                and choice.get('wideChoice','pending')==e.get('broadcastSelection',{}).get('wideChoice','pending')):continue
            wide_index=None
            if e.get('wide') and e.get('sync'):
                wide_index=round((index/fps+e['sync']['wideAtBroadcastZero'])*e['wide']['fps'])
                if not 0<=wide_index<e['wide']['frames']:raise ValueError('이 프레임과 연결되는 FPC 구간이 없습니다. 정합 구간을 먼저 확인하세요.')
            changes[e['id']]=dict(selectedBroadcastFrame=index,broadcastSelection=choice,
                selectedFrame=wide_index,selectionStatus='user-selected-from-broadcast',
                sourceSha256=e['wide']['sha256'] if e.get('wide') else e['broadcast']['sha256'],selectedAt=datetime.now(timezone.utc).isoformat(),
                selectionNote='중계 프레임 직접 선택'+(' · FPC 근사 정합' if wide_index is not None else ' · 중계뷰 단독'))
        if not changes:return case
        saved=CASES[key]/'selections.json'
        state=json.loads(saved.read_text()) if saved.exists() else {'revision':0,'events':{}}
        history=CASES[key]/'selection-history';history.mkdir(exist_ok=True)
        (history/f"revision-{state['revision']}.json").write_text(json.dumps(state,ensure_ascii=False,indent=2))
        for event_id,change in changes.items():state['events'].setdefault(event_id,{}).update(change)
        state['revision']+=1
        temp=saved.with_suffix('.tmp');temp.write_text(json.dumps(state,ensure_ascii=False,indent=2));temp.replace(saved)
        return load_case(key)


def broadcast_overlay(key,event_id,frame,kind='overlays'):
    if kind not in ('overlays','maps'):raise ValueError('등록되지 않은 자료입니다.')
    # Stored tracking overlays are immutable source artifacts, not live edits.
    packet=broadcast_packet(key,event_id,include_objects=False)
    if frame not in {f['frameIndex'] for f in packet['frames']}:raise ValueError('등록되지 않은 프레임입니다.')
    return broadcast_root(key)/kind/event_id/f'{frame:06d}.png'


def save_selection(key,event_id,payload):
    with LOCK:
        data=load_case(key)
        if type(payload.get('revision')) is not int or payload['revision']!=data['revision']:raise RuntimeError('다른 창에서 변경됐습니다. 새로고침 후 다시 선택하세요.')
        event=next((e for e in data['events'] if e['id']==event_id),None)
        if event is None or not event.get('wide'):raise ValueError('연결된 원본 영상이 없습니다.')
        frame=payload.get('frameIndex')
        if isinstance(frame,bool) or not isinstance(frame,int) or not 0<=frame<event['wide']['frames']:raise ValueError('영상 범위 안의 프레임을 선택하세요.')
        if payload.get('sourceSha256')!=event['wide']['sha256']:raise RuntimeError('영상이 변경됐습니다. 다시 확인하세요.')
        note=payload.get('note','')
        if not isinstance(note,str) or len(note)>700:raise ValueError('메모는 700자 이하입니다.')
        saved=CASES[key]/'selections.json'
        state=json.loads(saved.read_text()) if saved.exists() else {'revision':0,'events':{}}
        state['revision']+=1
        state['events'][event_id]=dict(selectedFrame=frame,selectionStatus='user-selected',selectionNote=note,
                                      sourceSha256=payload['sourceSha256'],selectedAt=datetime.now(timezone.utc).isoformat())
        temp=saved.with_suffix('.tmp');temp.write_text(json.dumps(state,ensure_ascii=False,indent=2));temp.replace(saved)
        return load_case(key)


def media_file(key,kind,name):
    data=load_case(key)
    if kind not in ('wide','broadcast') or Path(name).name!=name:raise ValueError('등록되지 않은 영상입니다.')
    allowed=set()
    for e in data['events']:
        if e.get(kind):
            filename=Path(e[kind]['file']).name
            allowed.add(filename)
            allowed.add(Path(filename).with_suffix('.jpg').name)
    if name not in allowed:raise ValueError('등록되지 않은 영상입니다.')
    file=(CASES[key]/kind/name).resolve()
    if not file.is_relative_to((CASES[key]/kind).resolve()):raise ValueError('잘못된 경로입니다.')
    return file
