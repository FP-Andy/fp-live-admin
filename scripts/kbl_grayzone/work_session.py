"""Optional, content-free operator timing. Never changes the delivery SLA."""
import json, math, re, time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
import case_store
from job_store import atomic, lease, now

STAGES={'frame','objects','joints','spatial','report'}
ATTENTION=('unobserved','paused','hidden','idle','active')
MAX_ROWS=100000
# Only stable controls. The UI never sends button labels, input contents or URLs.
ACTIONS={
    'frame':{'confirm','saveRecord','saveUniforms','continue','previous','next'},
    'objects':{'infer','addObject','addBall','redrawBox','setFoot','reviewUnplaced','undo','redo','applyBox','applyFoot','resetObjects'},
    'joints':{'infer','undo','redo','fitFocus','openArmEditor','coordinate'},
    'spatial':{'save','saveAll','markPoint','resetPoint','applyPoint','aimMap','mapUndo','moveMap','applyPosition','proposePosition','placePartial','acceptProposal','refereeView','refreshCrew','applyEdit','flipBody','autoBody','applySharedPose','clearSharedPose','createVideo','createRefitVideo','refreshVideos'},
    'report':{'saveAll','generate','download','checkVideoReady','exportPackage','packageDownload','compose'},
}

@contextmanager
def _wait_for_lease(path, timeout=2.0):
    """Briefly serialize concurrent tab flushes without losing cross-process safety."""
    deadline=time.monotonic()+timeout
    while True:
        with lease(path) as acquired:
            if acquired:
                yield True
                return
        remaining=deadline-time.monotonic()
        if remaining<=0:
            yield False
            return
        time.sleep(min(.05,remaining))

def path(key):
    if key not in case_store.CASES:raise ValueError('등록되지 않은 경기입니다.')
    return case_store.CASES[key]/'work-sessions.json'

def load(key):
    p=path(key)
    if p.exists() and p.stat().st_size>30*1024*1024:raise ValueError('작업 시간 기록 크기를 확인하세요.')
    return json.loads(p.read_text()) if p.exists() else {'schema':'kbl-work-sessions/v1','records':[]}

def validate(key,payload):
    if not isinstance(payload,dict) or not {'sessionId','records'}<=set(payload) or set(payload)-{'sessionId','records','actions'}:raise ValueError('작업 시간 요청 형식을 확인하세요.')
    session=payload['sessionId']
    if not isinstance(session,str) or not re.fullmatch(r'[a-f0-9]{32}',session):raise ValueError('작업 세션 ID를 확인하세요.')
    records=payload['records']
    if not isinstance(records,list) or not 1<=len(records)<=120:raise ValueError('한 번에 최대 120개 시간 구간을 기록합니다.')
    events={e['id'] for e in case_store.load_case(key)['events']};clock=time.time()*1000;result=[]
    fields={'seq','startedAtMs','endedAtMs','stage','eventId','attention','taskBusy'}
    for r in records:
        if not isinstance(r,dict) or set(r)!=fields:raise ValueError('시간·단계 외의 작업 내용은 기록하지 않습니다.')
        a,b=r['startedAtMs'],r['endedAtMs']
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in (a,b)) or not 0<b-a<=60000 or a<clock-86400000 or b>clock+300000:raise ValueError('시간 구간이 범위를 벗어났습니다.')
        if type(r['seq']) is not int or not 0<=r['seq']<=1000000 or r['stage'] not in STAGES or r['attention'] not in ATTENTION or type(r['taskBusy']) is not bool:raise ValueError('시간 구간 값을 확인하세요.')
        if r['eventId'] is not None and r['eventId'] not in events:raise ValueError('등록된 판독 장면을 확인하세요.')
        result.append({'sessionId':session,**r})
    return result

def validate_actions(payload):
    actions=payload.get('actions',[])
    if not isinstance(actions,list) or len(actions)>120:raise ValueError('버튼 사용 기록 형식을 확인하세요.')
    result=[]
    for action in actions:
        if (not isinstance(action,dict) or set(action)!={'seq','stage','action'} or
            type(action['seq']) is not int or not 0<=action['seq']<=1000000 or
            not isinstance(action['stage'],str) or not isinstance(action['action'],str) or
            action['stage'] not in ACTIONS or action['action'] not in ACTIONS[action['stage']]):
            raise ValueError('버튼 사용 기록 값을 확인하세요.')
        result.append({'sessionId':payload['sessionId'],**action})
    return result

