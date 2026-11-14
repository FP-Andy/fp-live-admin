"""A source-bound, portable evidence ZIP for human/AI-assisted report writing.

Only selected frames and explicitly selected data fields leave the case folder.
No inference, remote service, credentials, mesh weights, or full videos are used.
"""
import hashlib
import json
import re
import shutil
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image
from case_store import CASES, load_case, broadcast_packet
import broadcast_reconstruction as reconstruction
import report_inputs
from report_commentary import entity_labels
from report_map import marked_map, prepare_map_presentations
from report_editorial import scene_commentary,context_changed

LOCK=threading.Lock()
ROOT=Path(__import__('case_store').ROOT)
GUIDE=ROOT/'scripts/kbl_grayzone/review-package-guide.md'
EVENT_FIELDS=('id','number','quarter','gameClock','gameClockSeconds','reviewDurationSeconds','requestType','requestingTeam','recordedDecision','recordedReason','decisionSource')
BOX_FIELDS=('id','box','pixelBox','confidence','role','roleHint','roleSource','roleConfidence','roleProbabilities','team','teamSource','teamConfidence','source','boxSource','boxEvidenceTimes','footpointPixels','footpointStatus','footpointEvidence','footpointNote','spatialExcluded','manuallyReviewed')
POSE_FIELDS=('jobId','frameIndex','datasetId','revision','pipelineVersion','threshold','modelSha256','meshSha256','poseSource','depthMeasured','poseMeasured','limitations','manualJointCount','manualArmCount')
PERSON_FIELDS=('id','role','team','x','y','pixelBox','keypoints','scores','accepted','autoAccepted','spatialEligible','spatialReason','bodyHeading','bodyDirection','jointWorld','jointUsable','fallbackBones','armQuality','status','armRig','eyeLocal')

