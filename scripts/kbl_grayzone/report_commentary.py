"""Evidence-bound language for a reviewer; no invented foul or responsibility verdict."""
def crew_comments(snapshot):
    a=snapshot['crewAnalysis'];rows=a['rows'];leaders=[r for r in rows if r['id'] in a['leaders']]
    if not rows:return ['심판 위치가 없어 시야 비교를 만들 수 없습니다.']
    best=leaders[0];names='·'.join(r['label'] for r in leaders)
    ranking=(f"{names}의 대상 가시 비율이 {best['counts']['visible']}/9로 "+('동률입니다.' if len(leaders)>1 else '가장 높습니다.'))
    if best['fraction']==0:ranking='배치된 심판 모두 대상의 9개 표본을 볼 수 없는 조건입니다.'
    if a.get('qualityWarnings'):caution='접촉 순간·정합·자세에 확인 항목이 남아 담당 우열 및 공동 사각지대 확정을 보류합니다.'
    elif not a['crewComplete']:caution=f"심판 {len(rows)}/3명만 배치되어 세 명 공동 사각지대 여부는 판단을 보류합니다."
    elif not a['sceneComplete']:caution=f"영상에만 남긴 인물 {len(a['omittedTrackIds'])}명의 가림이 빠져 공동 사각지대 여부는 미확정입니다."
    elif a['conclusion']=='conditional-gray':caution='현재 좌표·자세·방향에서 세 심판 모두 가시 표본이 절반 미만인 회색지대 후보입니다.'
    else:caution='현재 가정에서는 적어도 한 심판에게 대상 표본의 절반 이상이 보입니다.'
    return ['현재 재구성 가정에서 '+ranking,caution,'선택 인물 주변의 30cm 비교 영역입니다. 실제 접촉 부위·높이와 심판 주시 방향을 확인해야 합니다.']

def entity_labels(snapshot):
    counts={}
    labels={}
    for e in snapshot['state']['entities']:
        role=e['role'];counts[role]=counts.get(role,0)+1
        labels[e['id']]={'player':'P','referee':'R','staff':'S','unknown':'U'}[role]+str(counts[role])
    return labels

def target_label(snapshot):return '별표 지점' if snapshot['state'].get('reviewPoint') else entity_labels(snapshot).get(snapshot['state']['targetId'],'미확인')

def referee_comment(row,labels=None):
    c=row['counts'];parts=[]
    if c['blocked']:parts.append(f"인체 가림 {c['blocked']}/9 · "+', '.join((labels or {}).get(x,x) for x in row['blockers']))
    if c['outside']:parts.append(f"시야 밖 {c['outside']}/9 · 방향 설정 확인 필요")
    if c['visible']:parts.append(f"가림 없는 표본 {c['visible']}/9")
    parts.append('대상을 바라본다는 가정' if row['headingSource']=='target-assumption' else '수동으로 지정한 방향 가정')
    return '\n'.join(parts)
