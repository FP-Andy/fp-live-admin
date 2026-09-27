"""Stateless FPA editing for the CV workbench, shared by API and local server.

Every operation returns a new document. No match/database/file is written here.
The established FPA generator remains the source of action and score semantics.
"""
from __future__ import annotations
import copy
import json
import math
import re
import uuid
from typing import Any
from . import fpa


def _text(value):
    return '' if value is None else str(value)


def _json(value, label):
    if not value:
        return None
    result = json.loads(value) if isinstance(value, str) else copy.deepcopy(value)
    if not isinstance(result, dict):
        raise ValueError(f'{label} 형식이 올바르지 않습니다.')
    return result


def _code_parts(code):
    code = code.strip().lower()
    base, *tags = code.split('.')
    if base.isdigit():
        return base, 'touch', '', tags
    match = re.fullmatch(r'(\d{1,3})?([a-z]+)(\d{1,3})?', base)
    if not match or match[2] not in fpa.ACTION_CODES:
        raise ValueError('FPA 코드를 확인하세요. 예: 4ss5, 4cc5, 4dd, 4q')
    actor, action, receiver = match.groups()
    allowed = {**fpa.TAG_CODES, **(fpa.SAVE_TAG_CODES if action == 'sv' else {})}
    if any(tag not in allowed for tag in tags):
        raise ValueError('알 수 없는 태그가 있습니다. FPA 코드 도움말을 확인하세요.')
    return actor or '', action, receiver or '', tags


def _join_code(actor, action, receiver, tags):
    return f'{actor}{action}{receiver}' + ''.join('.'+t for t in tags)


def _infer_code(row):
    """Legacy XLSX has Action/Tags but may not carry the original StatInput."""
    if row.get('StatInput'):
        return _text(row['StatInput']).lower()
    action = row.get('Action', '')
    tags = {t.strip() for t in _text(row.get('Tags')).split(',') if t.strip()}
    success = bool(tags & {'Success', 'Retained', 'Possession Retained'})
    choices = {
        'Shot': 'ddd' if 'Goal' in tags else 'dd' if 'On Target' in tags else 'db' if 'Blocked' in tags else 'd',
        'Pass': 'zz' if 'Assist' in tags else 'z' if 'Key Pass' in tags else 'ss' if success else 's',
        'Kick-in': 'cc' if success else 'c', 'Cross': 'cc' if success else 'c',
        'Throw-in': 'tt' if success else 't', 'Dribble': 'rr' if success else 'r',
        'Breakthrough': 'ee' if success else 'e', 'Duel': 'bb' if success else 'b',
    }
    code = choices.get(action) or next((c for c,a in fpa.ACTION_CODES.items() if a == action), '')
    if not code:
        return ''
    dictionary = {**fpa.TAG_CODES, **(fpa.SAVE_TAG_CODES if code=='sv' else {})}
    inverse = {value:key for key,value in reversed(list(dictionary.items()))}
    codes = [inverse[t] for t in sorted(tags) if t in inverse]
    return _join_code(_text(row.get('Player')), code, _text(row.get('Receiver')), codes)


def normalize_document(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('rows'), list) or len(payload['rows']) > 10000:
        raise ValueError('FPA rows 배열이 필요합니다. 한 번에 최대 10,000행을 열 수 있습니다.')
    doc = copy.deepcopy(payload)
    logs = doc.get('logs', [''] * len(doc['rows']))
    if not isinstance(logs, list) or len(logs) != len(doc['rows']) or any(not isinstance(x,str) for x in logs):
        raise ValueError('rows와 logs의 수가 일치해야 합니다.')
    doc['logs'] = logs
    seen = set()
    for i,row in enumerate(doc['rows']):
        if not isinstance(row,dict) or row.get('Sport') not in (None,'','FUTSAL'):
            raise ValueError('이 작업 화면은 풋살 FPA 데이터를 사용합니다.')
        row['FpaEventId'] = _text(row.get('FpaEventId')) or str(uuid.uuid4())
        if row['FpaEventId'] in seen or len(row['FpaEventId']) > 128:
            raise ValueError('이벤트 ID가 중복되거나 올바르지 않습니다.')
        seen.add(row['FpaEventId'])
        parts = logs[i].split(' | ')
        row.setdefault('Half', parts[0] if len(parts)>3 else '1H')
        if not row.get('Direction') and len(parts)>3:
            row['Direction'] = parts[2]
        row['Sport'] = 'FUTSAL'
    if doc.get('sport') not in (None,'','FUTSAL'):
        raise ValueError('풋살 FPA 데이터만 열 수 있습니다.')
    doc['sport'] = 'FUTSAL'
    return doc


