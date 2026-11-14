"""Versioned, explicitly illustrative broadcast scene captures for PDF export."""
import base64,hashlib,io,json,math,threading
from pathlib import Path
from PIL import Image
from case_store import CASES,load_case,broadcast_packet,broadcast_index
from read_context import memoized

LOCK=threading.Lock()
KINDS=('map','overview','eye','crewMap','eye1','eye2','eye3')
RENDERER_VERSION='crew-visibility-v5-mannequin'
READABLE_RENDERER_VERSIONS={RENDERER_VERSION,'crew-visibility-v4'}
def scene_roles(frame,entities):
    """Floor detections plus explicitly placed, still-present image objects."""
    roles={p['id']:p['role'] for p in frame.get('floorPositions',[])}
    boxes={b['id']:b for b in frame.get('boxes',[])}
    for e in entities:
        if e.get('id') in roles:continue
        box=boxes.get(e.get('id'))
        if not box or (box.get('spatialExcluded') and e.get('spatialOverride') is not True) or e.get('positionSource')!='manual':
            raise ValueError('발 위치가 없는 인물은 현재 영상 객체를 선택해 코트 위치를 직접 지정하세요.')
        roles[e['id']]=box['roleHint']
    return roles

def context(case_id,event_id,require_floor=True):
    case=load_case(case_id);event=next(e for e in case['events'] if e['id']==event_id)
    packet=broadcast_packet(case_id,event_id)
    index=broadcast_index(event,packet['fps'])
    frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    if not frame or (require_floor and not frame.get('floorPositions')):raise RuntimeError('이 기준 프레임의 중계 코트 좌표가 없습니다.')
    return case,event,packet,frame

@memoized
def current(case_id,event_id,strict=False):
    case,event,packet,frame=context(case_id,event_id)
    root=CASES[case_id]/'reconstructions'/event_id
    try:
        data=json.loads((root/'current.json').read_text())
        if data.get('crewAnalysis',{}).get('targetSamplingVersion',1)<2 and data['state']['targetHeight']>1.73:
            if strict:raise RuntimeError('높은 판독 지점의 가림 계산을 갱신하세요. 현재 좌표·자세는 저장되어 있습니다.')
            data['targetSamplingStale']=True
        if data.get('courtRevision')!=frame.get('courtRevision'):
            if strict:raise RuntimeError('코트 보정이 변경됐습니다. 공간 이미지를 다시 저장하세요.')
            data['courtStale']=True
        if data.get('sceneEvidenceSha256')!=(frame.get('sceneEvidence') or {}).get('sha256'):
            if strict:raise RuntimeError('광각 대조·등번호 근거가 갱신됐습니다. 공간 이미지를 다시 저장하세요.')
            data['evidenceStale']=True
        import uniforms
        if data.get('rendererVersion') not in READABLE_RENDERER_VERSIONS:
            if strict:raise RuntimeError('코트·방향 표시가 업데이트됐습니다. 공간 이미지를 다시 저장하세요.')
            data['rendererStale']=True
        if data.get('uniformRevision',0)!=uniforms.load('cases',case_id)['revision']:
            if strict:raise RuntimeError('유니폼 색상이 변경됐습니다. 공간 이미지를 다시 저장하세요.')
            data['uniformStale']=True
        if any(data[k]!=v for k,v in {'frameIndex':frame['frameIndex'],
                'datasetId':packet['datasetId'],'inputSha256':packet['inputSha256']}.items()):raise RuntimeError('공간 장면의 원본·모델·기준 프레임이 변경됐습니다. 이미지를 다시 저장하세요.')
        if data.get('selectionVersion') and event.get('selectionVersion') and data['selectionVersion']!=event['selectionVersion']:raise RuntimeError('이 장면의 기준 프레임이 변경됐습니다. 이미지를 다시 저장하세요.')
        entities=data['state']['entities']
        try:roles=scene_roles(frame,entities)
        except ValueError:
            if strict:raise RuntimeError('객체 목록과 수동 공간 배치가 다릅니다. 공간 장면을 다시 저장하세요.')
            roles={p['id']:p['role'] for p in frame['floorPositions']};data['objectStale']=True
        if len(entities)!=len(roles) or {e['id']:e['role'] for e in entities}!=roles:
            if strict:raise RuntimeError('객체 목록·역할과 공간 이미지가 다릅니다. 공간 장면을 다시 저장하세요.')
            data['objectStale']=True
        mesh=Path(__file__).resolve().parents[2]/'apps/web/public/kbl-grayzone/assets/humans/mpfb-court-v1.json'
        if data.get('meshSha256')!=hashlib.sha256(mesh.read_bytes()).hexdigest():raise RuntimeError('인체 모델이 변경됐습니다. 이미지를 다시 저장하세요.')
        if data.get('poseJobId'):
            import broadcast_pose
            try:
                pose=broadcast_pose.validate_pose(case_id,event_id,data['poseJobId'],data['state']['entities'])
                if data.get('poseVariantId'):
                    import pose_variant
                    pose,_,_=pose_variant.load(case_id,event_id,data['poseVariantId'],data['state'],pose)
                if pose['meshSha256']!=data.get('poseMeshSha256'):raise RuntimeError('자세 메시가 변경됐습니다. 이미지를 다시 저장하세요.')
            except RuntimeError:
                if strict:raise
                data['poseStale']=True
        for kind,asset in data['images'].items():
            path=root/data['captureId']/f'{kind}.jpg'
            if hashlib.sha256(path.read_bytes()).hexdigest()!=asset['sha256']:raise RuntimeError('공간 이미지가 변경됐습니다.')
        return data
    except FileNotFoundError:
        if strict:raise RuntimeError('공간 장면 이미지를 먼저 저장하세요.')
    except RuntimeError:
        if strict:raise
    return None

