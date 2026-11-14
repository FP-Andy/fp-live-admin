"""Local, source-bound manual cross-view evidence. Never an inferred pose."""
import copy,hashlib,json,math
from job_store import digest
from pathlib import Path


def load(root,event,packet,frame,roster):
    path=root/'scene-evidence.json'
    if not path.exists():return None
    value=json.loads(path.read_text()).get('events',{}).get(event['id'])
    if value is None:return None
    expected={'broadcastFrame':frame['frameIndex'],'broadcastSha256':packet['inputSha256'],'datasetId':packet['datasetId']}
    if any(value.get(k)!=v for k,v in expected.items()):raise RuntimeError('장면 보조 근거의 원본·프레임·객체가 변경됐습니다. 광각 대조를 다시 확인하세요.')
    wide=event.get('wide');w=value.get('wide')
    if w and (not wide or w.get('sha256')!=wide['sha256'] or type(w.get('frameIndex')) is not int or not 0<=w['frameIndex']<wide['frames']):raise RuntimeError('광각 근거 원본 또는 프레임을 확인하세요.')
    reference=value.get('wideReference')
    if reference:
        image=(root/reference['image']).resolve()
        if not image.is_relative_to(root.resolve()) or reference.get('broadcastFrame')!=frame['frameIndex'] or hashlib.sha256(image.read_bytes()).hexdigest()!=reference['imageSha256']:
            raise RuntimeError('광각 참고 화면이 변경됐습니다. 심판 보완을 다시 확인하세요.')
        refs=root/'wide-references.json'
        if refs.is_file() and json.loads(refs.read_text())['events'].get(event['id'],{}).get('imageSha256')!=reference['imageSha256']:
            raise RuntimeError('선택한 광각 참고 프레임이 바뀌었습니다. 심판 보완을 다시 확인하세요.')
    ids={p['id'] for p in frame['floorPositions']};ref_ids={p['id'] for p in frame['floorPositions'] if p['role']=='referee'};numbers={r['number'] for r in roster}
    for ref in value.get('supplementalReferees',[]):
        if not (w or reference) or not ref['id'].startswith('wide-ref-') or ref['id'] in ids or len(ref['xy'])!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in ref['xy']) or not(-4<=ref['xy'][0]<=32 and -3<=ref['xy'][1]<=19) or not ref.get('note'):raise ValueError('광각 보완 심판의 근거와 근사 좌표를 확인하세요.')
        proof_id=ref.get('sequenceEvidenceId')
        if proof_id:
            if not isinstance(proof_id,str) or len(proof_id)!=64 or any(c not in '0123456789abcdef' for c in proof_id):raise ValueError('동기 심판 근거 식별자를 확인하세요.')
            try:proof=json.loads((root/'sequence-evidence'/f'{proof_id}.json').read_text())
            except (OSError,ValueError):raise ValueError('동기 심판 근거 파일이 없습니다.') from None
            identity=proof.get('identity') or {}
            refs_path=root/'wide-references.json'
            try:source=(json.loads(refs_path.read_text())['events'][event['id']].get('source') or {})
            except (OSError,ValueError,KeyError):raise RuntimeError('동기 광각 원본 근거가 없습니다.') from None
            if source.get('sha256',source.get('sourceSha256'))!=identity.get('wideSha256') or source.get('frameIndex')!=identity.get('wideFrame'):
                raise RuntimeError('동기 광각 원본 또는 프레임이 바뀌었습니다. 다시 확인하세요.')
            if (digest(proof)!=proof_id or proof.get('eventId')!=event['id'] or proof.get('supplementId')!=ref['id']
                or identity.get('broadcastSha256')!=packet['inputSha256'] or identity.get('broadcastFrame')!=frame['frameIndex']
                or proof.get('sceneXY')!=ref['xy'] or proof.get('sceneCourt')!=(frame.get('court') or {}).get('imageToCourt')
                or proof.get('sceneCourtRevision')!=frame.get('courtRevision')):raise RuntimeError('코트 보정 또는 동기 심판 근거가 바뀌었습니다. 다시 확인하세요.')
        ids.add(ref['id'])
        ref_ids.add(ref['id'])
    if len(ref_ids)>3:raise ValueError('심판 보완이 기존 심판과 중복되는지 확인하세요.')
    for track,identity in value.get('identities',{}).items():
        if track not in ref_ids or identity['number'] not in numbers or identity.get('basis') not in ('visible-jersey-number','operator-roster-match') or identity.get('sourceFrame',frame['frameIndex'])!=frame['frameIndex']:raise ValueError('등번호와 배정 명단을 대조하세요.')
    return {**copy.deepcopy(value),'sha256':hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()}


def apply(root,event,packet,frame,roster):
    try:evidence=load(root,event,packet,frame,roster)
    except (ValueError,RuntimeError,OSError) as exc:
        # Keep image/object editing available, but drop stale supplemental
        # geometry. A new capture must explicitly use the repaired evidence.
        message=str(exc)
        frame['sceneEvidence']={'qualityWarnings':[message],'status':'needs-review',
            'sha256':hashlib.sha256(message.encode()).hexdigest()}
        return
    if not evidence:return
    frame['sceneEvidence']=evidence
    # Deliberately no image box or pose candidate: this person is outside the
    # broadcast image. Existing broadcast joints remain bound to their crops.
    for ref in evidence.get('supplementalReferees',[]):
        frame['floorPositions'].append({'id':ref['id'],'role':'referee','xy':ref['xy'],
            'status':'wide-manual-estimate','source':'wide-manual-evidence','note':ref['note'],
            'approvedForOcclusion':False,'positionOnly':bool(ref.get('sequenceEvidenceId'))})