def describe_event(row, log=''):
    parts = log.split(' | ')
    positions = re.findall(r'Pos\(([-+\d.eE]+),\s*([-+\d.eE]+)\)', log)
    if not positions:
        positions = re.findall(r'Pos\(([-+\d.eE]+),\s*([-+\d.eE]+)\)', _text(row.get('Coord')))
    if not positions and row.get('StartX') not in (None,''):
        positions = [(row['StartX'], row['StartY'])]
    if len(positions)<2 and row.get('EndX') not in (None,''):
        positions.append((row['EndX'],row['EndY']))
    path = row.get('PathPoints')
    if path:
        positions = fpa._parse_path_points(path) or positions
    return {'stat_input':_infer_code(row), 'half':row.get('Half') or (parts[0] if len(parts)>3 else '1H'),
            'team':row.get('Team') or (parts[1] if len(parts)>3 else 'home'),
            'direction':row.get('Direction') or (parts[2] if len(parts)>3 else ''),
            'timeline':row.get('Time') or (parts[3] if len(parts)>3 else ''),
            'dots':[{'meter_x':float(x),'meter_y':float(y)} for x,y in positions], 'sport':'FUTSAL'}


def _validate_request(raw):
    req = copy.deepcopy(raw)
    if req.get('team') not in ('home','away') or req.get('direction') not in ('left','right'):
        raise ValueError('홈/원정과 공격 방향을 선택하세요.')
    if not isinstance(req.get('half'),str) or not 1<=len(req['half'])<=20:
        raise ValueError('피리어드를 확인하세요.')
    timeline = req.get('timeline','')
    if not isinstance(timeline,str) or not re.fullmatch(r'\d+(?::[0-5]\d){1,2}(?:\.\d{1,3})?',timeline):
        raise ValueError('시각은 분:초 또는 시:분:초 형식으로 입력하세요.')
    code = req.get('stat_input','')
    if not isinstance(code,str) or len(code)>80:
        raise ValueError('FPA 코드가 올바르지 않습니다.')
    _code_parts(code)
    dots = req.get('dots')
    if not isinstance(dots,list) or not 1<=len(dots)<=100:
        raise ValueError('코트에 좌표를 지정하세요. 경로는 최대 100개 점입니다.')
    for p in dots:
        if not isinstance(p,dict):
            raise ValueError('좌표 형식이 올바르지 않습니다.')
        for axis,limit in [('meter_x',40),('meter_y',20)]:
            v = p.get(axis)
            if isinstance(v,bool) or not isinstance(v,(float,int)) or not math.isfinite(v) or not 0<=v<=limit:
                raise ValueError('풋살 코트 좌표는 0–40m × 0–20m입니다.')
    req['stat_input'] = code.strip().lower()
    req['sport'] = 'FUTSAL'
    return {key:req[key] for key in ('stat_input','dots','half','team','direction','timeline','sport')}


def _scene_key(row):
    state = _json(row.get('SceneState'), 'SceneState')
    if not state:
        return None
    # SceneIndex is a CLIP index in the current logger. Several scenes can
    # share it. The inner scene_index is the actual scene identifier.
    scope=(_text(row.get('Half')),_text(row.get('SceneIndex')))
    return (*scope,_text(state.get('scene_index'))) if state.get('scene_index') is not None else (*scope,'state',json.dumps(state,sort_keys=True))


def _side(dot, perspective):
    return dot.get('teamSide') or dot.get('team_side') or (perspective if dot.get('team','ally')=='ally' else 'away' if perspective=='home' else 'home')


def _scene_dots(state, frame):
    return state.get(frame+'Dots',state.get(frame,[])) or []


