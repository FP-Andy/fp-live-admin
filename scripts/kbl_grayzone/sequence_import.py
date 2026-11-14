"""Explicit, audited transfer of one confirmed wide observation into scene evidence."""
import json,math
import cv2,numpy as np
import case_store,sequence_sync,wide_reference
from job_store import atomic,digest,lease

def add(case_id,eid,payload):
    if not isinstance(payload,dict) or payload.get('confirmedNoDuplicates') is not True:raise ValueError('중계와 광각의 같은 심판인지 중복 확인을 해 주세요.')
    case=case_store.load_case(case_id);key=case.get('intakeId')
    if not key:raise ValueError('연결된 접수 자료가 없습니다.')
    file=sequence_sync.path(key,eid)
    with lease(file.with_suffix('.lock')) as acquired:
        if not acquired:raise RuntimeError('동기 기록을 저장 중입니다. 다시 시도하세요.')
        sync=sequence_sync.for_case(case_id,eid)
        if sync.get('stale') or payload.get('sequenceVersion')!=sync['version']:raise RuntimeError('동기 기준이 바뀌었습니다. 다시 확인하세요.')
        record=sync.get('record') or {};court=record.get('court') or {};obs=next((x for x in record.get('observations',[]) if x.get('id')==payload.get('id') and x.get('checkpoint')=='start'),None)
        if not obs or obs.get('visibility')!='wide-observed' or obs.get('courtRevision')!=digest(court):raise ValueError('기준 순간에 검수한 광각 심판·코트 기록을 확인하세요.')
        anchor=sync['identity'];cp=(record.get('checkpoints') or {}).get('start') or {}
        if obs.get('broadcastFrame')!=anchor['broadcastFrame'] or obs.get('wideFrame')!=anchor['wideFrame'] or obs.get('wideSha256')!=anchor['wideSha256'] or cp.get('wideSourceId')!=anchor['wideSourceId']:
            raise ValueError('심판 기록과 저장된 같은 순간이 다릅니다.')
        current=wide_reference.view(case_id,eid)
        if payload.get('wideVersion')!=current['version']:raise RuntimeError('광각 심판 근거가 바뀌었습니다. 다시 확인하세요.')
        if current.get('error'):raise RuntimeError('기존 광각 검수 근거가 현재 장면과 달라 자동으로 바꾸지 않습니다. 먼저 확인하세요.')
        _,event,packet,frame=wide_reference.context(case_id,eid);root=case_store.CASES[case_id];reference=wide_reference.selected(root,event,frame['frameIndex']);source=(reference or {}).get('source') or {}
        # A cropped referee is still a detected person. Treat an unplaced
        # broadcast candidate as potentially the same human, not a free slot.
        uncertain=current.get('broadcastUnplacedReferees',[])
        if uncertain:
            raise ValueError('중계 영상에서 발 위치가 미확인인 심판 후보가 있습니다: '+', '.join(uncertain)+'. 같은 사람인지 먼저 확인하고 중복을 해결하세요. 광각 관측은 보관됩니다.')
        if not reference or source.get('sha256',source.get('sourceSha256'))!=anchor['wideSha256'] or source.get('frameIndex')!=anchor['wideFrame']:
            raise ValueError('분석의 광각 참고 화면이 동기 기준과 다릅니다. 같은 광각 프레임을 다시 연결하세요.')
        # The operator's A/B court convention and the existing scene's model
        # convention may face opposite directions. Convert through the SAME
        # broadcast image plane, never assume the two world axes already match.
        model=(frame.get('court') or {}).get('imageToCourt');manual=(court.get('broadcastMap') or {}).get('imageToCourt')
        if model is None or manual is None:raise ValueError('현재 중계 코트와 동기 코트의 기준점을 먼저 확인하세요.')
        try:
            transform=np.asarray(model,dtype=float)@np.linalg.inv(np.asarray(manual,dtype=float))
            values=np.asarray([obs['xy'],[0,7.5],[28,7.5]],dtype=float).reshape(-1,1,2)
            mapped=cv2.perspectiveTransform(values,transform).reshape(-1,2)
        except (ValueError,np.linalg.LinAlgError,cv2.error):raise ValueError('두 코트 좌표 방향을 연결할 수 없습니다.') from None
        if not np.isfinite(mapped).all() or any(not (-4<=x<=32 and -4<=y<=19) for x,y in mapped) or np.linalg.norm(mapped[1]-mapped[2])<10:
            raise ValueError('두 코트의 골대 기준이 일치하지 않습니다. 코트 기준점을 다시 확인하세요.')
        scene_xy=mapped[0].tolist()
        new_id='wide-ref-seq-'+eid+'-'+obs['id'];old=current['supplementalReferees']
        if any(x.get('id')==new_id for x in old):raise ValueError('이미 전달한 심판입니다. 기존 심판 기록을 확인하세요.')
        proof={'schema':'kbl-sequence-position-evidence/v1','caseId':case_id,'eventId':eid,'supplementId':new_id,'identity':anchor,'checkpoint':cp,
            'court':court,'observation':obs,'sceneCourt':model,'sceneCourtRevision':frame.get('courtRevision'),
            'operatorCourtToScene':transform.tolist(),'sceneXY':scene_xy,'sceneBasketA':mapped[1].tolist(),'sceneBasketB':mapped[2].tolist(),
            'timeScope':'selected-instant-only; no sequence continuity implied','status':'operator-reviewed-estimate; not measured posture or gaze'}
        proof_id=digest(proof);proof_file=root/'sequence-evidence'/f'{proof_id}.json'
        if proof_file.exists() and digest(json.loads(proof_file.read_text()))!=proof_id:raise RuntimeError('저장된 동기 근거 해시가 다릅니다.')
        if not proof_file.exists():atomic(proof_file,proof)
        note=(obs.get('note') or '광각에서 같은 순간과 심판 중복을 작업자가 확인')[:140]+f" · 중계 {obs['broadcastPts']:.3f}초 / 광각 {obs['widePts']:.3f}초 · 코트 축 변환 · 근거 {proof_id[:12]}"
        people=old+[{'id':new_id,'xy':scene_xy,'pixelBox':obs['wideBox'],'number':None,'note':note[:300],'sequenceEvidenceId':proof_id}]
        evidence=root/'scene-evidence.json'
        if evidence.exists():
            olddata=json.loads(evidence.read_text());atomic(root/'scene-evidence-history'/f'{digest(olddata)[:20]}.json',olddata)
        # The existing save function preserves the 3-referee limit, roster
        # conflict checks, source binding and conservative scene-evidence flags.
        result=wide_reference.save(case_id,eid,{'version':current['version'],'operation':'supplement','referees':people})
        return {'state':'saved','message':'광각 심판 위치를 장면 근거에 저장했습니다. 공간 장면을 다시 저장하세요.','reference':result}
