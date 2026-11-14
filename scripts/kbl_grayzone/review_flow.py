"""Scene-wide workflow checkpoints, bound to the exact saved artifacts."""
import hashlib,json,threading
from datetime import datetime,timezone
import case_store,broadcast_objects,broadcast_pose,broadcast_reconstruction
LOCK=threading.RLock()
STAGES=('objects','joints','spatial')

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def path(key):return case_store.CASES[key]/'review-flow.json'
def stored(key):return json.loads(path(key).read_text()) if path(key).exists() else {'events':{}}

def event_state(key,event,checks):
    stages={};objects=None;pose=None;scene=None;error=None
    try:objects=broadcast_objects.view(key,event['id'])
    except (RuntimeError,ValueError,OSError,StopIteration) as e:error=str(e)
    base=digest([objects[k] for k in ('frameIndex','datasetId','inputSha256')] if objects else [event.get('selectedFrame'),event.get('selectedBroadcastFrame')])
    try:pose=broadcast_pose.current(key,event['id'])
    except (RuntimeError,ValueError,OSError,StopIteration):pass
    if pose and pose['job']['state']!='complete':pose=None
    try:scene=broadcast_reconstruction.current(key,event['id'],strict=True)
    except (RuntimeError,ValueError,OSError,StopIteration):pass
    tokens={'objects':base,'joints':digest([base,pose['jobId'] if pose else None,pose.get('reviewedPeople',{}) if pose else None]),
            'spatial':digest([base,pose['jobId'] if pose else None,scene['captureId'] if scene else None])}
    placed_manually={e['id'] for e in (scene or {}).get('state',{}).get('entities',[]) if e.get('positionSource')=='manual'}
    unresolved=[o['id'] for o in objects['objects'] if not o['excluded'] and o['role'] in ('player','referee') and not o.get('hasFloorPosition',True) and not o.get('spatialExcluded') and o['id'] not in placed_manually] if objects else []
    court_pending=bool(objects and objects.get('courtCalibrationRequired'))
    # Image/object review is independent of court placement. Keep unresolved
    # people visible and require a spatial decision at the 2D/3D checkpoint.
    ready={'objects':bool(objects),'joints':bool(pose),
           'spatial':bool(not court_pending and not unresolved and scene and pose and scene.get('poseJobId')==pose['jobId'])}
    prerequisite=True
    for stage in STAGES:
        check=checks.get(stage);valid=bool(ready[stage] and prerequisite and check and check['token']==tokens[stage])
        stages[stage]={'ready':ready[stage],'available':prerequisite,'complete':valid,'token':tokens[stage],
                       'status':'complete' if valid else 'review' if ready[stage] and prerequisite else 'blocked',
                       'savedAt':check.get('savedAt') if valid else None}
        prerequisite=valid
    return {'id':event['id'],'number':event['number'],'quarter':event['quarter'],'gameClock':event['gameClock'],
            'frameIndex':objects['frameIndex'] if objects else None,'stages':stages,'error':error,
            'unresolvedSpatialIds':unresolved,
            'courtCalibrationRequired':court_pending,
            'people':sum(o['role']!='ball' and not o['excluded'] for o in objects['objects']) if objects else 0,
            'balls':sum(o['role']=='ball' and not o['excluded'] for o in objects['objects']) if objects else 0,
            'posePeople':len(pose['job']['result']['people']) if pose else 0,
            'neutralPeople':sum(not p['accepted'] for p in pose['job']['result']['people']) if pose else 0,
            'deliveryWarnings':(scene or {}).get('sceneEvidence',{}).get('qualityWarnings',[]) if (scene or {}).get('sceneEvidence') else [],
            'supplementalReferees':len(((scene or {}).get('sceneEvidence') or {}).get('supplementalReferees',[])),
            'nextStage':next((s for s in STAGES if not stages[s]['complete']),'report')}

def status(key):
    case=case_store.load_case(key);saved=stored(key)
    import match_library
    library_id=next((m['id'] for m in match_library.read()['matches'] if m.get('caseId')==key),key)
    events=[event_state(key,e,saved['events'].get(e['id'],{})) for e in sorted(case['events'],key=lambda e:e['number'])]
    phases={};available=bool(events)
    for stage in STAGES:
        count=sum(e['stages'][stage]['complete'] for e in events)
        phases[stage]={'available':available,'complete':bool(events) and count==len(events),'completed':count,'total':len(events)}
        earlier_complete=True
        for e in events:
            step=e['stages'][stage];step['available']=available and earlier_complete
            step['status']='complete' if step['complete'] else 'review' if step['available'] and step['ready'] else 'blocked'
            earlier_complete=earlier_complete and step['complete']
        available=available and phases[stage]['complete']
    active=next((s for s in STAGES if not phases[s]['complete']),'report')
    next_event=next((e['id'] for e in events if active in STAGES and not e['stages'][active]['complete']),None)
    for e in events:e['nextStage']=active
    return {'caseId':key,'libraryMatchId':library_id,'title':case['title'],'revision':case['revision'],'events':events,'stages':phases,
            'activeStage':active,'nextEventId':next_event,'reportReady':available}

def complete(key,event_id,payload,source='operator'):
    stage=payload.get('stage')
    if stage not in STAGES:raise ValueError('검수 단계를 확인하세요.')
    with LOCK:
        current=status(key);event=next((e for e in current['events'] if e['id']==event_id),None)
        if event is None:raise ValueError('판독 장면을 확인하세요.')
        saved=stored(key)
        step=event['stages'][stage]
        if payload.get('token')!=step['token']:raise RuntimeError('저장된 결과가 변경됐습니다. 현재 상태를 다시 확인하세요.')
        if not step['available']:raise RuntimeError('앞 단계 전체와 현재 단계의 앞 클립부터 순서대로 확인하세요.')
        if stage=='spatial' and event['courtCalibrationRequired']:raise RuntimeError('코트 좌표 보정을 완료한 뒤 2D·3D를 확인하세요. 객체 검수 내용은 저장되어 있습니다.')
        if stage=='spatial' and event['unresolvedSpatialIds']:raise RuntimeError(f"발 위치가 미확정인 선수·심판 {len(event['unresolvedSpatialIds'])}명이 있습니다. 2D·3D에서 위치를 지정하거나 객체 단계에서 영상에만 유지로 지정하세요. 현재 2D·3D 편집은 저장할 수 있습니다.")
        if not step['ready']:raise RuntimeError('현재 단계의 계산·저장을 먼저 완료하세요.')
        checks=saved['events'].setdefault(event_id,{})
        checks[stage]={'token':step['token'],'savedAt':datetime.now(timezone.utc).isoformat(),'scope':'whole-scene',**({'source':source} if source!='operator' else {})}
        broadcast_objects.atomic(path(key),saved)
        return {'saved':True,'stage':stage,'eventId':event_id}

def require_report(key):
    current=status(key)
    if not current['reportReady']:raise RuntimeError('모든 판독 장면의 객체·관절·공간 단계를 일괄 확인한 뒤 리포트를 생성하세요.')
    return current

def require_stage(key,stage,event_id=None):
    current=status(key)
    if not current['stages'][stage]['available']:raise RuntimeError('모든 클립의 앞 단계 확인을 완료한 뒤 진행하세요.')
    if event_id:
        event=next((e for e in current['events'] if e['id']==event_id),None)
        if not event:raise ValueError('판독 장면을 확인하세요.')
        if not event['stages'][stage]['available']:raise RuntimeError('현재 단계의 앞 클립부터 순서대로 확인하세요.')
    return current