def _dual_for(row, team):
    state = _json(row.get('SceneState'), 'SceneState')
    original = _json(row.get('DualState'), 'DualState')
    if not state and not original:
        return None
    perspective = (original or {}).get('actor_team') or row.get('Team') or team
    before,after = [],[]
    for frame,target in [('before',before),('after',after)]:
        for dot in _scene_dots(state,frame) if state else original.get(frame,[]):
            if dot.get('ghost'):
                continue
            item = {k:v for k,v in dot.items() if k in ('meter_x','meter_y','role','layer','number','id')}
            side = _side(dot,perspective)
            item.update(team_side=side,team='ally' if side==team else 'opponent')
            if dot.get('needsCheck') or dot.get('needs_check'):
                item['needs_check'] = True
            target.append(item)
    return {'before':{'dots':before},'after':{'dots':after},'actor_team':team,
            'input_tier':(original or {}).get('input_tier','minimal'),
            'primary_row_index':state.get('primary') if state else original.get('primary_row_index')}


def _generate(row, log, request, *, identity_only=False):
    req = _validate_request(request)
    dual = _dual_for(row,req['team'])
    if dual:
        # Validate preserved scene coordinates as well as the selected path.
        _validate_request({**req,'dots':dual['before']['dots']+dual['after']['dots']})
    result = fpa.generate_log_entry(**req, dual_pitch=dual)
    updated = {**row, **result['log_data'], 'Half':req['half'],'Direction':req['direction'],
               'StatInput':req['stat_input'], 'FpaEventId':row.get('FpaEventId') or str(uuid.uuid4())}
    text = result['log_text']
    # A jersey correction does not invalidate a manually observed goalmouth.
    # Other edits explicitly discard xGOT/GoalMouth, which depend on the shot.
    if identity_only:
        for key in ['GoalMouth','GoalMouthX','GoalMouthY','xGOT']:
            if row.get(key) not in (None,''):
                updated[key] = row[key]
        if row.get('GoalMouth'):
            text += ' | GoalMouth: '+str(row['GoalMouth'])
        if row.get('xGOT'):
            # Keep exactly one Metrics section, including recalculated values.
            metrics={k:updated.get(k,'') for k in ['xG','ShotThreat','xGOT','xRC','xPK','EPV','PC']}
            text=re.sub(r' \| Metrics: [^|]*', '', text).strip()
            text+=' | Metrics: '+fpa._format_metrics(metrics)
    else:
        for key in ['GoalMouth','GoalMouthX','GoalMouthY','xGOT']:
            updated[key]=''
    # Materialized coordinate columns must agree with regenerated Coord/log.
    for key in ['StartX','StartY','StartX_adj','StartY_adj','EndX','EndY','EndX_adj','EndY_adj']:
        updated.pop(key,None)
    return updated,text


def _replace_number(code,old,new):
    actor,action,receiver,tags = _code_parts(code)
    return _join_code(new if actor==old else actor, action, new if receiver==old else receiver, tags)


def _relabel_scene(state, old, new, team, perspective, scene_rows):
    state=copy.deepcopy(state)
    for frame in ['before','after']:
        dots=_scene_dots(state,frame)
        own=[d for d in dots if _side(d,perspective)==team and not d.get('ghost')]
        sources=[d for d in own if _text(d.get('number'))==old]
        if len(sources)>1 or (old!=new and sources and any(_text(d.get('number'))==new for d in own)):
            raise ValueError('같은 장면에 번호가 겹치는 선수 점이 있습니다. FPA 장면에서 먼저 구분하세요.')
        for dot in dots:
            if _side(dot,perspective)==team and _text(dot.get('number'))==old:
                dot['number']=new;dot['needsCheck']=False;dot['needs_check']=False
    for arrow in state.get('passArrows',[]):
        code=arrow.get('code')
        if not code:
            continue
        # rowIndex refers to the index WITHIN this scene, not SceneActionIndex
        # (the latter is a running index within the whole clip).
        index=arrow.get('rowIndex')
        row=scene_rows[index] if isinstance(index,int) and 0<=index<len(scene_rows) else None
        if row is None:
            matches=[r for r in scene_rows if _infer_code(r)==code]
            row=matches[0] if len(matches)==1 else None
        if row is None and old in _code_parts(code)[:3]:
            raise ValueError('패스 화살표의 소속 행이 모호합니다. 기존 FPA 장면에서 먼저 확인하세요.')
        if row and row.get('Team')==team:
            arrow['code']=_replace_number(code,old,new)
    return state


