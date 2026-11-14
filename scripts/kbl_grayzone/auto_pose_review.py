"""Carry review forward only when automatic pose fitting preserves its analysis."""
import copy,json,re
from pathlib import Path
import case_store,report_inputs,review_flow,broadcast_reconstruction,pose_variant
from job_store import atomic,now

def visibility_signature(scene):
    crew=scene['crewAnalysis']
    return {'rows':sorted([{'id':r['id'],'heading':round(r['heading'],8),'counts':r['counts'],'blockers':sorted(r.get('blockers',[]))} for r in crew['rows']],key=lambda r:r['id']),
            'leaders':sorted(crew.get('leaders',[])),'missing':crew.get('missingReferees'),'complete':crew.get('crewComplete')}

def equivalent_state(before,after):
    """Ignore interleaving of roles but keep per-role display labels stable."""
    a=copy.deepcopy(before);b=copy.deepcopy(after)
    ae=a.pop('entities',[]);be=b.pop('entities',[])
    if a!=b or len(ae)!=len(be):return False
    if sorted(ae,key=lambda e:e['id'])!=sorted(be,key=lambda e:e['id']):return False
    roles={e['role'] for e in ae}
    return all([e['id'] for e in ae if e['role']==role]==[e['id'] for e in be if e['role']==role] for role in roles)

def refresh_view_text(case,event,scene,item):
    """Replace only clearly isolated reconstruction sentences; preserve facts."""
    from report_editorial import scene_commentary
    review=item.get('review',{})
    related=re.compile(r'재구성|시야|가림|가려|별표|가시|\bR[1-9]\b|심판.{0,20}(?:방향|잘 보|보이|열려)')
    for field in ('focus','observation','difficultyFactors','decisionBasis','takeaway','initialCall','callerBasis'):
        if related.search(review.get(field,'') or ''):return False
    old=review.get('assessment','') or '';sentences=re.split(r'(?<=[.!?。])\s+',old) if old else []
    indices=[]
    for index,sentence in enumerate(sentences):
        if not related.search(sentence):continue
        if '재구성' not in sentence or re.search(r'판독 결과|파울|취소|선언|터치|공격권|경기 재개',sentence):return False
        indices.append(index)
    preview=copy.deepcopy(item);preview.setdefault('review',{})['viewComment']=''
    view=scene_commentary(case,event,scene,preview)['viewComment']
    if len(view)>report_inputs.LIMITS['viewComment']:return False
    if indices:
        result=[]
        for i,sentence in enumerate(sentences):
            if i==indices[0]:result.append(view)
            elif i not in indices:result.append(sentence)
        updated=' '.join(result)
        if len(updated)>report_inputs.LIMITS['assessment']:return False
        review['assessment']=updated
    review['viewComment']=view
    return True

def finalize(case,event,payload):
    if not isinstance(payload,dict) or set(payload)!={'previousCaptureId','captureId','version'}:raise ValueError('자동 보정 정보를 확인하세요.')
    oldid=payload['previousCaptureId'];newid=payload['captureId']
    if not all(isinstance(x,str) and re.fullmatch(r'[a-f0-9]{24}',x) for x in (oldid,newid)):raise ValueError('공간 장면 ID를 확인하세요.')
    with report_inputs.LOCK,review_flow.LOCK:
        if report_inputs.version(case)!=payload['version']:raise RuntimeError('보정 중 코멘트가 변경됐습니다. 최신 입력을 확인하세요.')
        root=case_store.CASES[case]/'reconstructions'/event
        old=json.loads((root/oldid/'scene.json').read_text());new=broadcast_reconstruction.current(case,event,strict=True)
        if old.get('captureId')!=oldid or new.get('captureId')!=newid or not new.get('poseVariantId'):raise RuntimeError('자동 보정 중 공간 장면이 바뀌었습니다.')
        meta=json.loads((pose_variant.folder(case,event,new['poseVariantId'])/'meta.json').read_text())
        if meta.get('sourceCaptureId')!=oldid:raise RuntimeError('보정 자세의 원본 장면이 다릅니다.')
        keys=('caseId','eventId','frameIndex','datasetId','inputSha256','selectionVersion','sceneEvidenceSha256','poseJobId','uniformRevision')
        if any(old.get(k)!=new.get(k) for k in keys) or not equivalent_state(old['state'],new['state']):raise RuntimeError('보정 중 기준 화면이나 배치가 변경됐습니다. 장면을 확인하세요.')
        flow=review_flow.status(case);row=next(e for e in flow['events'] if e['id']==event);step=row['stages']['spatial']
        saved=review_flow.stored(case).get('events',{}).get(event,{}).get('spatial',{})
        oldtoken=review_flow.digest([row['stages']['objects']['token'],new['poseJobId'],oldid])
        if saved.get('token')!=oldtoken:raise RuntimeError('이전 공간 검수 상태가 바뀌었습니다. 장면을 확인하세요.')
        if not step['available'] or not step['ready']:raise RuntimeError('보정된 공간 장면의 검수 상태를 확인하세요.')
        data=copy.deepcopy(report_inputs.read(case));item=data.get('events',{}).get(event)
        if item and item.get('scene',{}).get('captureId') not in (None,oldid):raise RuntimeError('기존 코멘트의 장면 출처가 달라 확인이 필요합니다.')
        changed=visibility_signature(old)!=visibility_signature(new)
        if changed and item:
            case_data=case_store.load_case(case);event_data=next(e for e in case_data['events'] if e['id']==event)
            if not refresh_view_text(case_data,event_data,new,item):
                return {'carried':False,'reason':'보정 후 시야가 달라졌고 기존 코멘트에 함께 검토할 내용이 있습니다. 시야와 코멘트를 확인해 주세요.','eventId':event}
        if item:
            p=report_inputs.path(case);archive=p.parent/'report-editorial-history';archive.mkdir(exist_ok=True)
            backup=archive/(payload['version']+'.json')
            if not backup.exists():atomic(backup,report_inputs.read(case))
            item.setdefault('scene',{})
            item['scene']['captureId']=newid;item['scene']['autoPoseRebasedFrom']=oldid;item['scene']['autoPoseRebasedAt']=now();item['scene']['autoPoseViewUpdated']=changed
            atomic(p,data)
        review_flow.complete(case,event,{'stage':'spatial','token':step['token']},source='automatic-pose-recalculated' if changed else 'automatic-equivalent-pose')
        return {'carried':True,'eventId':event,'viewUpdated':changed,'version':report_inputs.version(case)}
