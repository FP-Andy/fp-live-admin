"""Operator-authored report inputs, scoped to one saved scene and CSV revision."""
import copy
import hashlib
import json
import threading
from datetime import datetime, timezone
from case_store import CASES, load_case
from report_editorial import scene_commentary,context_changed,context_version

LOCK=threading.RLock()
LIMITS={'focus':130,'observation':160,'difficultyFactors':160,'decisionBasis':140,'takeaway':120,
        'viewComment':180,'assessment':520,'initialCall':100,'callerBasis':120}

def path(key):return CASES[key]/'report-editorial.json'
def version(key):
    base=hashlib.sha256(path(key).read_bytes()).hexdigest() if path(key).exists() else 'empty'
    roster=CASES[key]/'referee-roster.json'
    return hashlib.sha256((base+roster.read_text()).encode()).hexdigest() if roster.exists() else base
def read(key):return json.loads(path(key).read_text()) if path(key).exists() else {'events':{},'source':{}}

def assignments(case,snapshot,item):
    saved=item.get('review',{}).get('refereeAssignments',{})
    evidence=(snapshot.get('sceneEvidence') or {}).get('identities',{})
    valid={r['number'] for r in case['referees']}
    return {r['id']:(saved[r['id']] if r['id'] in saved else evidence.get(r['id'],{}).get('number'))
            for r in snapshot['crewAnalysis']['rows'] if saved.get(r['id'],evidence.get(r['id'],{}).get('number')) in valid}

def fields(item):
    scene=item.get('scene',{});review=item.get('review',{})
    defaults={'focus':scene.get('focus',''),'observation':scene.get('observation',''),
        'difficultyFactors':scene.get('difficultyFactors',''),'initialCall':item.get('initialCall',''),
        'assessment':scene.get('assessment',''),'decisionBasis':'','takeaway':'','viewComment':'','callerBasis':'','callerNumber':None}
    return {**defaults,**{k:v for k,v in review.items() if k in LIMITS or k=='callerNumber'}}

def compose(event,values):
    decision=event['recordedDecision'];reason=event.get('recordedReason','').strip()
    if decision=='유지':
        start=f"{values.get('initialCall') or '최초 콜'}이 유지됐습니다."
    elif decision=='번복':
        start=f"기록상 {values.get('initialCall') or '최초 콜'}에서 ‘{reason}’로 번복됐습니다." if reason else '최초 콜이 번복됐습니다. 최종 판독 내용을 확인하세요.'
    elif decision=='보류':
        start=f"원심을 보류하고 판독한 결과 ‘{reason}’이라는 결론이 기록됐습니다." if reason else '원심 보류 후 판독이 진행됐습니다. 최종 판독 내용을 확인하세요.'
    else:
        start=f"판독 결과: {reason}." if reason else '최종 판독 내용을 확인하세요.'
    parts=[start]
    if values.get('observation'):parts.append(values['observation'])
    if values.get('decisionBasis'):parts.append('판독의 핵심 근거는 '+values['decisionBasis'].rstrip('.。')+'입니다.' if not values['decisionBasis'].endswith(('.','다','요')) else values['decisionBasis'])
    elif values.get('difficultyFactors'):parts.append(values['difficultyFactors'])
    if values.get('takeaway'):parts.append(values['takeaway'])
    elif values.get('viewComment'):parts.append(values['viewComment'])
    return ' '.join(parts)

def validate(values,case,snapshot):
    if not isinstance(values,dict) or set(values)-set(LIMITS)-{'callerNumber','refereeAssignments'}:raise ValueError('리포트 입력 항목을 확인하세요.')
    clean={}
    for k,limit in LIMITS.items():
        value=values.get(k,'')
        if not isinstance(value,str) or len(value.strip())>limit:raise ValueError(f'{k}: {limit}자 이내로 입력하세요.')
        clean[k]=value.strip()
    roster={r['number'] for r in case['referees']};caller=values.get('callerNumber')
    if caller is not None and (type(caller)!=int or caller not in roster):raise ValueError('콜 심판은 경기 배정 명단에서 선택하세요.')
    if caller is not None and not clean['callerBasis']:raise ValueError('실제 콜 심판을 확인한 근거를 입력하세요.')
    clean['callerNumber']=caller;mapping=values.get('refereeAssignments',{})
    refs={r['id'] for r in snapshot['crewAnalysis']['rows']}
    if not isinstance(mapping,dict) or set(mapping)-refs:raise ValueError('심판 매칭 대상이 현재 장면과 다릅니다.')
    evidence=(snapshot.get('sceneEvidence') or {}).get('identities',{})
    mapping={**{r:evidence.get(r,{}).get('number') for r in refs},**mapping}
    numbers=[]
    for track,number in mapping.items():
        if number is None:continue
        if type(number)!=int or number not in roster:raise ValueError('배정 명단의 심판 번호를 선택하세요.')
        numbers.append(number)
    if len(numbers)!=len(set(numbers)):raise ValueError('한 장면에서 같은 심판을 두 객체에 매칭할 수 없습니다.')
    clean['refereeAssignments']=mapping
    return clean

