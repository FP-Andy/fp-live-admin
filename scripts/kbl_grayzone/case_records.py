"""Canonical incident facts with source-bound amendments; no geometry mutation."""
import copy,json
from job_store import atomic,digest,lease,now
from case_intake import clock_seconds

FIELDS=('id','number','quarter','gameClock','gameClockSeconds','gameClockStatus',
        'reviewDurationSeconds','requestType','requestingTeam','recordedDecision',
        'recordedReason','recordedContext','recordedAt','recordedBy','decisionSource')
EDITABLE={'quarter','gameClock','reviewDurationSeconds','requestType','requestingTeam',
          'recordedDecision','recordedReason','recordedContext'}

def facts(event):return {k:copy.deepcopy(event[k]) for k in FIELDS if k in event}
def version(case):return digest({'csv':case.get('csvSha256'),'events':[facts(e) for e in case['events']]})

def apply(case,root):
    path=root/'record-amendments.json'
    if path.is_file():
        amendments=json.loads(path.read_text())
        if amendments['csvSha256']!=case['csvSha256']:raise RuntimeError('정정 기록과 원본 CSV가 다릅니다.')
        for event in case['events']:
            patch=amendments['events'].get(event['id'])
            if patch:
                event.update(copy.deepcopy(patch['fields']));event['recordAmendedAt']=patch.get('savedAt')
    case['recordsVersion']=version(case)
    for event in case['events']:event['recordVersion']=digest(facts(event))
    return case

def project_intake(data,case):
    """Retain uploaded facts and media choices; expose current facts consistently."""
    by_id={e['id']:e for e in case['events']}
    if {e['id'] for e in data['events']}!=set(by_id):
        raise RuntimeError('접수와 경기의 판독 목록이 다릅니다.')
    if data.get('case',{}).get('csvSha256')!=case.get('csvSha256') and not (case.get('intakeId') and case['intakeId']==data.get('id')):
        # Older reviewed fixtures may preserve a BOM/newline variant of the
        # CSV. Permit it only with identical incident facts and source videos.
        fields=('id','number','quarter','gameClock','recordedDecision','recordedReason','requestingTeam')
        same=all(all(e.get(k)==by_id[e['id']].get(k) for k in fields) and
                 e.get('selection',{}).get('sourceSha256')==by_id[e['id']].get('broadcast',{}).get('sha256')
                 for e in data['events'])
        if not same:raise RuntimeError('접수와 경기의 원본 CSV가 다릅니다. 다른 경기로 연결할 수 없습니다.')
    corrections=[]
    for event in data['events']:
        source=event.setdefault('sourceRecord',facts(event))
        current=facts(by_id[event['id']]);changed=[k for k in current if source.get(k)!=current[k]]
        event.update(current)
        if changed:corrections.append({'eventId':event['id'],'fields':changed,'original':source,'current':current})
    data['case']['events']=[facts(e) for e in case['events']]
    data['recordsVersion']=case.get('recordsVersion') or version(case)
    data['recordCorrections']=corrections
    return data

def clean_fields(event,values):
    if not isinstance(values,dict) or not values or set(values)-EDITABLE:raise ValueError('정정할 기록 항목을 확인하세요.')
    clean=copy.deepcopy(values)
    for key,value in values.items():
        if key in ('quarter','reviewDurationSeconds'):
            upper=20 if key=='quarter' else 3600
            if type(value)!=int or not (1 if key=='quarter' else 0)<=value<=upper:raise ValueError('쿼터·소요 시간을 확인하세요.')
        elif not isinstance(value,str) or len(value)>1000:raise ValueError('기록은 1000자 이내의 문장으로 입력하세요.')
    quarter=clean.get('quarter',event['quarter']);clock=clean.get('gameClock',event['gameClock'])
    if clock not in ('','시각 미기재'):
        seconds=clock_seconds(clock)
        if quarter>4 and seconds>300:raise ValueError('연장전 경기 시계를 확인하세요.')
        clean.update(gameClock=clock.strip(),gameClockSeconds=seconds,gameClockStatus='corrected')
    else:clean.update(gameClock='시각 미기재',gameClockSeconds=None,gameClockStatus='missing')
    if clean.get('recordedDecision',event['recordedDecision']) not in ('유지','번복','보류'):raise ValueError('판독 결과는 유지·번복·보류 중에서 선택하세요.')
    return clean

def save(case_id,event_id,payload):
    import case_store
    root=case_store.CASES[case_id]
    with lease(root/'record-amendments.lock') as acquired:
        if not acquired:raise RuntimeError('다른 기록 정정을 저장 중입니다. 다시 시도하세요.')
        case=case_store.load_case(case_id)
        if payload.get('version')!=case['recordsVersion']:raise RuntimeError('기록이 다른 화면에서 변경됐습니다. 다시 불러오세요.')
        event=next((e for e in case['events'] if e['id']==event_id),None)
        if not event:raise ValueError('판독 장면을 확인하세요.')
        values=payload.get('fields');reason=payload.get('reason','').strip()
        if not isinstance(values,dict) or not values or set(values)-EDITABLE:raise ValueError('정정할 기록 항목을 확인하세요.')
        if not reason or len(reason)>300:raise ValueError('정정 근거를 300자 이내로 남겨 주세요.')
        clean=clean_fields(event,values)
        path=root/'record-amendments.json'
        data=json.loads(path.read_text()) if path.exists() else {'schema':'kbl-record-amendments/v1','csvSha256':case['csvSha256'],'events':{},'history':[]}
        previous=facts(event);merged={**data['events'].get(event_id,{}).get('fields',{}),**clean}
        data['events'][event_id]={'fields':merged,'reason':reason,'savedAt':now()}
        data['history'].append({'eventId':event_id,'before':previous,'fields':clean,'reason':reason,'savedAt':now()})
        atomic(path,data)
    return case_store.load_case(case_id)
