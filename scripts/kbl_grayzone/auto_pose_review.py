"""Carry report inputs forward when automatic pose fitting updates the scene."""
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
    related=re.compile(r'재구성|시야|가림|가려|별표|가시|(?<![A-Za-z0-9])(?:R|P)[1-9][0-9]*(?![0-9])|심판.{0,20}(?:방향|잘 보|보이|열려)')
    referee_names=[r.get('name','') for r in case.get('referees',[]) if r.get('name')]
    for field in ('focus','observation','difficultyFactors','decisionBasis','takeaway','initialCall','callerBasis'):
        text=review.get(field,'') or ''
        # A recommendation to check a less-obstructed angle is not a claim
        # about which referee or player was visible in the previous model.
        if field=='takeaway' and not any(name in text for name in referee_names) and not re.search(r'심판|#\d|(?<![A-Za-z0-9])(?:R|P)[1-9][0-9]*(?![0-9])',text) and re.search(r'확인(?:해야|할|이 필요)',text):
            text=re.sub(r'가림이\s*적은\s*(?:각도|시점)(?:를|에서|로)?','다른 각도',text)
        # Generic observations such as a hand being hidden, or an instruction
        # to compare referee views, are not assertions about the old 3D model.
        # Only a particular labelled person/referee or a model reference makes
        # these fields dependent on its old visibility result.
        specific=(re.search(r'재구성|모델상|가시\s*(?:표본|비율)|#\d|(?<![A-Za-z0-9])(?:R|P)[1-9][0-9]*(?![A-Za-z0-9])',text)
                  or any(name in text for name in referee_names))
        if specific and related.search(text):return False
    old=review.get('assessment','') or '';sentences=re.split(r'(?<=[.!?。])\s+',old) if old else []
    indices=[]
    for index,sentence in enumerate(sentences):
        if not related.search(sentence):continue
        if '재구성' not in sentence or re.search(r'판독 결과|파울|취소|선언|터치|공격권|경기 재개',sentence):return False
        indices.append(index)
    preview=copy.deepcopy(item);preview.setdefault('review',{})['viewComment']=''
    commentary=scene_commentary(case,event,scene,preview)
    view=commentary['viewComment']
    rows=scene.get('crewAnalysis',{}).get('rows',[])
    labels=commentary.get('labels',{})
    # The default summary mentions the most blocked direction. Preserve the
    # other blocked referee directions as well when refreshing authored text.
    for row in rows:
        label=row.get('label','')
        if not re.fullmatch(r'R[1-9][0-9]*',label) or not row.get('counts',{}).get('blocked') or re.search(r'(?<![A-Za-z0-9])'+re.escape(label)+r'(?![0-9])',view):continue
        blockers=[labels.get(ident,'다른 인물') for ident in row.get('blockers',[])]
        view+=f" {label} 방향도 "+('·'.join(blockers)+'에' if blockers else '다른 인물에')+' 가려지는 부분이 있습니다.'
    # Use only the operator's saved referee assignments; a visibility leader
    # is not evidence that this referee made the original call.
    roster={r.get('number'):r.get('name') for r in case.get('referees',[]) if r.get('number') is not None and r.get('name')}
    assignments=review.get('refereeAssignments') or {}
    for row in rows:
        label=row.get('label','');name=roster.get(assignments.get(row.get('id')))
        if name and re.fullmatch(r'R[1-9][0-9]*',label):
            view=re.sub(r'(?<![A-Za-z0-9])'+re.escape(label)+r'(?![0-9])',lambda match:f'{name} 심판({label})',view)
    if len(view)>report_inputs.LIMITS['viewComment']:return False
    if indices:
        result=[]
        for i,sentence in enumerate(sentences):
            if i==indices[0]:
                # Keep an independent action point after the scene-specific
                # clause, instead of discarding the author's conclusion.
                parts=re.split(r'(?:므로|때문에|으며|지만),?\s+',sentence,maxsplit=1)
                if len(parts)==2:
                    if related.search(parts[1]):return False
                    result.extend((view,parts[1]))
                else:result.append(view)
            elif i not in indices:result.append(sentence)
        updated=' '.join(result)
        if len(updated)>report_inputs.LIMITS['assessment']:return False
        review['assessment']=updated
    # Keep independent instructional sentences, while replacing claims
    # tied to the old visibility model with the new scene's view summary.
    extra=[sentence for sentence in re.split(r'(?<=[.!?。])\s+',review.get('viewComment','') or '') if sentence and not related.search(sentence)]
    updated_view=' '.join([view,*extra])
    if len(updated_view)>report_inputs.LIMITS['viewComment']:return False
    review['viewComment']=updated_view
    return True

