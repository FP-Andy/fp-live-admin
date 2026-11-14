"""Fail-closed identity checks for optional pinned tracking-cache reuse.

Legacy results remain readable. Strict checks only control whether a tracking
result is used as current input for a new processing handoff; they never erase
or rewrite reviewed objects or reports.
"""
import hashlib,re
from pathlib import Path
from job_store import digest

HEX=re.compile(r'^[a-f0-9]{64}$')

def code_sha(root):
    code=hashlib.sha256()
    for path in sorted(p for p in (Path(root)/'scripts/kbl_grayzone').glob('*.py') if not p.name.startswith('test_')):
        code.update(path.name.encode()+b'\0'+path.read_bytes())
    return code.hexdigest()

def validate_policy(policy,image):
    if not isinstance(policy,dict):raise ValueError('객체 캐시 검증 설정을 확인하세요.')
    parts=image.rsplit('@sha256:',1) if isinstance(image,str) else []
    local_id=isinstance(image,str) and image.startswith('sha256:') and bool(HEX.fullmatch(image[len('sha256:'):]))
    if not local_id and (len(parts)!=2 or not parts[0] or not HEX.fullmatch(parts[1])):
        raise ValueError('객체 캐시 검증에는 변경 불가능한 GPU 이미지 digest가 필요합니다.')
    for field in ('detectorSha256','roleSha256'):
        if not isinstance(policy.get(field),str) or not HEX.fullmatch(policy[field]):raise ValueError(f'객체 캐시 검증 설정에 {field}가 필요합니다.')
    if not isinstance(policy.get('courtModel'),str) or not policy['courtModel'].strip():raise ValueError('코트 모델 버전이 필요합니다.')
    if not isinstance(policy.get('settingsVersion'),str) or not policy['settingsVersion'].strip():raise ValueError('추적 설정 버전이 필요합니다.')
    return {k:policy[k] for k in ('detectorSha256','roleSha256','courtModel','settingsVersion')}

def contract(config,event,index,root):
    """Build the expected immutable tracking identity or refuse the input."""
    per_case=event.get('_trackingCachePolicy')
    policy=per_case if per_case is not None else config.get('trackingCacheContract')
    if policy is None:return None  # legacy mode: existing behavior is unchanged
    image=per_case.get('image','') if isinstance(per_case,dict) else config.get('image','')
    fields=validate_policy(policy,image)
    source=event.get('broadcast') or {};sha=source.get('sha256')
    if not isinstance(sha,str) or not HEX.fullmatch(sha) or type(index) is not int:raise ValueError('객체 캐시의 원본과 프레임을 확인하세요.')
    selection=event.get('broadcastSelection') or {}
    spec={'schema':'kbl-object-cache/v1','sourceSha256':sha,'frameIndex':index,
          'video':{k:source.get(k) for k in ('fps','frames','width','height','durationSeconds')},
          'windowSeconds':selection.get('actionWindowSeconds',12),'image':image,
          'workerCodeSha256':code_sha(root),**fields}
    return {**spec,'fingerprint':digest(spec)}

def status(packet,expected):
    if expected is None:return 'legacy-unverified'
    old=packet.get('trackingProvenance')
    if not isinstance(old,dict) or old.get('verified') is not True:return 'unverified'
    if old.get('fingerprint')!=expected['fingerprint']:return 'changed'
    if (packet.get('inputSha256')!=expected['sourceSha256']
        or packet.get('detector',{}).get('modelSha256')!=expected['detectorSha256']
        or packet.get('roleClassifier',{}).get('modelSha256')!=expected['roleSha256']
        or not any(f.get('frameIndex')==expected['frameIndex'] for f in packet.get('frames',[]))):return 'changed'
    return 'current'

def require_current(packet,expected):
    result=status(packet,expected)
    if expected is not None and result!='current':
        raise RuntimeError('객체 결과의 원본·프레임·모델·실행 버전이 확인되지 않거나 변경됐습니다. 기존 수동 검수는 보존됩니다. 새 작업으로 확인하세요.')
    return result

def verified_packet(packet,expected,worker_code_sha,court_model):
    if expected is None:return packet
    if (worker_code_sha!=expected['workerCodeSha256'] or court_model!=expected['courtModel']
        or packet.get('inputSha256')!=expected['sourceSha256']
        or packet.get('detector',{}).get('modelSha256')!=expected['detectorSha256']
        or packet.get('roleClassifier',{}).get('modelSha256')!=expected['roleSha256']
        or not any(f.get('frameIndex')==expected['frameIndex'] for f in packet.get('frames',[]))):
        raise RuntimeError('새 객체 결과의 모델·코드·원본 버전을 확인할 수 없습니다. 기존 검수는 유지됩니다.')
    return {**packet,'trackingProvenance':{**expected,'verified':True}}