def pick(value,keys):return {k:value[k] for k in keys if k in value}
def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def write_json(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def jpg(path,image):
    if not isinstance(image,Image.Image):image=Image.fromarray(image[:,:,::-1])
    image.convert('RGB').save(path,quality=94,subsampling=0)
def pose_data(value):
    return {**pick(value,POSE_FIELDS),'people':[pick(p,PERSON_FIELDS) for p in value.get('people',[])]} if value else None
def scene_evidence(snapshot):
    value=(snapshot.get('sceneEvidence') or {})
    return {**pick(value,('broadcastFrame','broadcastSha256','datasetId','broadcastClock','observation','qualityWarnings','sha256')),
        'wide':pick(value.get('wide',{}),('sha256','frameIndex','clock','frameAlignmentVerified','purpose')),
        **({'wideReference':pick(value['wideReference'],('imageSha256','broadcastFrame'))} if value.get('wideReference') else {}),
        'identities':{key:pick(item,('number','basis','sourceFrame','note')) for key,item in value.get('identities',{}).items()},
        'supplementalReferees':[pick(item,('id','xy','pixelBox','footpointPixels','positionUncertaintyMetres','pose','note','sequenceEvidenceId')) for item in value.get('supplementalReferees',[])]}
def include_sequence_evidence(root,evidence,dest):
    # Include the immutable proof itself, not just a pointer into local storage.
    from job_store import digest as evidence_digest
    files=[]
    for ref in evidence.get('supplementalReferees',[]):
        proof_id=ref.get('sequenceEvidenceId')
        if not proof_id:continue
        if not isinstance(proof_id,str) or len(proof_id)!=64 or any(c not in '0123456789abcdef' for c in proof_id):raise ValueError('동기 심판 근거를 확인하세요.')
        source=root/'sequence-evidence'/f'{proof_id}.json';proof_data=json.loads(source.read_text())
        if evidence_digest(proof_data)!=proof_id:raise ValueError('동기 심판 근거 해시가 다릅니다.')
        target=dest/'sequence-evidence'/f'{proof_id}.json';target.parent.mkdir(exist_ok=True);shutil.copyfile(source,target)
        files.append(str(target.relative_to(dest)))
    return files

def target_data(snapshot):
    state=snapshot['state'];point=state.get('reviewPoint')
    person=next(e for e in state['entities'] if e['id']==state['targetId'])
    return {**(point or pick(person,('x','y'))),'z':state['targetHeight'],'source':'manual-map' if point else 'selected-person',
            'entityId':None if point else person['id']}

def tracking_context(packet,index):
    frames=[f for f in packet['frames'] if abs(f['frameIndex']-index)<=packet['fps']*2]
    selected={}
    for f in frames:
        bucket=round((f['frameIndex']-index)/packet['fps']*4)
        if bucket not in selected or abs(f['frameIndex']-index-bucket*packet['fps']/4)<abs(selected[bucket]['frameIndex']-index-bucket*packet['fps']/4):selected[bucket]=f
    return [{'frameIndex':f['frameIndex'],'t':f['t'],'idScope':f.get('idScope','unverified'),
             'objects':[pick(b,BOX_FIELDS) for b in f['boxes']],'ball':f.get('ball')} for _,f in sorted(selected.items())]

def source_stamp(case):
    from wide_reference import version as wide_version
    wide_sha=wide_version(CASES[case['id']])
    return {'revision':case['revision'],'csvSha256':case['csvSha256'],'recordsVersion':case.get('recordsVersion'),
        **({'wideReferenceSha256':wide_sha} if wide_sha else {}),
        'events':[{**pick(e,('id','selectedFrame','selectedBroadcastFrame','trackingStatus')),
            'broadcastSha256':e['broadcast']['sha256'],'wideSha256':(e.get('wide') or {}).get('sha256'),'analysisMoment':e.get('broadcastSelection',{}).get('analysisMoment')} for e in case['events']]}

def assert_current(case_id,stamp,version,captures):
    if source_stamp(load_case(case_id))!=stamp or report_inputs.version(case_id)!=version:
        raise RuntimeError('자료를 모으는 동안 경기 또는 코멘트가 바뀌었습니다. 다시 내려받아 주세요.')
    for eid,capture in captures.items():
        if reconstruction.current(case_id,eid,strict=True)['captureId']!=capture:
            raise RuntimeError('공간 장면이 바뀌었습니다. 최신 자료 묶음을 다시 만들어 주세요.')

def csv_source(case_id,case):
    path=CASES[case_id]/'source/reviews.csv'
    if not path.exists() and case.get('intakeId'):
        from review_intake import folder
        path=folder(case['intakeId'])/'reviews.csv'
    if path.exists():
        if digest(path)!=case['csvSha256']:raise RuntimeError('원본 CSV가 변경됐습니다. 경기 정보를 다시 확인하세요.')
        return path
    return None

def scene_markdown(data):
    e=data['event'];c=data['comments']['effective'];fields=data['comments']['fields'];images=data['images'];rows=data['spatial']['crewAnalysis']['rows']
    lines=[f"# 장면 {e['number']} · {e['quarter']}Q {e['gameClock']}",'',
        f"- 최초 콜: {c['initialCall']}",f"- 원심·판독 분류: {e['recordedDecision']} · 최종 기록: {e['recordedReason']}",
        f"- 콜 담당자: {c['callingReferee']}",f"- 상황: {c['context']}",
        f"- 현재 코멘트와 공간 장면 일치: {'예' if data['commentsMatchCurrentScene'] else '아니요 — 이전 코멘트를 새 장면에 맞게 다시 검토'}",'',
        '## 원본과 추출 결과','']
    for key,title in [('broadcastOriginal','중계 원본 화면'),('broadcastAnnotated','중계 객체·관절 표시'),('wideOriginal','광각 원본 화면'),('wideAnnotated','광각 객체·관절 표시'),('wideReference','광각 참고 화면'),('map','별표와 2D 맵'),('overview','3D 공간')]:
        if key in images:lines.extend([f'### {title}','',f'![{title}]({images[key]})',''])
    lines.extend(['## 세 심판의 간접 시야','', '| 화면 라벨 | 배정 심판 매칭 | 가림 없는 표본 | 가림 | 시야 밖 | 가림 객체 |','|---|---|---:|---:|---:|---|'])
    mapping=data['referees']
    for r in rows:
        official=next(x for x in mapping if x['trackId']==r['id']);counts=r['counts'];blockers=', '.join(data['spatial']['labels'].get(x,x) for x in r['blockers']) or '없음'
        lines.append(f"| {r['label']} | {official['name'] or '미확정'} {('#'+str(official['number'])) if official['number'] else ''} | {counts['visible']}/9 | {counts['blocked']}/9 | {counts['outside']}/9 | {blockers} |")
    for i in range(1,4):lines.extend(['',f"![R{i} 간접 시야]({images['eye'+str(i)]})"])
    lines.extend(['','## 현재 문안',''])
    for label,key in [('판독 지점','targetExplanation'),('시야 해설','viewComment'),('판독 쟁점','difficultyFactors'),('실제 콜과 대조','comparison'),('판독 총평','assessment')]:lines.extend([f'### {label}','',c[key],''])
    for label,key in [('작업자 관찰','observation'),('판독 근거','decisionBasis'),('시사점','takeaway')]:lines.extend([f'### {label}','',fields.get(key) or '미입력',''])
    lines.extend(['## 확인할 항목','']+[f'- {s}' for s in data['limitations']])
    lines.extend(['','수치·좌표·추정 관절·출처는 [data.json](data.json)을 참고하세요. R/P 라벨은 이 장면 내부의 객체 라벨이며, 번호 매칭과 실제 콜 담당자는 별도입니다.',''])
    return '\n'.join(lines)

def collect_scene(case_id,case,event,row,snapshot,editorial,poses,inputs,dest):
    from case_report_layout import scene_images
    root=CASES[case_id];dest.mkdir(parents=True);images_dir=dest/'images';images_dir.mkdir();raw={}
    primary,secondary,proof=scene_images(case_id,root,event,row,snapshot,poses,inputs,evidence=raw)
    packet=broadcast_packet(case_id,event['id']);frame=raw['broadcastFrame'];item=editorial.get('events',{}).get(event['id'],{})
    reference=None;reference_proof=None
    if secondary is None:
        from case_report_layout import wide_reference
        reference,reference_proof=wide_reference(root,event,snapshot)
        if reference_proof:proof['wideReference']=pick(reference_proof,('imageSha256','broadcastSha256','broadcastFrame','displayCrop','status','operatorConfirmedInstant','pairRevision','wideFrameIndex','wideSourceSha256','frameAccurateSyncVerified','usedInGeometry','objectAnnotations','poseAnnotations','candidateSeconds','clipSha256'))
    images={}
    if reference is not None:jpg(images_dir/'wide-reference.jpg',reference);images['wideReference']='images/wide-reference.jpg'
    for key,name,value in [('broadcastOriginal','broadcast-original.jpg',raw['broadcastOriginal']),('broadcastAnnotated','broadcast-annotated.jpg',primary),('wideOriginal','wide-original.jpg',raw.get('wideOriginal')),('wideAnnotated','wide-annotated.jpg',secondary)]:
        if value is not None:jpg(images_dir/name,value);images[key]='images/'+name
    folder=root/'reconstructions'/event['id']/snapshot['captureId']
    map_source=prepare_map_presentations(root,case,{event['id']:snapshot})[event['id']] if snapshot.get('caseId') else folder/'crewMap.jpg'
    map_image,map_proof=marked_map(map_source,snapshot,(1000,760),map_layout='apron-v2' if snapshot.get('caseId') else None);jpg(images_dir/'court-2d.jpg',map_image);images['map']='images/court-2d.jpg';proof['map']=map_proof
    for key in ('overview','eye1','eye2','eye3'):
        name=key+'.jpg';shutil.copyfile(folder/name,images_dir/name);images[key]='images/'+name
    refs=[];mapping=report_inputs.assignments(case,snapshot,item)
    for i,r in enumerate(snapshot['crewAnalysis']['rows'],1):
        number=mapping.get(r['id']);person=next((p for p in case['referees'] if p['number']==number),{})
        photo=report_inputs.referee_file(case_id,event['id'],i);name=f'referee-R{i}-original.jpg';shutil.copyfile(photo,images_dir/name)
        refs.append({'label':r['label'],'trackId':r['id'],'number':number,'name':person.get('name'),'sourceImage':'images/'+name})
    fields={**report_inputs.fields(item),'refereeAssignments':mapping};comment=scene_commentary(case,event,snapshot,item)
    sequence_files=include_sequence_evidence(root,snapshot.get('sceneEvidence') or {},dest)
    limits=list((snapshot.get('sceneEvidence') or {}).get('qualityWarnings',[]))
    timing=('광각은 작업자가 같은 순간으로 선택한 정지 프레임입니다. 선택 정확도와 인물 ID는 별도 검수해야 합니다.' if reference_proof and reference_proof.get('operatorConfirmedInstant') else '중계·광각의 시간 정합 및 인물 ID 대응은 별도 검증이 필요합니다.' if event.get('wide') else '광각 참고 사진은 근접 시점이며 중계와의 정밀 동기화는 미검증입니다.' if reference is not None else '이 장면의 광각 참고 화면은 아직 연결되지 않았습니다.')
    limits.extend(['정지 프레임 자료이며 원본 동영상은 포함하지 않습니다.','방향·시야각·대상 높이는 가정이며 실제 주시 방향과 접촉 깊이는 미측정입니다.',timing])
    if not snapshot['crewAnalysis']['sceneComplete']:limits.append('공간에 배치하지 않은 객체가 있어 해당 객체의 가림은 계산에 포함되지 않습니다.')
    data={'schema':'kbl-comment-evidence-scene/v1','caseId':case_id,'event':pick(event,EVENT_FIELDS),
        'analysisMoment':event.get('broadcastSelection',{}).get('analysisMoment'),
        'source':{'csvSha256':case['csvSha256'],'recordsVersion':case.get('recordsVersion'),'selectionRevision':case['revision'],'captureId':snapshot['captureId'],'editorialVersion':report_inputs.version(case_id)},
        'images':images,'imageEvidence':proof,'referees':refs,'sceneEvidence':scene_evidence(snapshot),'sequenceEvidenceFiles':sequence_files,
        'broadcast':{'frameIndex':snapshot['frameIndex'],'fps':packet['fps'],'width':packet['width'],'height':packet['height'],
            'inputSha256':packet['inputSha256'],'datasetId':packet['datasetId'],'idScope':frame.get('idScope','unverified'),
            'objects':[pick(b,BOX_FIELDS) for b in raw['broadcastObjects']],'pose':pose_data(raw['broadcastPose']),
            'ball':frame.get('ball'),'ballTags':frame.get('ballObjects',[]),'floorPositions':frame.get('floorPositions',[]),
            'trackingContext':tracking_context(packet,snapshot['frameIndex'])},
        'wide':{'frameIndex':proof['wide']['frameIndex'],'fps':event['wide']['fps'],'width':raw['wideOriginal'].shape[1],'height':raw['wideOriginal'].shape[0],
            'inputSha256':event['wide']['sha256'],'objects':[pick(b,BOX_FIELDS) for b in raw['wideObjects']],
            'ball':raw.get('wideBall'),'pose':pose_data(raw.get('widePose'))} if secondary is not None else None,
        'spatial':{'state':snapshot['state'],'target':target_data(snapshot),'labels':entity_labels(snapshot),'crewAnalysis':snapshot['crewAnalysis'],
            'poseJobId':snapshot.get('poseJobId'),'meshSha256':snapshot['meshSha256'],'poseMeshSha256':snapshot.get('poseMeshSha256'),
            'validity':pick(snapshot,('metricCalibrationVerified','alignmentVerified','gazeVerified','visibilityStatus','pose','omittedTrackIds','footpointCorrections'))},
        'alignment':{'verified':snapshot.get('alignmentVerified',False),'broadcastClock':(snapshot.get('sceneEvidence') or {}).get('broadcastClock'),
            'wideClock':(snapshot.get('sceneEvidence') or {}).get('wide',{}).get('clock'),'sync':pick(event.get('sync',{}),('wideAtBroadcastZero','status','method','uncertaintySeconds'))},
        'commentsMatchCurrentScene':not (context_changed(event,item) or (editorial.get('csvSha256') and editorial['csvSha256']!=case['csvSha256']) or (item.get('scene') and item['scene'].get('captureId')!=snapshot['captureId'])),
        'comments':{'fields':fields,'effective':comment},'limitations':limits}
    write_json(dest/'data.json',data);(dest/'scene.md').write_text(scene_markdown(data));return data

def include_pdf(case_id,case,captures,version,dest):
    pdf=ROOT/'output/pdf'/f'kbl-{case_id}-tracking-review.pdf'
    try:
        import report_versions
        if (ROOT/'output/pdf/versions'/case_id/'index.json').is_file():pdf=report_versions.latest_file(case_id)
        meta=json.loads(pdf.with_suffix('.json').read_text())
        if meta.get('layoutVersion') not in ('summary-clips-v6','summary-clips-v7','summary-clips-v8','summary-clips-v9','summary-clips-v10','summary-clips-v11','summary-clips-v12') or meta.get('selectionRevision')!=case['revision'] or meta.get('editorialSha256')!=(None if version=='empty' else version) or meta.get('csvSha256')!=case['csvSha256']:return False
        if case.get('recordsVersion') and meta.get('recordsVersion')!=case['recordsVersion']:return False
        from wide_reference import version as wide_version
        if meta.get('wideReferenceSha256')!=wide_version(CASES[case_id]):return False
        if {k:v['captureId'] for k,v in meta['broadcastReconstructions'].items()}!=captures or meta['pdfSha256']!=digest(pdf):return False
        shutil.copyfile(pdf,dest/'report.pdf');return True
    except (OSError,ValueError,KeyError):return False

def build(case_id,payload):
    if not LOCK.acquire(blocking=False):raise RuntimeError('자료 묶음을 만드는 중입니다. 완료 후 다시 시도하세요.')
    started=time.perf_counter()
    try:
        case=load_case(case_id);version=report_inputs.version(case_id)
        if not isinstance(payload,dict) or payload.get('revision')!=case['revision'] or payload.get('version')!=version:raise RuntimeError('경기 또는 코멘트가 바뀌었습니다. 새로고침 후 다시 내려받아 주세요.')
        if not 1<=len(case['events'])<=10:raise ValueError('한 경기의 판독 장면 1~10개를 묶을 수 있습니다.')
        snapshots={e['id']:reconstruction.current(case_id,e['id'],strict=True) for e in case['events']}
        stamp=source_stamp(case);captures={k:v['captureId'] for k,v in snapshots.items()};editorial=report_inputs.read(case_id)
        root=CASES[case_id];store=root/'review-packages';store.mkdir(exist_ok=True)
        if all(s.get('caseId') for s in snapshots.values()):prepare_map_presentations(root,case,snapshots)
        with tempfile.TemporaryDirectory(prefix='building-',dir=store) as temp:
            work=Path(temp);files=work/'files';files.mkdir()
            from case_evidence import prepare
            inputs=work/'selected-frames';rows=prepare(case_id,root/'results',inputs);by_id={r['eventId']:r for r in rows}
            pose_path=root/'pose/predictions.json';poses={p['clipId']:p for p in json.loads(pose_path.read_text())['frames']} if pose_path.exists() else {}
            source=csv_source(case_id,case)
            if source:shutil.copyfile(source,files/'reviews.csv')
            game={**pick(case,('id','title','gameNumber','date','home','away','venue','referees','uniforms','csvSha256','revision','recordsVersion')),
                'events':[pick(e,EVENT_FIELDS) for e in case['events']],'csvIncluded':bool(source),
                'editorialSource':pick(editorial.get('source',{}),('title','url','checkedAt'))}
            write_json(files/'game.json',game);shutil.copyfile(GUIDE,files/'COMMENT_GUIDE.md')
            scenes=[]
            for event in case['events']:
                if not re.fullmatch(r'review-\d+',event['id']):raise ValueError('잘못된 장면 ID입니다.')
                scenes.append(collect_scene(case_id,case,event,by_id[event['id']],snapshots[event['id']],editorial,poses,inputs,files/'clips'/event['id']))
            comments={'schema':'kbl-comment-writing-draft/v1','caseId':case_id,'fieldLimits':report_inputs.LIMITS,
                'events':[{'id':s['event']['id'],'captureId':s['source']['captureId'],'commentsMatchCurrentScene':s['commentsMatchCurrentScene'],'fields':s['comments']['fields']} for s in scenes]}
            write_json(files/'comments.json',comments)
            pdf_included=include_pdf(case_id,case,captures,version,files)
            readme=[f"# {case['title']} · 판독 해설 자료 묶음",'',f"경기 {case['gameNumber']} · {case['date']} · {len(scenes)}개 장면",'',
                '## 이 파일 하나로 요청하기','',
                '> 이 ZIP의 가이드와 장면별 데이터·이미지를 읽고 판독 지점 설명, 시야 해설, 총평을 작성해 줘. 작성자의 판독 의견을 먼저 제시하고 화면·배치의 근거를 연결해 줘. 공통 분석 가정은 별도로 정리하고, 기록 사실과 분석 의견을 구분한 스텝 4용 문안을 제시해 줘. 내 추가 설명은 다음과 같아: …','',
                '## 읽는 순서','',
                '1. [작성 가이드](COMMENT_GUIDE.md): 해석 범위, 질문, 문안 형식과 길이',
                '2. [경기·판독 기록](game.json) — 정정한 현재 기록을 기준으로 해석' +(' 및 [원본 CSV](reviews.csv)' if source else ' — 원본 CSV 파일이 없어 구조화된 기록으로 제공'),
                '3. 아래 장면별 설명·이미지·수치',
                '4. [현재 입력 문안](comments.json): 스텝 4 필드와 대응. 자동 가져오기용 파일은 아님','원본 CSV는 업로드 당시 기록이며, 이후 정정은 game.json 및 장면별 data.json의 현재 시각·결과에 반영됩니다.','',
                '## 판독 장면','']
            for s in scenes:
                e=s['event'];readme.append(f"- [장면 {e['number']} · {e['quarter']}Q {e['gameClock']} · {e['recordedDecision']}](clips/{e['id']}/scene.md)")
            readme.extend(['','## 포함 범위','',
                '중계·광각 기준 프레임의 원본/추출 결과, 별표 2D 맵, 3D 공간, 세 심판의 간접 시야, 객체·관절·가림 수치, 심판 매칭, 현재 코멘트, 출처와 제한사항입니다.',
                '[현재 PDF](report.pdf)도 포함했습니다.' if pdf_included else '현재 데이터와 일치하는 PDF가 없어 PDF는 포함하지 않았습니다. 문안 작성에는 장면별 이미지와 데이터가 제공됩니다.',
                '원본 동영상·학습 데이터·모델 가중치·인증 파일은 포함하지 않습니다. 영상의 움직임·접촉 순서가 필요하면 작업자 설명이나 짧은 영상을 추가하세요.',
                '분석 결과는 수동 보정과 가정을 포함합니다. manifest.json은 파일별 해시와 저장 시점을 기록합니다. 이 묶음은 자동 AI 전송이나 자동 판정 기능이 아닙니다.',''])
            (files/'README.md').write_text('\n'.join(readme))
            assert_current(case_id,stamp,version,captures)
            entries=[{'path':p.relative_to(files).as_posix(),'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted(files.rglob('*')) if p.is_file()]
            manifest={'schema':'kbl-comment-evidence-package/v1','caseId':case_id,'createdAt':datetime.now(timezone.utc).isoformat(),
                'sourceStamp':stamp,'editorialVersion':version,'captures':captures,'sceneCount':len(scenes),'pdfIncluded':pdf_included,'files':entries}
            package_id=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:24];manifest['packageId']=package_id
            write_json(files/'manifest.json',manifest)
            archive=work/'package.zip'
            with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
                for p in sorted(files.rglob('*')):
                    if p.is_file():z.write(p,p.relative_to(files).as_posix(),compress_type=zipfile.ZIP_STORED if p.suffix in ('.jpg','.pdf') else zipfile.ZIP_DEFLATED)
            assert_current(case_id,stamp,version,captures)
            target=store/f'{package_id}.zip';archive.replace(target)
            write_json(target.with_suffix('.json'),{**manifest,'archiveSha256':digest(target)})
        return {'packageId':package_id,'download':f'/case-review-package/{case_id}/{package_id}.zip','sceneCount':len(scenes),
                'fileCount':len(entries)+1,'bytes':target.stat().st_size,'pdfIncluded':pdf_included,'seconds':round(time.perf_counter()-started,3)}
    finally:LOCK.release()

def bundle_file(case_id,package_id):
    if not re.fullmatch(r'[a-f0-9]{24}',package_id):raise ValueError('자료 묶음 ID를 확인하세요.')
    root=CASES[case_id]/'review-packages';path=root/f'{package_id}.zip';meta=json.loads(path.with_suffix('.json').read_text())
    if meta['caseId']!=case_id or meta['packageId']!=package_id or digest(path)!=meta['archiveSha256']:raise RuntimeError('자료 묶음이 변경됐습니다. 다시 생성하세요.')
    assert_current(case_id,meta['sourceStamp'],meta['editorialVersion'],meta['captures'])
    return path