def fallback_view_text(case,event,scene,item):
    """Preserve ambiguous authored facts and clearly distinguish old views.

    The original item is archived by finalize. A mixed sentence can contain a
    decision as well as an old view claim, so it must not be silently deleted
    or presented as a claim about the newly reconstructed scene.
    """
    from report_editorial import scene_commentary
    review=item.setdefault('review',{})
    original=copy.deepcopy(review)
    preview=copy.deepcopy(item);preview['review']={**review,'viewComment':'','assessment':''}
    summary=scene_commentary(case,event,scene,preview)
    view=summary['viewComment']
    rows=scene.get('crewAnalysis',{}).get('rows',[])
    roster={r.get('number'):r.get('name') for r in case.get('referees',[]) if r.get('number') is not None and r.get('name')}
    assignments=review.get('refereeAssignments') or {}
    named=view
    for row in rows:
        label=row.get('label','');name=roster.get(assignments.get(row.get('id')))
        if name and re.fullmatch(r'R[1-9][0-9]*',label):
            named=re.sub(r'(?<![A-Za-z0-9])'+re.escape(label)+r'(?![0-9])',lambda m:f'{name} 심판({label})',named)
    if len(named)<=report_inputs.LIMITS['viewComment']:view=named
    if len(view)>report_inputs.LIMITS['viewComment']:
        leaders=[row.get('label','') for row in rows if row.get('id') in scene.get('crewAnalysis',{}).get('leaders',[])]
        view=('재구성에서는 '+'·'.join(leaders)+' 방향의 별표 주변이 상대적으로 드러납니다.') if leaders else '재구성된 심판 배치를 기준으로 별표 지점의 시야를 확인합니다.'
    related=re.compile(r'재구성|모델상|시야|가림|가려|별표|가시|잘\s*보|보이|보였|볼\s*수|드러|열려|막혀|사각지대|유리|불리|살필|보기\s*좋|관찰하기')
    reference=re.compile(r'재구성|모델상|가시\s*(?:표본|비율)|#\d|(?<![A-Za-z0-9])(?:R|P)[1-9][0-9]*(?![A-Za-z0-9])')
    names=[r.get('name','') for r in case.get('referees',[]) if r.get('name')]
    def specific(text):
        return bool(related.search(text) and (reference.search(text) or any(name in text for name in names)))
    # Preserve independent author-supplied advice in the view field.
    extras=[s for s in re.split(r'(?<=[.!?。])\s+',original.get('viewComment','') or '') if s and not specific(s) and not related.search(s)]
    for extra in extras:
        if len(view)+1+len(extra)<=report_inputs.LIMITS['viewComment']:view+=' '+extra
    warning=False;historical=False
    for field in ('focus','observation','difficultyFactors','decisionBasis','takeaway','initialCall','callerBasis'):
        text=original.get(field,'') or ''
        if not specific(text):continue
        # Never replace factual/attribution text: label its historical view
        # and retain it verbatim, with the exact original also in history.
        prefix='보정 전 시야 기준: '
        if len(prefix)+len(text)<=report_inputs.LIMITS[field]:review[field]=prefix+text;historical=True
        else:warning=True
    old=original.get('assessment','') or ''
    sentences=re.split(r'(?<=[.!?。])\s+',old) if old else []
    replacement=[];inserted=False
    mixed=re.compile(r'판독 결과|파울|취소|선언|터치|공격권|경기 재개')
    for sentence in sentences:
        if not specific(sentence):replacement.append(sentence);continue
        if mixed.search(sentence):
            # Keep the entire mixed factual sentence instead of guessing where
            # its verdict ends. Its old view is explicitly time-scoped.
            replacement.append('보정 전 시야를 포함한 기존 해설: '+sentence)
        elif not inserted:
            replacement.append(view);inserted=True
    assessment=' '.join(replacement)
    if len(assessment)<=report_inputs.LIMITS['assessment']:review['assessment']=assessment
    else:
        # Keep the original, never truncate it. The current view carries an
        # explicit note that other view claims refer to the previous model.
        review['assessment']=old;warning=True
    if warning:
        note='다른 문안의 시야 설명은 보정 전 기준입니다.'
        if len(view)+1+len(note)>report_inputs.LIMITS['viewComment']:
            leaders=[row.get('label','') for row in rows if row.get('id') in scene.get('crewAnalysis',{}).get('leaders',[])]
            view=('재구성에서는 '+'·'.join(leaders)+' 방향이 상대적으로 드러납니다.') if leaders else '보정된 심판 배치 기준 시야입니다.'
        view+=' '+note
    review['viewComment']=view
    return {'mode':'automatic-preserving-authored-context','previousViewNotice':warning or historical or any(specific(s) and mixed.search(s) for s in sentences)}

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
        # The editor wrote the commentary against their reviewed scene. A
        # pose-only correction must not silently rewrite that authored text.
        # Keep both capture IDs and the visibility change for provenance.
        if item:
            p=report_inputs.path(case);archive=p.parent/'report-editorial-history';archive.mkdir(exist_ok=True)
            backup=archive/(payload['version']+'.json')
            if not backup.exists():atomic(backup,report_inputs.read(case))
            item.setdefault('scene',{})
            item['scene']['captureId']=newid;item['scene']['autoPoseRebasedFrom']=oldid;item['scene']['autoPoseRebasedAt']=now();item['scene']['autoPoseViewUpdated']=False;item['scene']['autoPoseVisibilityChanged']=changed
            item['scene'].pop('autoPoseViewRefresh',None)
            atomic(p,data)
        review_flow.complete(case,event,{'stage':'spatial','token':step['token']},source='automatic-pose-recalculated' if changed else 'automatic-equivalent-pose')
        return {'carried':True,'eventId':event,'viewUpdated':False,'visibilityChanged':changed,'version':report_inputs.version(case)}
