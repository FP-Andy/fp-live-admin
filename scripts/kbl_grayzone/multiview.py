"""Persisted secondary-camera assistance, before operator object review.

No inference on reads. Broadcast and manual edits remain authoritative. Every
supplement is bound to both sources, the selected frame and the court revision.
"""
import copy,json,shutil,time
from pathlib import Path
import cv2,numpy as np
from job_store import atomic,digest,lease,now
VERSION='broadcast-primary-wide-v3'

def folder(root,event,index):return Path(root)/'multiview'/event/str(index)

def identity(packet,frame):
    return digest({'version':VERSION,'input':packet['inputSha256'],'dataset':packet['datasetId'],
        'frame':frame['frameIndex'],**({'widePairRevision':packet['widePairRevision']} if packet.get('widePairRevision') else {}),'court':frame.get('court'),'courtRevision':frame.get('courtRevision')})

def apply(root,event,packet,index):
    f=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    path=folder(root,event,index)/'current.json'
    if not f or not path.is_file():return packet
    data=json.loads(path.read_text())
    if data.get('identity')!=identity(packet,f):return packet
    packet['wideAssistance']={k:data.get(k) for k in ('state','message','seconds','addedPeople','filledPositions','matchedPeople','revision')}
    if data.get('state')!='ready':return packet
    existing={b['id']:b for b in f['boxes']};positions={p['id']:p for p in f.get('floorPositions',[])}
    for item in data['supplements']:
        p=item['person'];pid=item['id']
        if item['newObject']:
            b=p['pixelBox'];existing[pid]={'id':pid,'box':(np.array(b)/[1920,1080,1920,1080]).tolist(),
                'roleHint':item['role'],'roleConfidence':p['roleConfidence'],'confidence':p['roleConfidence'],
                'roleSource':'wide-trained-role-head','source':'wide-supplement','imageSource':'wide',
                'footpointPixels':[(b[0]+b[2])/2,b[3]],'footpointStatus':'wide-bbox-footpoint-proxy',
                'sourceImageUrl':data['imageUrl'],'sourceCamera':data['camera'],
                'sourceImageToCourt':data['imageToCourt'],'sourceSha256':data['wideSource']['sourceSha256']}
        if pid not in existing:continue
        existing[pid]['widePose']={**copy.deepcopy(p),'id':pid,'x':item['xy'][0],'y':item['xy'][1],
            'cameraOverride':data['camera'],'imageUrl':data['imageUrl'],'supplementRevision':data['revision']}
        if item['fillPosition'] and pid not in positions:
            positions[pid]={'id':pid,'role':item['role'],'xy':item['xy'],'source':'wide-supplement',
                'status':'wide-layout-aligned-proxy','approvedForOcclusion':False}
            existing[pid]['widePosition']=copy.deepcopy(positions[pid])
    f['boxes']=list(existing.values());f['floorPositions']=list(positions.values())
    packet['datasetId']+='-wide-'+data['revision'];f['wideAssistance']=packet['wideAssistance']
    return packet