def _view(key):
    import broadcast_reconstruction as reconstruction
    case=load_case(key);data=read(key);events=[]
    for event in case['events']:
        item=data.get('events',{}).get(event['id'],{});error=None;snapshot=None
        try:snapshot=reconstruction.current(key,event['id'],strict=True)
        except (ValueError,RuntimeError,OSError) as exc:error=str(exc)
        entry={'id':event['id'],'number':event['number'],'quarter':event['quarter'],'gameClock':event['gameClock'],
            'recordedDecision':event['recordedDecision'],'recordedReason':event['recordedReason'],
            'context':item.get('context',event.get('recordedContext','')),'fields':fields(item),'error':error,
            'savedAt':item.get('review',{}).get('savedAt'),'ready':bool(snapshot)}
        if snapshot:
            mapping=assignments(case,snapshot,item)
            entry.update(captureId=snapshot['captureId'],refereeAssignments=mapping,
                delivery={'referees':len(snapshot['crewAnalysis']['rows']),'matchedReferees':len(mapping),
                    'moment':event.get('broadcastSelection',{}).get('analysisMoment',{}),
                    'targetHeight':snapshot['state'].get('targetHeight'),'crewComplete':snapshot['crewAnalysis'].get('crewComplete',len(snapshot['crewAnalysis']['rows'])==3)},
                sceneChanged=bool(context_changed(event,item) or (data.get('csvSha256') and data['csvSha256']!=case['csvSha256']) or (item.get('scene') and item['scene'].get('captureId')!=snapshot['captureId'])),
                referees=[{'id':r['id'],'label':r['label'],'image':f"/api/cases/{key}/events/{event['id']}/report-referee-{i+1}.jpg?capture={snapshot['captureId']}"} for i,r in enumerate(snapshot['crewAnalysis']['rows'])],
                map=f"/api/cases/{key}/events/{event['id']}/report-map.jpg?capture={snapshot['captureId']}",
                warnings=(snapshot.get('sceneEvidence') or {}).get('qualityWarnings',[]),
                preview=scene_commentary(case,event,snapshot,item))
        events.append(entry)
    return {'caseId':key,'revision':case['revision'],'version':version(key),'referees':case['referees'],'events':events,'limits':LIMITS}

def view(key):
    with LOCK:return _view(key)

