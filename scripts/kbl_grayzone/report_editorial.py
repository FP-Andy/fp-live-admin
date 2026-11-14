"""Source-bound report facts and scene-specific editorial, separate from geometry."""
import json
from collections import Counter
from report_commentary import entity_labels



def context_version(event):
    from job_store import digest
    return digest({'record':event.get('recordVersion'),'moment':event.get('broadcastSelection',{}).get('analysisMoment')})

def context_changed(event,item):
    if not item:return False
    previous=item.get('scene',{}).get('contextVersion')
    if previous:return previous!=context_version(event)
    if event.get('recordAmendedAt') and event['recordAmendedAt']>item.get('review',{}).get('savedAt',''):return True
    moment=event.get('broadcastSelection',{}).get('analysisMoment')
    return bool(moment and (moment.get('phase','unconfirmed')!='unconfirmed' or moment.get('clock') or moment.get('note')))


def load_editorial(root, case, snapshots):
    path = root / 'report-editorial.json'
    if not path.exists():
        return {'source': {}, 'events': {}}
    data = json.loads(path.read_text())
    if data.get('csvSha256') != case['csvSha256']:
        raise ValueError('판독 기록이 변경됐습니다. 리포트 코멘트의 출처를 다시 대조하세요.')
    by_id={e['id']:e for e in case['events']}
    for event_id, item in data.get('events', {}).items():
        if event_id in by_id and context_changed(by_id[event_id],item):raise ValueError('판독 기록 또는 기준 순간이 변경됐습니다. 해당 장면의 코멘트를 다시 확인하세요.')
        scene = item.get('scene', {})
        current = snapshots.get(event_id)
        if scene and (not current or scene.get('captureId') != current['captureId']):
            raise ValueError('공간 장면이 변경됐습니다. 해당 장면의 총평을 다시 확인하세요.')
    return data


def summary(case):
    events = case['events']
    times = [e['reviewDurationSeconds'] for e in events]
    return {'count': len(events), 'decisions': dict(Counter(e['recordedDecision'] for e in events)),
            'totalSeconds': sum(times), 'meanSeconds': sum(times) / len(times) if times else 0,
            'maxSeconds': max(times, default=0),
            'requestTeams': dict(Counter(e['requestingTeam'] for e in events))}


def official_label(case, snapshot, row, assignments=None):
    identity = (snapshot.get('sceneEvidence') or {}).get('identities', {}).get(row['id'])
    number=(assignments[row['id']] if assignments is not None and row['id'] in assignments else identity.get('number') if identity else None)
    official = next((r for r in case['referees'] if r['number'] == number), None)
    return f"{row['label']} · #{official['number']} {official['name']}" if official else row['label']


def scene_commentary(case, event, snapshot, item):
    analysis = snapshot['crewAnalysis']; rows = analysis['rows']; labels = entity_labels(snapshot)
    review=item.get('review',{});mapping=review.get('refereeAssignments',{})
    leaders = [r for r in rows if r['id'] in analysis['leaders']]
    if leaders:
        names = ', '.join(official_label(case, snapshot, r,mapping) for r in leaders)
        best = leaders[0]['counts']['visible']
        ranking = f"가정상 {names}의 가시 표본이 {best}/9로 " + ('공동 최다입니다.' if len(leaders) > 1 else '가장 많습니다.')
        if not best: ranking = '현재 가정에서 배치된 심판 모두 대상 표본을 볼 수 없습니다.'
    else: ranking = '심판 위치가 없어 비교할 수 없습니다.'
    blocked = [r for r in rows if r['counts']['blocked']]
    blocked_text = '; '.join(f"{r['label']} {r['counts']['blocked']}/9 가림" for r in blocked)
    scene = item.get('scene', {})
    factors = review.get('difficultyFactors') or scene.get('difficultyFactors', '접촉 부위와 동작의 선후를 함께 확인해야 합니다.')
    caller = item.get('callingReferee')
    # The assigned roster, a visible jersey, or broadcaster author is never a caller attribution.
    call_text = f"{caller['name']} #{caller['number']}" if caller and caller.get('source') else '최초 콜 심판 미기재'
    if 'callerNumber' in review and review['callerNumber'] is None:call_text='최초 콜 심판 미기재'
    operator_caller=next((r for r in case['referees'] if r['number']==review.get('callerNumber')),None)
    if operator_caller and review.get('callerBasis'):call_text=f"{operator_caller['name']} #{operator_caller['number']}"
    if leaders and leaders[0]['counts']['visible']:
        view_text='재구성에서는 '+ '·'.join(r['label'] for r in leaders)+' 쪽에서 별표 지점이 상대적으로 잘 드러납니다.'
    else:view_text='재구성에서는 배치된 심판 모두 별표 지점을 보기 어렵습니다.'
    if blocked:
        worst=max(blocked,key=lambda r:r['counts']['blocked'])
        blockers=[labels.get(i,'다른 인물') for i in worst.get('blockers',[])]
        view_text+=f" {worst['label']} 방향은 "+('·'.join(blockers)+'에' if blockers else '다른 인물에')+' 가려지는 부분이 있습니다.'
    assessment = review.get('assessment') or scene.get('assessment') or (
        f"판독 결과는 ‘{event['recordedReason']}’로 정리됐습니다. {view_text} {factors}")
    comparison='콜 담당자가 미기재되어 실제 판단 주체와 시야 조건의 대조는 남아 있습니다.'
    if operator_caller:
        bound=[r for r in rows if mapping.get(r['id'],(snapshot.get('sceneEvidence') or {}).get('identities',{}).get(r['id'],{}).get('number'))==operator_caller['number']]
        comparison=(f"기록한 콜 담당자는 {call_text}({bound[0]['label']})입니다. "+('모델상 가림이 적은 시점과 일치합니다.' if bound[0]['id'] in analysis['leaders'] else '모델상 가림이 적은 시점과 달라 보완 관찰의 역할을 살펴볼 수 있습니다.')) if bound else f"콜 담당자는 {call_text}이며, 화면의 R번호와 매칭이 필요합니다."
    return {'ranking': ranking, 'occlusion': blocked_text or '현재 표본에서 인체 가림 없음',
            'difficultyFactors': factors, 'assessment': assessment,
            'initialCall': review.get('initialCall') or item.get('initialCall', '최초 콜 내용 미제공'), 'callingReferee': call_text,
            'targetExplanation':review.get('focus') or scene.get('focus') or '별표는 선택한 판독 대상의 위치입니다. 이 지점을 중심으로 세 심판의 가림 조건을 비교합니다.',
            'viewComment':review.get('viewComment') or view_text,'refereeAssignments':mapping,
            'context': item.get('context') or review.get('observation') or '별도 상황 설명 미제공',
            'recordedDecision': event['recordedDecision'], 'recordedReason': event['recordedReason'],
            'comparison':comparison,
            'source': item.get('source'), 'labels': labels}