def _totals(rows):
    """Union across tabs. Foreground activity takes precedence over idle tabs."""
    boundaries=[]
    for r in rows:
        for t,delta in ((r['startedAtMs'],1),(r['endedAtMs'],-1)):
            boundaries.append((t,delta,r['attention'],r['taskBusy']))
    attention=Counter();busy=0;previous=None;totals={k:0. for k in ATTENTION};task=0.
    for t,delta,state,working in sorted(boundaries):
        if previous is not None and t>previous and any(attention.values()):
            winner=next(k for k in reversed(ATTENTION) if attention[k]>0)
            totals[winner]+=(t-previous)/1000
            if busy>0:task+=(t-previous)/1000
        attention[state]+=delta;busy+=delta if working else 0;previous=t
    return {'attentionSeconds':{k:round(v,3) for k,v in totals.items()},'taskBusySeconds':round(task,3),'observedSpanSeconds':round(sum(totals.values()),3)}

def view(key,export=False):
    data=load(key);rows=data['records'];result={'schema':data['schema'],'caseId':key,'recordedFrom':min((r['startedAtMs'] for r in rows),default=None),
        'recordCount':len(rows),'sessions':len({r['sessionId'] for r in rows}),'totals':_totals(rows),
        'stages':{s:_totals([r for r in rows if r['stage']==s]) for s in sorted(STAGES)},
        'limitations':['활동 시간은 최근 입력과 전경 여부에 따른 추정이며 실제 집중 시간을 측정한 값이 아닙니다.',
            '처리 대기·실행은 화면 작업 상태이며 활동/휴식 시간과 겹칠 수 있습니다. 더해서 합계를 만들지 않습니다.',
            '다중 탭의 겹치는 시간은 경기 합계에서 한 번만 집계합니다. 단계 합계는 서로 겹칠 수 있습니다.',
            '계측 시작 이전과 저장하지 못한 구간은 알 수 없습니다. 90분 납품 시계는 이 기록과 별개로 계속 흐릅니다.',
            '버튼 수는 계측 이후 지정된 주요 버튼의 누름 횟수이며, 작업 성공 여부나 작업자 신원은 알 수 없습니다.']}
    actions=data.get('actions',[])
    result['buttonCounts']={stage:dict(Counter(r['action'] for r in actions if r['stage']==stage)) for stage in sorted(STAGES)}
    result['buttonCountsLimitReached']=bool(data.get('actionsLimitReached'))
    if export:result['records']=rows
    return result

def save(key,payload):
    incoming=validate(key,payload);incoming_actions=validate_actions(payload);p=path(key)
    with _wait_for_lease(p.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('작업 시간을 저장 중입니다. 다음 묶음에서 재시도합니다.')
        data=load(key);known={(r['sessionId'],r['seq']):r for r in data['records']};added=[]
        for row in incoming:
            identity=(row['sessionId'],row['seq'])
            if identity in known:
                if known[identity]!=row:raise ValueError('같은 시간 기록의 내용을 바꿀 수 없습니다.')
            else:known[identity]=row;added.append(row)
        if len(known)>MAX_ROWS:raise ValueError('작업 시간 기록 개수 한도에 도달했습니다.')
        # Reject overlapping intervals inside one tab, while permitting late retries.
        current=sorted((r for r in known.values() if r['sessionId']==payload['sessionId']),key=lambda r:r['startedAtMs'])
        if any(a['endedAtMs']>b['startedAtMs'] for a,b in zip(current,current[1:])):raise ValueError('같은 세션의 시간 구간이 겹칩니다.')
        action_rows=data.get('actions',[]);known_actions={(r['sessionId'],r['seq']):r for r in action_rows};added_actions=[];actions_limit_reached=False
        for row in incoming_actions:
            identity=(row['sessionId'],row['seq'])
            if identity in known_actions:
                if known_actions[identity]!=row:raise ValueError('같은 버튼 기록의 내용을 바꿀 수 없습니다.')
            elif len(known_actions)<MAX_ROWS:known_actions[identity]=row;added_actions.append(row)
            else:actions_limit_reached=True
        if added or added_actions or (actions_limit_reached and not data.get('actionsLimitReached')):
            data['records'].extend(added);data['actions']=action_rows+added_actions
            if actions_limit_reached:data['actionsLimitReached']=True
            data['updatedAt']=now();atomic(p,data)
    return {'accepted':len(added),'received':len(incoming),'recordCount':len(known),'actionsAccepted':len(added_actions)}