def match_player(payload):
    doc=normalize_document(payload['document'])
    index=next((i for i,r in enumerate(doc['rows']) if r['FpaEventId']==payload.get('event_id')),None)
    if index is None:
        raise ValueError('선택한 이벤트를 찾지 못했습니다.')
    role=payload.get('role');identity=payload.get('identity',{})
    if role not in ('actor','receiver') or identity.get('team') not in ('home','away') or not re.fullmatch(r'\d{1,3}',_text(identity.get('jersey'))):
        raise ValueError('번호가 지정된 홈/원정 선수만 연결할 수 있습니다. 심판은 제외됩니다.')
    row=doc['rows'][index];field='Player' if role=='actor' else 'Receiver'
    if row.get('Team')!=identity['team']:
        raise ValueError('이벤트와 선수의 팀이 다릅니다. 행의 팀을 먼저 확인하세요.')
    old,new=_text(row.get(field)),str(identity['jersey'])
    if not old and role=='receiver':
        raise ValueError('이 이벤트에는 수신자가 없습니다. 패스·킥인 등 수신자가 있는 이벤트를 선택하세요.')
    key=_scene_key(row)
    indices=[i for i,r in enumerate(doc['rows']) if key and _scene_key(r)==key] if key else [index]
    scene_rows=[doc['rows'][i] for i in indices]
    state=_json(row.get('SceneState'),'SceneState')
    if state and old:
        state=_relabel_scene(state,old,new,identity['team'],row['Team'],scene_rows)
        for i in indices:
            doc['rows'][i]['SceneState']=json.dumps(state,ensure_ascii=False,separators=(',',':'))
    changed=[]
    for i in indices:
        item=doc['rows'][i];req=describe_event(item,doc['logs'][i])
        if item.get('Team')==identity['team']:
            if old:
                req['stat_input']=_replace_number(req['stat_input'],old,new)
            elif i==index:
                a,c,r,t=_code_parts(req['stat_input']);req['stat_input']=_join_code(new,c,r,t)
        # Legacy DualState without full SceneState is still updated in its own
        # actor perspective. Opponent dots with the same jersey remain intact.
        dual=_json(item.get('DualState'),'DualState')
        if dual and old:
            dual=_relabel_scene(dual,old,new,identity['team'],dual.get('actor_team') or item['Team'],[])
            item['DualState']=json.dumps(dual,ensure_ascii=False,separators=(',',':'))
        updated,log=_generate(item,doc['logs'][i],req,identity_only=True)
        doc['rows'][i]=updated;doc['logs'][i]=log;changed.append(updated['FpaEventId'])
    return {'document':doc,'changed_ids':changed}


def edit_event(payload):
    doc=normalize_document(payload['document']);event_id=payload.get('event_id')
    index=next((i for i,r in enumerate(doc['rows']) if r['FpaEventId']==event_id),None) if event_id else None
    if event_id and index is None:
        raise ValueError('선택한 이벤트를 찾지 못했습니다.')
    req=_validate_request(payload['request'])
    original=doc['rows'][index] if index is not None else {}
    # Shared scene point editing belongs to the existing full scene editor.
    # Preserve the scene here and allow code/time edits; paths stay fixed.
    if original.get('SceneState') or original.get('DualState'):
        previous=describe_event(original,doc['logs'][index])
        if req['dots']!=previous['dots'] or req['team']!=previous['team']:
            raise ValueError('장면 데이터가 있는 행의 좌표·팀은 기존 FPA 장면 편집에서 수정하세요. 이 화면에서는 번호 연결과 코드·시각 수정이 가능합니다.')
        a,_,r,_=_code_parts(req['stat_input']);oa,_,orr,_=_code_parts(previous['stat_input'])
        if (a,r)!=(oa,orr):
            raise ValueError('장면의 번호는 영상 선수 연결로 수정하세요. 관련 선수 점과 행이 함께 갱신됩니다.')
        state=_json(original.get('SceneState'),'SceneState')
        if state and req['stat_input']!=previous['stat_input']:
            group=[i for i,row in enumerate(doc['rows']) if _scene_key(row)==_scene_key(original)]
            local_index=group.index(index)
            for arrow in state.get('passArrows',[]):
                if arrow.get('rowIndex')==local_index:
                    arrow['code']=req['stat_input']
            for i in group:
                doc['rows'][i]['SceneState']=json.dumps(state,ensure_ascii=False,separators=(',',':'))
            original=doc['rows'][index]
    previous=describe_event(original,doc['logs'][index]) if index is not None else None
    preserve_shot=bool(previous and all(req[k]==previous[k] for k in ('stat_input','dots','team','direction')))
    updated,log=_generate(original,doc['logs'][index] if index is not None else '',req,identity_only=preserve_shot)
    if index is None:
        doc['rows'].append(updated);doc['logs'].append(log)
    else:
        doc['rows'][index]=updated;doc['logs'][index]=log
    return {'document':doc,'changed_ids':[updated['FpaEventId']],'event_id':updated['FpaEventId']}