def number(value,lo,hi):
    if type(value) not in (float,int) or not math.isfinite(value) or not lo<=value<=hi:raise ValueError('공간 설정 값이 범위를 벗어났습니다.')
    return value

def validate_crew(value,state,frame):
    """Bind the browser's mesh-ray results to the exact reviewed scene and crew."""
    if not isinstance(value,dict) or value.get('schema')!='kbl-crew-visibility/v1':raise ValueError('세 심판의 시야 비교를 갱신하세요.')
    refs=[e for e in state['entities'] if e['role']=='referee'];target=state.get('reviewPoint') or next(e for e in state['entities'] if e['id']==state['targetId'])
    if len(refs)>3:raise ValueError('중계·광각 심판이 중복되어 3명을 초과합니다. 같은 심판의 중복 배치를 확인하세요.')
    if value.get('reviewPoint')!=state.get('reviewPoint'):raise ValueError('별표 지점이 변경됐습니다. 시야 비교를 다시 계산하세요.')
    rows=value.get('rows',[])
    if [r.get('id') for r in rows]!=[e['id'] for e in refs[:3]]:raise ValueError('심판 시점 목록이 검토 객체와 다릅니다.')
    for key in ('hfov','vfov','targetId','targetHeight'):
        if value.get(key)!=state[key]:raise ValueError('시야 비교 설정이 공간 설정과 다릅니다.')
    if state['targetHeight']>1.73 and value.get('targetSamplingVersion',1)<2:raise ValueError('높은 표적의 가림 계산을 새로고침하세요.')
    ids={e['id'] for e in state['entities']};clean=[]
    for i,(ref,row) in enumerate(zip(refs,rows)):
        selected=ref['id']==state['observerId'];manual=state['headingMode']=='manual-assumption' if selected else 'viewHeading' in ref
        heading=(state['heading'] if selected else ref['viewHeading']) if manual else math.atan2(target['y']-ref['y'],target['x']-ref['x'])
        angle=number(row.get('heading'),-math.pi,math.pi)
        if abs(math.atan2(math.sin(angle-heading),math.cos(angle-heading)))>1e-6:raise ValueError('심판별 방향을 다시 계산하세요.')
        counts=row.get('counts',{})
        if set(counts)!={'visible','blocked','outside'} or any(type(n) is not int or not 0<=n<=9 for n in counts.values()) or sum(counts.values())!=9:raise ValueError('가시 광선 집계가 올바르지 않습니다.')
        fraction=number(row.get('fraction'),0,1)
        if abs(fraction-counts['visible']/9)>1e-9:raise ValueError('가시 비율과 광선 수가 다릅니다.')
        blockers=row.get('blockers',[])
        if not isinstance(blockers,list) or not set(blockers)<=ids-{ref['id'],target.get('id')} or bool(blockers)!=bool(counts['blocked']):raise ValueError('가림 객체 근거를 확인하세요.')
        clean.append(dict(id=ref['id'],label=f'R{i+1}',heading=heading,headingSource='manual-assumption' if manual else 'target-assumption',distance=math.hypot(ref['x']-target['x'],ref['y']-target['y']),fraction=fraction,counts=counts,blockers=blockers))
    omitted=[b['id'] for b in frame.get('boxes',[]) if b['id'] not in ids];best=max((r['fraction'] for r in clean),default=None)
    quality=frame.get('sceneEvidence',{}).get('qualityWarnings',[])
    complete=len(refs)==3 and not omitted and not quality
    return dict(schema='kbl-crew-visibility/v1',rows=clean,hfov=state['hfov'],vfov=state['vfov'],targetId=state['targetId'],targetHeight=state['targetHeight'],**({'reviewPoint':state['reviewPoint']} if state.get('reviewPoint') else {}),rayCount=9,patchSizeMetres=.3,
        missingReferees=max(0,3-len(refs)),crewComplete=len(refs)==3,sceneComplete=not omitted,omittedTrackIds=omitted,
        leaders=[r['id'] for r in clean if r['fraction']==best],conclusion='unresolved' if not complete else 'conditional-coverage' if best>=.5 else 'conditional-gray',
        measuredGaze=False,targetSamplingVersion=value.get('targetSamplingVersion',1),qualityWarnings=quality,grid={'stepMetres':.75,'method':'one mesh ray per cell at target height','height':state['targetHeight']})