def save(key,payload,preview=False):
    import broadcast_reconstruction as reconstruction
    import broadcast_objects
    with LOCK:
        case=load_case(key)
        if not isinstance(payload,dict) or payload.get('version')!=version(key) or payload.get('revision')!=case['revision']:
            raise RuntimeError('입력 또는 경기 정보가 변경됐습니다. 새로고침 후 다시 저장하세요.')
        updates=payload.get('events')
        if not isinstance(updates,list) or not 1<=len(updates)<=len(case['events']):raise ValueError('저장할 판독 장면을 선택하세요.')
        data=copy.deepcopy(read(key));data.setdefault('events',{});seen=set();result={}
        by_id={e['id']:e for e in case['events']}
        if data.get('csvSha256') not in (None,case['csvSha256']) and {u.get('id') for u in updates}!=set(by_id):
            raise RuntimeError('CSV가 바뀌었습니다. 모든 장면의 입력을 대조한 뒤 함께 저장하세요.')
        for update in updates:
            eid=update.get('id')
            if eid not in by_id or eid in seen:raise ValueError('판독 장면이 중복되거나 존재하지 않습니다.')
            seen.add(eid);snapshot=reconstruction.current(key,eid,strict=True)
            if update.get('captureId')!=snapshot['captureId']:raise RuntimeError('공간 장면이 변경됐습니다. 현재 장면을 다시 확인하세요.')
            item=data['events'].setdefault(eid,{})
            stale=(context_changed(by_id[eid],item) or data.get('csvSha256') not in (None,case['csvSha256']) or (item.get('scene') and item['scene'].get('captureId')!=snapshot['captureId']))
            if stale and not update.get('reviewedCurrentScene'):raise RuntimeError('이전 장면의 입력입니다. 현재 장면 기준으로 확인한 뒤 저장하세요.')
            values=validate(update.get('fields'),case,snapshot)
            if preview:values['assessment']=compose(by_id[eid],values)
            item['review']={**values,'savedAt':datetime.now(timezone.utc).isoformat(),'source':'operator-review'}
            item['scene']={**item.get('scene',{}),'captureId':snapshot['captureId'],'frameIndex':snapshot['frameIndex'],'contextVersion':context_version(by_id[eid])}
            result[eid]=scene_commentary(case,by_id[eid],snapshot,item)
        if preview:return {'previews':result}
        data.update(csvSha256=case['csvSha256'],schema='kbl-report-editorial/v2')
        broadcast_objects.atomic(path(key),data)
        return view(key)

def map_file(key,event_id):
    import broadcast_reconstruction as reconstruction
    from report_map import marked_map
    snapshot=reconstruction.current(key,event_id,strict=True)
    folder=CASES[key]/'reconstructions'/event_id/snapshot['captureId']
    from report_map import prepare_map_presentations
    source=prepare_map_presentations(CASES[key],load_case(key),{event_id:snapshot})[event_id]
    target=CASES[key]/'report-map-previews'/f"{event_id}-{source.stem}-full.jpg"
    if not target.exists():
        target.parent.mkdir(exist_ok=True)
        im,_=marked_map(source,snapshot,(600,450),map_layout='apron-v2');im.save(target,quality=94)

    return target

def referee_file(key,event_id,index):
    import broadcast_reconstruction as reconstruction
    from case_store import broadcast_packet
    from case_evidence import extract_frame
    from PIL import Image,ImageDraw
    snapshot=reconstruction.current(key,event_id,strict=True);root=CASES[key]
    target=root/'report-referee-previews'/f"{event_id}-{snapshot['captureId']}-{index}.jpg"
    if target.exists():return target
    target.parent.mkdir(exist_ok=True)
    row=snapshot['crewAnalysis']['rows'][index-1];case=load_case(key);event=next(e for e in case['events'] if e['id']==event_id)
    packet=broadcast_packet(key,event_id);frame=next(f for f in packet['frames'] if f['frameIndex']==snapshot['frameIndex'])
    box=next((b for b in frame['boxes'] if b['id']==row['id']),None)
    if box:
        pixels=[v*s for v,s in zip(box['box'],[packet['width'],packet['height']]*2)]
        if box.get('imageSource')=='wide':
            import multiview,cv2
            revision=box['sourceImageUrl'].rsplit('/',1)[-1].split('.')[0]
            image=cv2.imread(str(multiview.image_file(key,event_id,snapshot['frameIndex'],revision)))
        else:image=extract_frame(root/'broadcast'/event['broadcast']['file'],snapshot['frameIndex'])
    else:
        extra=(snapshot.get('sceneEvidence') or {});ref=next((r for r in extra.get('supplementalReferees',[]) if r['id']==row['id']),None)
        if not ref:raise ValueError('심판 원본 위치가 없습니다.')
        pixels=ref['pixelBox']
        if extra.get('wideReference'):
            import cv2
            image=cv2.imread(str(root/extra['wideReference']['image']))
        else:image=extract_frame(event['wide']['file'],extra['wide']['frameIndex'])
    x1,y1,x2,y2=pixels;pad=max(12,(x2-x1)*.18)
    bounds=(max(0,int(x1-pad)),max(0,int(y1-pad)),min(image.shape[1],int(x2+pad)),min(image.shape[0],int(y2+pad)))
    im=Image.fromarray(image[:,:,::-1]).crop(bounds);im.thumbnail((300,400));im.save(target,quality=94)
    return target
