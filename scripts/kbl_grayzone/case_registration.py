"""Register uploaded fixtures without borrowing another match's evidence."""
import copy,hashlib,json,os,re,shutil
from pathlib import Path
import case_store

def register(data,media_path):
    from review_intake import write
    number=re.sub('[^0-9]','',data['case']['gameNumber']) or 'new'
    key=f'game{number}-{data["id"][:12]}'
    root=case_store.MANAGED/key
    if (root/'case.json').exists():
        saved=json.loads((root/'case.json').read_text())
        if saved.get('intakeId')!=data['id'] or saved['csvSha256']!=data['case']['csvSha256']:raise RuntimeError('다른 접수 자료와 경기 ID가 충돌했습니다.')
        case_store.CASES[key]=root
        # A previous attempt can have written case.json before linking it to the
        # library. Repair only the missing link; never make an older case latest.
        if data.get('libraryMatchId'):
            import match_library
            library=match_library.get(data['libraryMatchId'])
            history=library.get('caseIds',[])
            if not isinstance(history,list):raise RuntimeError('경기 판독 자료 목록이 손상되었습니다.')
            if key not in history and library.get('caseId')!=key:
                match_library.attach_case(data['libraryMatchId'],key,saved.get('referees',[]))
        return key
    case=copy.deepcopy(data['case']);case.update(id=key,title=f'{case["home"]} vs {case["away"]}',
        intakeId=data['id'],referees=data.get('referees',[]),sourceMode='broadcast-primary',receivedAt=data['receivedAt'],
        wideAssistance={'enabled':False,'primary':'broadcast','version':1,'rollout':'validation-pending'})
    if data.get('strictTracking'):
        import object_cache
        config_path=case_store.ROOT/'runtime/kbl-cv/gpu.json'
        if not config_path.is_file():raise RuntimeError('신규 케이스의 고정 모델 계약을 먼저 설정하세요.')
        policy=json.loads(config_path.read_text()).get('trackingCacheForNewCases')
        if not isinstance(policy,dict):raise RuntimeError('신규 케이스의 고정 모델 계약을 먼저 설정하세요.')
        object_cache.validate_policy(policy,policy.get('image',''))
        case['trackingCachePolicy']=copy.deepcopy(policy)
    case.update(uploadCompletedAt=data.get('uploadCompletedAt'),slaStart='upload-completed',slaMinutes=90)
    if data.get('fixtureDateBasis'):case['fixtureDateBasis']=data['fixtureDateBasis']
    if data.get('libraryMatchId'):
        import match_library
        library=match_library.get(data['libraryMatchId']);case['referees']=data.get('referees',library.get('referees',[]))
        if library.get('fpcMatchId'):
            case.update(fpcMatchId=library['fpcMatchId'],wideReferenceMode='automatic-secondary-camera',
                        wideAssistance={'enabled':False,'primary':'broadcast','version':1,'rollout':'validation-pending'})
            import wide_preparation
            wide_preparation.discover(library['fpcMatchId'])
    media={m['id']:m for m in data['media']}
    # Fail early until a provenance-preserving input normalizer is configured.
    for event in data['events']:
        item=media[event['selection']['mediaId']]
        if not all(k in item for k in ('width','height','fps','duration','frames','sha256')):raise RuntimeError('영상 준비와 원본 검증이 완료되지 않았습니다.')
        if (item['width'],item['height'])!=(1920,1080):raise ValueError('현재 GPU 자세 처리는 1920×1080 영상을 지원합니다. 해당 규격으로 변환해 등록하세요.')
    (root/'broadcast').mkdir(parents=True,exist_ok=True)
    for event,source in zip(case['events'],data['events'],strict=True):
        selection=source['selection'];item=media[selection['mediaId']];path=media_path(data['id'],item['id'])
        with path.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=selection['sourceSha256'] or actual!=item['sha256']:raise RuntimeError('업로드 원본이 변경됐습니다. 다시 등록하세요.')
        name=f'{event["id"]}.mp4';target=root/'broadcast'/name
        if not target.exists():
            try:os.link(path,target)
            except OSError:shutil.copyfile(path,target)
        event.update(broadcast=dict(file=name,sha256=actual,fps=item['fps'],frames=item['frames'],
            width=item['width'],height=item['height'],durationSeconds=item['duration'],originalName=item['name']),
            selectedBroadcastFrame=selection['frameIndex'],selectedFrame=None,broadcastSelection=selection,
            selectionStatus='selected-from-broadcast',selectionNote='중계 화면 기준 · 광각 원본 연결, 장면 정합 대기' if case.get('fpcMatchId') else '중계 화면 기준 · 광각 미연결')
    write(root/'case.json',case);case_store.CASES[key]=root
    import uniforms
    uniforms.link_intake(data['id'],key)
    import match_library
    if not data.get('libraryMatchId'):
        data['libraryMatchId']=match_library.create({k:case.get(k,'') for k in ('home','away','date','gameNumber','venue')})['id']
    match_library.attach_case(data['libraryMatchId'],key,case['referees'])
    return key