def save(case_id,event_id,payload):
    with LOCK:
        case,event,packet,frame=context(case_id,event_id)
        import uniforms
        palette=uniforms.load('cases',case_id)
        # A tab opened before a server restart may still have unsaved v4 work.
        # Preserve its actual renderer provenance instead of blocking that save.
        if payload.get('rendererVersion') not in READABLE_RENDERER_VERSIONS:raise RuntimeError('공간 편집 화면이 업데이트됐습니다. 새로고침하세요.')
        if payload.get('uniformRevision')!=palette['revision']:raise RuntimeError('유니폼 색상이 변경됐습니다. 새로고침 후 저장하세요.')
        expected={'selectionRevision':case['revision'],'frameIndex':frame['frameIndex'],'datasetId':packet['datasetId'],'inputSha256':packet['inputSha256']}
        if payload.get('courtRevision')!=frame.get('courtRevision'):raise RuntimeError('코트 보정이 변경됐습니다. 화면을 새로고침하세요.')
        if any(payload.get(k)!=v for k,v in expected.items()):raise RuntimeError('원본·모델·기준 프레임이 변경됐습니다. 새로고침하세요.')
        evidence=frame.get('sceneEvidence')
        if payload.get('sceneEvidenceSha256')!=(evidence or {}).get('sha256'):raise RuntimeError('장면 보조 근거가 변경됐습니다. 새로고침하세요.')
        state=payload['state'];roles=scene_roles(frame,state['entities']);ids=set(roles)
        if state['observerId'] not in ids or state['targetId'] not in ids:raise ValueError('현재 프레임의 인물을 선택하세요.')
        if state['headingMode'] not in ('target-assumption','manual-assumption'):raise ValueError('방향의 출처가 필요합니다.')
        clean={'observerId':state['observerId'],'targetId':state['targetId'],'headingMode':state['headingMode'],
               'heading':number(state['heading'],-math.pi,math.pi),'hfov':number(state['hfov'],40,160),
               'vfov':number(state['vfov'],30,120),'targetHeight':number(state['targetHeight'],.1,2.5)}
        clean['viewpointId']=state.get('viewpointId',state['observerId'])
        point=state.get('reviewPoint')
        if point is not None:
            if not isinstance(point,dict) or set(point)!={'x','y','source'} or point['source']!='manual-map':raise ValueError('별표 지점의 좌표와 지정 근거를 확인하세요.')
            clean['reviewPoint']={'x':number(point['x'],-4,32),'y':number(point['y'],-3,19),'source':'manual-map'}
        if clean['viewpointId'] not in ids:raise ValueError('시점 미리보기 인물을 확인하세요.')
        entities=state['entities']
        if len(entities)!=len(ids) or {e['id'] for e in entities}!=ids:raise ValueError('인물 목록이 추적 결과와 다릅니다.')
        if any(e['role']!=roles[e['id']] for e in entities):raise ValueError('역할은 객체 단계에서 확정한 내용과 같아야 합니다.')
        if state['observerId']==state['targetId'] or not any(e['id']==state['observerId'] and e['role']=='referee' for e in entities):raise ValueError('심판과 별도의 판독 대상을 선택하세요.')
        clean['entities']=[]
        for e in entities:
            if e['role'] not in ('player','referee','staff','unknown'):raise ValueError('잘못된 역할입니다.')
            clean['entities'].append({'id':e['id'],'role':e['role'],'x':number(e['x'],-4,32),'y':number(e['y'],-3,19),
                'bodyHeading':number(e['bodyHeading'],-math.pi,math.pi),'bodyDirectionSource':e.get('bodyDirectionSource') if e.get('bodyDirectionSource') in ('manual','pose-estimated','unresolved') else 'assumed','positionSource':e.get('positionSource','bbox-footpoint-proxy'),
                'roleSource':e.get('roleSource','model'),'label':str(e['id'])})
            team=e.get('team','unknown')
            if team not in ('home','away','unknown'):raise ValueError('홈·어웨이·미확정 중에서 선택하세요.')
            clean['entities'][-1].update(team=team if e['role']=='player' else 'unknown',teamSource='manual' if e.get('teamSource')=='manual' else 'uniform-colour')
            if e.get('positionSource')=='manual' and e.get('spatialOverride') is True:clean['entities'][-1]['spatialOverride']=True
            position_evidence=e.get('positionEvidence')
            if e.get('positionSource')=='manual' and position_evidence is not None:
                if not isinstance(position_evidence,dict) or position_evidence.get('method') not in ('operator-map','height-plane-proposal'):raise ValueError('수동 위치의 추정 근거를 확인하세요.')
                safe={'method':position_evidence['method'],'estimated':True}
                if position_evidence['method']=='height-plane-proposal':
                    if position_evidence.get('anchor') not in ('shoulders','hips'):raise ValueError('위치 추정 기준 관절을 확인하세요.')
                    safe.update(anchor=position_evidence['anchor'],assumedHeight=number(position_evidence.get('assumedHeight'),1.3,2.4),
                        heightSensitivityMetres=number(position_evidence.get('heightSensitivityMetres',position_evidence.get('uncertaintyMetres')),0,50))
                    pixel=position_evidence.get('pixel')
                    if pixel is not None:
                        if not isinstance(pixel,list) or len(pixel)!=2:raise ValueError('위치 추정 기준 픽셀을 확인하세요.')
                        safe['pixel']=[number(v,-10000,10000) for v in pixel]
                clean['entities'][-1]['positionEvidence']=safe
            if e.get('viewHeading') is not None:clean['entities'][-1].update(viewHeading=number(e['viewHeading'],-math.pi,math.pi),viewDirectionSource='manual-assumption')
        mesh_path=Path(__file__).resolve().parents[2]/'apps/web/public/kbl-grayzone/assets/humans/mpfb-court-v1.json'
        mesh_hash=hashlib.sha256(mesh_path.read_bytes()).hexdigest()
        if payload.get('meshSha256')!=mesh_hash:raise RuntimeError('인체 모델이 바뀌었습니다. 새로고침하세요.')
        pose=None
        if payload.get('poseJobId'):
            import broadcast_pose
            pose=broadcast_pose.validate_pose(case_id,event_id,payload['poseJobId'],clean['entities'])
            if payload.get('poseVariantId'):
                import pose_variant
                pose,_,_=pose_variant.load(case_id,event_id,payload['poseVariantId'],clean,pose)
        elif payload.get('poseVariantId'):raise ValueError('기본 자세 없이 보정 자세를 저장할 수 없습니다.')
        crew=validate_crew(payload.get('crewAnalysis'),clean,frame)
        blobs={}
        for kind in KINDS:
            value=payload['images'][kind]
            if not value.startswith('data:image/jpeg;base64,'):raise ValueError('JPEG 캡처가 필요합니다.')
            raw=base64.b64decode(value.split(',',1)[1],validate=True)
            if not 1000<len(raw)<5_000_000:raise ValueError('이미지 크기가 범위를 벗어났습니다.')
            with Image.open(io.BytesIO(raw)) as im:
                if im.format!='JPEG' or im.width<400 or im.height<200 or im.width*im.height>12_000_000:raise ValueError('캡처 해상도가 범위를 벗어났습니다.')
                im.verify()
            blobs[kind]=raw
        data={'schema':'kbl-broadcast-reconstruction/v1','rendererVersion':payload['rendererVersion'],'uniformRevision':palette['revision'],'uniforms':palette,'eyeViewpointId':clean['observerId'],'caseId':case_id,'eventId':event_id,**expected,'state':clean,
              'selectionVersion':event.get('selectionVersion'),
              'sceneEvidence':evidence,'sceneEvidenceSha256':(evidence or {}).get('sha256'),
              'crewAnalysis':crew,'eyeViewpointIds':[r['id'] for r in crew['rows']]+[None]*crew['missingReferees'],
              'detectedPeople':len(frame.get('boxes',[])),'renderedPeople':len(entities),
              'objectReview':frame.get('objectReview'),'ballTags':frame.get('ballObjects',[]),
              'footpointCorrections':[{'id':b['id'],'pixels':b['footpointPixels'],'evidence':b.get('footpointEvidence','manual-proxy'),'note':b.get('footpointNote',''),**({'frameEdgeEstimate':True} if b.get('footpointFrameEdge') else {})} for b in frame.get('boxes',[]) if b.get('manuallyReviewed') and b.get('footpointStatus','').startswith('manual-floor')],
              'omittedTrackIds':[b['id'] for b in frame.get('boxes',[]) if b['id'] not in ids],
              'meshSha256':mesh_hash,'poseJobId':pose['jobId'] if pose else None,'poseMeshSha256':pose['meshSha256'] if pose else None,'posedPeople':sum(p['accepted'] for p in pose['people']) if pose else 0,'pose':'single-frame inferred and reviewed corrections, not measured 3D' if pose else 'neutral template, not measured posture','metricCalibrationVerified':False,
              'alignmentVerified':False,'gazeVerified':False,'visibilityStatus':'illustrative, not a measured blind spot',
              'images':{kind:{'sha256':hashlib.sha256(raw).hexdigest()} for kind,raw in blobs.items()}}
        if payload.get('mapLayout')=='apron-v2':data['mapLayout']='apron-v2'
        if payload.get('poseVariantId'):data.update(poseVariantId=payload['poseVariantId'],poseGeometryMode='shared-map-refit-v1')
        if frame.get('courtRevision'):data['courtRevision']=frame['courtRevision']
        digest=hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()[:24];data['captureId']=digest
        root=CASES[case_id]/'reconstructions'/event_id;folder=root/digest;folder.mkdir(parents=True,exist_ok=True)
        for kind,raw in blobs.items():(folder/f'{kind}.jpg').write_bytes(raw)
        (folder/'scene.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
        temp=root/'current.tmp';temp.write_text(json.dumps(data,ensure_ascii=False,indent=2));temp.replace(root/'current.json')
        return data

def image_file(case_id,event_id,kind):
    if kind not in KINDS:raise ValueError('잘못된 이미지입니다.')
    data=current(case_id,event_id,strict=True)
    return CASES[case_id]/'reconstructions'/event_id/data['captureId']/f'{kind}.jpg'