def prepare(case_id,event_id,index,stage=lambda s:None):
    import case_store,wide_preparation,wide_clock,gpu_bridge
    from broadcast_pose import camera_inputs,pose_people
    from multiview_geometry import assignments,transform_camera
    case=case_store.load_case(case_id);policy=case.get('wideAssistance',{})
    import wide_pairing
    event=next((e for e in case.get('events',[]) if e['id']==event_id),{});pair=wide_pairing.active(event)
    if event.get('broadcastSelection',{}).get('wideChoice')=='skip':return {'state':'skipped'}
    if not policy.get('enabled'):
        return {'state':'manual-only','message':'수동 선택한 한 프레임을 참고합니다. 광각 자동 대조는 실행하지 않습니다.'} if pair else {'state':'disabled'}
    root=case_store.CASES[case_id];mid=case.get('fpcMatchId')
    if not mid and not pair:return {'state':'unlinked','message':'FPC 광각 경기 미연결'}
    packet=case_store.broadcast_packet(case_id,event_id,include_objects=False,include_multiview=False)
    f=next(f for f in packet['frames'] if f['frameIndex']==index);key=identity(packet,f);dest=folder(root,event_id,index)
    started=time.monotonic();path=dest/'current.json'
    if path.exists():
        old=json.loads(path.read_text())
        if old.get('identity')==key and old.get('state')=='ready':return old
    # Once a reviewer has edited objects, never quietly replace that scene.
    def save(state,message,**extra):
        data={'state':state,'message':message,'identity':key,'updatedAt':now(),'seconds':round(time.monotonic()-started,2),**extra}
        atomic(path,data);return data
    if (root/'broadcast-objects'/event_id/str(index)/'current.json').exists():return save('review-started','저장한 객체 검수 유지 · 선택한 광각은 참고 화면으로 반영')
    with lease(dest/'process.lock') as acquired:
        if not acquired:return {'state':'running','message':'광각 보완 진행 중'}
        if not f.get('court',{}).get('imageToCourt'):return save('needs-review','중계 코트 좌표 확인 후 광각 정합 가능')
        if pair:
            stage('직접 맞춘 광각 프레임 · 선수 배치 대조 준비')
            found={'state':'candidates','method':'operator-frame-pair','candidates':[{**pair,
                'globalSeconds':pair.get('startSeconds',0)+pair['frameIndex']/pair['fps'],
                'clockAlignment':{'uncertaintySeconds':0}}]}
        else:
            prepared=wide_preparation.read(mid)
            if prepared.get('state') not in ('prepared','running'):
                wide_preparation.discover(mid);return save('source-pending','광각 원본 자동 준비 중 · 중계 결과 유지')
            source=root/'broadcast'/event['broadcast']['file'];image,_,_=wide_clock.extract(source,index/packet['fps'])
            stage('광각 시계 후보·선수 배치 정합 준비')
            found=wide_clock.locate(mid,image,stage,source_path=source,frame_index=index)
        if found['state']!='candidates':return save(found['state'],'광각 정합 확인 필요 · 중계 결과 유지',alignment=found)
        _,primary_camera=camera_inputs(f,pose_people(packet,f))
        matches=[]
        for n,candidate in enumerate(found['candidates']):
            stage(f'광각 객체·관절 대조 · 후보 {n+1}/{len(found["candidates"])}')
            if pair:
                import review_intake
                intake=review_intake.load(case['intakeId']);meta=wide_pairing.info(intake,event_id,pair['sourceId'])
                if meta['sourceSha256']!=pair['sourceSha256']:raise RuntimeError('선택한 광각 원본이 변경됐습니다.')
                src=Path(wide_pairing.source(intake,event_id,pair['sourceId'])['path'])
            else:src=wide_preparation.media_file(mid,candidate['sessionId'],candidate['part'])
            job=dest/'jobs'/digest([key,candidate,VERSION])[:20]
            gpu_bridge.execute('wide-assist',{'frameIndex':candidate['frameIndex'],
                'primaryPositions':f['floorPositions'],'pipelineVersion':VERSION,'temporalToleranceSeconds':candidate['clockAlignment']['uncertaintySeconds']},src,job,stage)
            result=json.loads((job/'wide-result.json').read_text())
            if result['state']=='matched':matches.append((result['match']['score'],candidate,result,job))
        if not matches:return save('needs-review','광각 선수 배치 대응 부족 · 중계 결과 유지',alignment=found)
        matches.sort(key=lambda v:v[0]);_,candidate,result,job=matches[0]
        if len(matches)>1 and matches[1][0]-matches[0][0]<.20 and abs(matches[1][1]['globalSeconds']-candidate['globalSeconds'])>1:
            return save('needs-review','같은 시계의 여러 장면이 겹쳐 광각 보완 보류',alignment=found)
        T=np.array(result['match']['transform']);camera=transform_camera(result['camera'],T)
        supplements=assignments(f,result,result['match'],primary_camera)
        revision=digest([key,candidate,result,supplements])[:16]
        img=dest/(revision+'.jpg');shutil.copyfile(job/'wide-frame.jpg',img)
        data=save('ready',f'광각 보완 · 누락 인물 {sum(s["newObject"] for s in supplements)}명 · 위치 {sum(s["fillPosition"] for s in supplements)}명',
            revision=revision,wideSource={**candidate,'frameIndex':result['frameIndex'],'sourceSha256':result['inputSha256']},
            match=result['match'],camera=camera,imageToCourt=(T@np.array(result['court']['imageToCourt'])).tolist(),
            supplements=supplements,addedPeople=sum(s['newObject'] for s in supplements),
            filledPositions=sum(s['fillPosition'] for s in supplements),matchedPeople=sum(not s['newObject'] for s in supplements),
            imageUrl=f'/case-wide-assist/{case_id}/{event_id}/{index}/{revision}.jpg',
            sourceImage=str(img.relative_to(root)),frameAccurateSyncVerified=False,operatorConfirmedInstant=bool(pair),temporalMethod='operator-selected frame pair + five-player layout fit' if pair else 'numeric game/shot clock transitions + five-player layout fit')
        atomic(dest/(revision+'.json'),data);stage(data['message']);return data

def failure(case_id,event_id,index):
    """Persist a recoverable secondary error without leaking network/credential text."""
    import case_store
    packet=case_store.broadcast_packet(case_id,event_id,include_objects=False,include_multiview=False)
    frame=next(f for f in packet['frames'] if f['frameIndex']==index)
    atomic(folder(case_store.CASES[case_id],event_id,index)/'current.json',
        {'identity':identity(packet,frame),'state':'failed','message':'광각 자동 보완 중단 · 중계 결과 유지 · 재처리로 이어받기 가능','updatedAt':now()})

def image_file(case_id,event,index,revision):
    import case_store
    # The route restricts every segment. Only immutable, referenced artifacts.
    root=case_store.CASES[case_id];record=folder(root,event,index)/(revision+'.json')
    data=json.loads(record.read_text())
    if data.get('revision')!=revision:raise ValueError('광각 이미지 개정 불일치')
    return folder(root,event,index)/(revision+'.jpg')


def attempted(case_id,event_id,index):
    """A terminal geometry review is not a reason to rerun the whole intake."""
    import case_store
    packet=case_store.broadcast_packet(case_id,event_id,include_objects=False,include_multiview=False)
    frame=next((f for f in packet['frames'] if f['frameIndex']==index),None)
    path=folder(case_store.CASES[case_id],event_id,index)/'current.json'
    if not frame or not path.exists():return False
    saved=json.loads(path.read_text())
    return saved.get('identity')==identity(packet,frame) and saved.get('state') in ('ready','needs-review','review-started')
