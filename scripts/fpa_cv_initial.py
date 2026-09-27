"""Validate operator seeds and transfer them geometrically, never by detection ID."""
from copy import deepcopy
import re
from fpa_cv_uniforms import validate_uniforms

GROUP_COUNTS={'home_gk':1,'home':5,'referee':1,'away':5,'away_gk':1}
SLOTS={f'{group}-{i+1}':group for group,count in GROUP_COUNTS.items() for i in range(count)}


def validate_initial(value,prepared):
    if not isinstance(value,dict):raise ValueError('코트·유니폼·13명 초기 설정을 완료하세요.')
    uniforms=validate_uniforms(value.get('uniforms'))
    if not all(uniforms.values()):raise ValueError('유니폼 5그룹의 색상을 모두 지정하세요.')
    roster=value.get('roster')
    if not isinstance(roster,list) or len(roster)!=13:raise ValueError('심판을 포함한 13명을 모두 지정하세요.')
    boxes={b['id']:b for b in prepared['boxes']}
    excluded=value.get('excludedDetectionIds',[])
    if not isinstance(excluded,list) or any(type(i) is not int or i not in boxes for i in excluded) or len(set(excluded))!=len(excluded):
        raise ValueError('제외할 BB는 현재 초기 장면에서 선택하세요.')
    seen=set();used=set();numbers={'home':set(),'away':set()};people=[]
    for person in roster:
        if not isinstance(person,dict):raise ValueError('선수 명단을 확인하세요.')
        pid=person.get('id');group=person.get('group');number=person.get('jersey');detection=person.get('detectionId')
        if pid not in SLOTS or SLOTS[pid]!=group or pid in seen:raise ValueError('홈 6명·어웨이 6명·심판 1명으로 지정하세요.')
        if not isinstance(number,str) or not re.fullmatch(r'[\w가-힣-]{1,12}' if group=='referee' else r'[0-9]{1,3}',number):raise ValueError('등번호는 0–999, 심판 표기는 1–12자로 입력하세요.')
        if type(detection) is not int or detection not in boxes or detection in used:raise ValueError('13명을 서로 다른 선수 박스에 연결하세요.')
        if detection in excluded:raise ValueError('제외한 BB에 선수 번호를 연결할 수 없습니다. 다른 BB를 선택하세요.')
        team='home' if group.startswith('home') else 'away' if group.startswith('away') else 'referee'
        if team!='referee':
            if int(number) in numbers[team]:raise ValueError('같은 팀의 등번호가 중복되었습니다.')
            numbers[team].add(int(number))
        seen.add(pid);used.add(detection)
        people.append({'id':pid,'group':group,'jersey':number,'detectionId':detection,'box':boxes[detection]['box']})
    return {'preparationId':value['preparationId'],'time':prepared['time'],'frameIndex':prepared['frameIndex'],
            'uniforms':deepcopy(uniforms),'roster':people,'excludedDetectionIds':list(excluded),
            'detections':[{k:deepcopy(b[k]) for k in ('id','box','confidence')} for b in prepared['boxes']]}


def initial_detections(setup,width,height,birth_score):
    """Start from reviewed server detections, not unstable re-prediction IDs.

    Manual person selections can activate a low-score body box. Keep original
    detector scores separately so the output never presents boosted confidence.
    Exclusions apply to this frame only; they are not fixed exclusion regions.
    """
    people={p['detectionId']:p for p in setup['roster']}
    excluded=set(setup.get('excludedDetectionIds',[]))
    rows=[];scores=[];teams=[]
    for box in setup['detections']:
        if box['id'] in excluded:continue
        person=people.get(box['id']);score=box['confidence']
        rows.append([n*size for n,size in zip(box['box'],(width,height,width,height))]+[max(score,birth_score) if person else score,0])
        scores.append(score)
        teams.append(1 if person and person['group'].startswith('home') else 2 if person and person['group'].startswith('away') else 0 if person else None)
    return rows,scores,teams


def iou(a,b):
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/union if union else 0


def initial_review(data,setup):
    frame=min(data['frames'],key=lambda f:abs(f['t']-setup['time']))
    if abs(frame['t']-setup['time'])>1e-5:raise ValueError('초기 설정 장면이 최종 트래킹에 포함되지 않았습니다.')
    anchor_time=max(data['video']['clipStart'],frame['t'])
    roster=[{k:p[k] for k in ('id','group','jersey')} for p in setup['roster']]
    review={'schema':'fpa-review/v1','datasetId':data['datasetId'],'segments':[],'events':[],'links':{},'offsets':{},
            'roster':roster,'uniforms':setup['uniforms'],'setup':None,'autoReconnect':True,'rejections':[],
            'initialization':{'time':anchor_time,'unmatched':[],'matches':[]}}
    boxes=frame['boxes'];seeds=setup['roster'];scores=[[iou(p['box'],b['box']) for b in boxes] for p in seeds]
    step=1/data['detector']['sampleFps'];tracks={t['id']:t for t in data['tracks']}
    for i,p in enumerate(seeds):
        ranked=sorted(range(len(boxes)),key=lambda j:-scores[i][j])
        j=ranked[0] if ranked else None
        best=scores[i][j] if j is not None else 0
        second=scores[i][ranked[1]] if len(ranked)>1 else 0
        rival=max((scores[k][j] for k in range(len(seeds)) if k!=i),default=0) if j is not None else 0
        # Conservative reciprocal match. Merged/ambiguous boxes require review.
        if best<.45 or best-second<.12 or best-rival<.12:
            review['initialization']['unmatched'].append(p['id']);continue
        track=tracks[boxes[j]['id']]
        team='home' if p['group'].startswith('home') else 'away' if p['group'].startswith('away') else 'referee'
        review['segments'].append({'trackId':track['id'],'from':max(data['video']['clipStart'],track['first']),
          'to':min(data['video']['clipEnd'],track['last']+step),'personId':p['id'],'group':p['group'],
          'team':team,'jersey':p['jersey'],'source':'manual'})
        review['initialization']['matches'].append({'personId':p['id'],'trackId':track['id'],'overlap':round(best,4)})
    if len(review['segments'])==13:review['setup']={'time':anchor_time}
    return review