def dispatch(operation,payload):
    if operation=='normalize':return {'document':normalize_document(payload)}
    if operation=='describe':return describe_event(payload['row'],payload.get('log',''))
    if operation=='match':return match_player(payload)
    if operation=='edit':return edit_event(payload)
    raise ValueError('지원하지 않는 FPA 작업입니다.')


def import_workbook(content):
    return {'document':normalize_document(fpa.import_logs_from_workbook(content))}


def export_workbook(payload):
    doc=normalize_document(payload)
    if not doc['logs'] or any(not log for log in doc['logs']):
        raise ValueError('모든 행에 FPA 로그가 있어야 XLSX로 내보낼 수 있습니다. 미완성 행을 먼저 수정하세요.')
    df=fpa.parse_logs_to_dataframe(doc['logs'],doc.get('match_id',''),doc.get('teamid_h',''),doc.get('teamid_a',''),'FUTSAL')
    return fpa.build_analysis_workbook(df,scene_rows=doc['rows'])


def generate_editor_log(payload):
    """Use the original FPC generator, including all Dual pitch context."""
    req = {key:copy.deepcopy(payload.get(key)) for key in ('stat_input','dots','half','team','direction','timeline','dual_pitch')}
    if req['team'] not in ('home','away') or req['direction'] not in ('left','right'):
        raise ValueError('팀과 공격 방향을 확인하세요.')
    if not isinstance(req['stat_input'],str) or len(req['stat_input'])>80:
        raise ValueError('FPA 코드를 확인하세요.')
    if not isinstance(req['dots'],list) or len(req['dots'])>100:
        raise ValueError('좌표는 최대 100개입니다.')
    frames = [req['dots']]
    if req['dual_pitch'] is not None:
        if not isinstance(req['dual_pitch'],dict):raise ValueError('Dual 좌표 형식을 확인하세요.')
        frames += [req['dual_pitch'].get(side,{}).get('dots',[]) for side in ('before','after')]
    for frame in frames:
        if not isinstance(frame,list) or len(frame)>100:raise ValueError('좌표는 최대 100개입니다.')
        for dot in frame:
            if not isinstance(dot,dict):raise ValueError('좌표 형식을 확인하세요.')
            for axis,limit in [('meter_x',40),('meter_y',20)]:
                value=dot.get(axis)
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=limit:
                    raise ValueError('풋살 코트 좌표는 0–40m × 0–20m입니다.')
    return fpa.generate_log_entry(**req,sport='FUTSAL')


def estimate_editor_xgot(payload):
    from .xgot import estimate_xgot
    req = {'is_on_target':False,'goalmouth_x':None,'goalmouth_y':None,'is_goal':False,
           'is_header':False,'is_weak_foot':False,'under_pressure':False,'one_on_one':False,'shot_pace_band':'MID'}
    req.update({key:payload[key] for key in req if key in payload})
    for key,low,high in [('xg',0,1),('goalmouth_x',-2,3),('goalmouth_y',-2,3)]:
        value=payload.get(key)
        if value is None and key!='xg':continue
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
            raise ValueError(f'{key} 값을 확인하세요.')
    if req['shot_pace_band'] not in ('LOW','MID','HIGH'):raise ValueError('슛 속도를 확인하세요.')
    return estimate_xgot(payload['xg'],**req)
