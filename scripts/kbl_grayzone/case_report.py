"""KBL-branded review packet from approved frames; never certifies a verdict."""
import argparse
import hashlib
import json
import math
import threading
import time
import uuid
from pathlib import Path
import cv2
import numpy as np
import supervision as sv
from case_store import CASES,load_case
ROLES=['player','referee','staff','unknown'];SHORT=['P','R','S','U']
COLORS=['#00b5d5','#ff8d34','#c178ef','#ffffff']
REPORTS=Path(__file__).resolve().parents[2]/'output/pdf'
LOCK=threading.Lock()


def annotated(image,row,pose=None,display_labels=None):
    people=row['people'];roles=[ROLES.index(p['role']) if p['role'] in ROLES else 3 for p in people]
    det=sv.Detections(xyxy=np.asarray([p['pixelBox'] for p in people],dtype=np.float32).reshape(-1,4),
                      class_id=np.asarray(roles,dtype=int),confidence=np.asarray([p['confidence'] for p in people]))
    palette=sv.ColorPalette.from_hex(COLORS)
    out=sv.BoxAnnotator(color=palette,thickness=3).annotate(scene=image.copy(),detections=det)
    labels=[(display_labels or {}).get(p['id'],f"{SHORT[role]} {p['id']}") for p,role in zip(people,roles,strict=True)]
    out=sv.LabelAnnotator(color=palette,text_scale=.55,text_thickness=1,text_padding=3,
                          text_color=sv.Color.BLACK).annotate(scene=out,detections=det,labels=labels)
    ball=row.get('ball')
    point=ball.get('point') if isinstance(ball,dict) else None
    box=ball.get('pixelBox') or ball.get('box') if isinstance(ball,dict) else None
    def valid(values,count):
        return isinstance(values,(list,tuple)) and len(values)==count and all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in values)
    if not valid(point,2) and valid(box,4):point=[(box[0]+box[2])/2,(box[1]+box[3])/2]
    if valid(point,2):
        x,y=point;d=sv.Detections(xyxy=np.asarray([[x-11,y-11,x+11,y+11]],dtype=np.float32),class_id=np.asarray([0],dtype=int))
        out=sv.CircleAnnotator(color=sv.Color.from_hex('#ffe42b'),thickness=3).annotate(scene=out,detections=d)
    if pose and pose['people']:
        xy=np.asarray([p['keypoints'] for p in pose['people']],dtype=np.float32)
        visible=np.asarray([p['scores'] for p in pose['people']])>=.3
        points=sv.KeyPoints(xy=xy,visible=visible)
        edges=[(a+1,b+1) for a,b in [(5,6),(5,7),(7,9),(6,8),(8,10),(5,11),(6,12),(11,12),(11,13),(13,15),(12,14),(14,16)]]
        color=sv.Color.from_hex('#75ff85')
        out=sv.EdgeAnnotator(color=color,thickness=2,edges=edges).annotate(out,points)
        out=sv.VertexAnnotator(color=color,radius=3).annotate(out,points)
    return out


def create(case_id,inputs,output,notes_path=None,pose_path=None,progress=None):
    import broadcast_reconstruction as reconstruction
    case=load_case(case_id);root=CASES[case_id];rows=json.loads((inputs/'inputs.json').read_text())
    spatial={e['id']:reconstruction.current(case_id,e['id'],strict=True) for e in case['events']}
    lookup={r['eventId']:r for r in rows}
    notes=json.loads(notes_path.read_text()) if notes_path and notes_path.exists() else {}
    poses={f['clipId']:f for f in json.loads(pose_path.read_text())['frames']} if pose_path and pose_path.exists() else {}
    for e in case['events']:
        row=lookup[e['id']]
        source=e.get('wide') or e['broadcast'];selected=e['selectedFrame'] if e.get('wide') else e['selectedBroadcastFrame']
        if selected!=row['frameIndex'] or source['sha256']!=row['inputSha256']:
            raise ValueError('Approved frame or media changed; rebuild evidence first')
        from case_store import broadcast_packet
        dataset=e.get('trackingStatus',{}).get('datasetId') if e.get('wide') else broadcast_packet(case_id,e['id'])['datasetId']
        if row.get('datasetId')!=dataset:
            raise ValueError('Tracking dataset changed; rebuild evidence first')
        if hashlib.sha256((inputs/row['image']).read_bytes()).hexdigest()!=row['imageSha256']:
            raise ValueError('Selected-frame image changed')
        pose=poses.get(row['clipId'])
        if pose and any(pose.get(k)!=row.get(k) for k in ('frameIndex','datasetId','inputSha256','imageSha256')):
            poses.pop(row['clipId'])

    from case_report_layout import create_packet
    return create_packet(case_id, case, root, rows, spatial, notes, poses, inputs, output,progress=progress)


def generate_case_report(case_id,revision,progress=None):
    from case_evidence import prepare
    import storage_policy
    if storage_policy.free_bytes(REPORTS)<2*1024**3+128*1024**2:raise RuntimeError('리포트를 생성할 여유 공간이 부족합니다.')
    if not LOCK.acquire(blocking=False):raise RuntimeError('다른 검수 PDF를 생성 중입니다.')
    started=time.perf_counter()
    try:
        case=load_case(case_id)
        if type(revision) is not int or revision!=case['revision']:raise RuntimeError('프레임 선택이 갱신됐습니다. 새로고침 후 다시 생성하세요.')
        if any((e['selectedFrame'] is None or not e.get('trackingReady')) if e.get('wide') else (e.get('selectedBroadcastFrame') is None or not e.get('broadcastTrackingReady')) for e in case['events']):raise ValueError('모든 기준 프레임과 추적 결과가 준비된 뒤 생성할 수 있습니다.')
        import report_versions
        report_versions.preserve_existing(case_id)
        root=CASES[case_id];inputs=root/'selected-frames';prepare(case_id,root/'results',inputs,progress=progress)
        build=report_versions.folder(case_id)/'build';build.mkdir(parents=True,exist_ok=True)
        temp=build/(uuid.uuid4().hex+'.pdf')
        metadata=create(case_id,inputs,temp,root/'review-notes.json',root/'pose/predictions.json',progress=progress)
        editorial=root/'report-editorial.json'
        if metadata.get('editorialSha256')!=(hashlib.sha256(editorial.read_bytes()).hexdigest() if editorial.exists() else None):
            temp.unlink(missing_ok=True);temp.with_suffix('.json').unlink(missing_ok=True)
            raise RuntimeError('생성 도중 판독 코멘트가 변경됐습니다. 다시 생성하세요.')
        from wide_reference import version as wide_version
        if metadata.get('wideReferenceSha256')!=wide_version(root):
            temp.unlink(missing_ok=True);temp.with_suffix('.json').unlink(missing_ok=True)
            raise RuntimeError('생성 도중 광각 참고 화면이 변경됐습니다. 다시 생성하세요.')
        fresh=load_case(case_id)
        if fresh['revision']!=revision or fresh.get('recordsVersion')!=case.get('recordsVersion') or [e.get('trackingStatus') for e in fresh['events']]!=[e.get('trackingStatus') for e in case['events']]:
            temp.unlink(missing_ok=True);temp.with_suffix('.json').unlink(missing_ok=True)
            raise RuntimeError('생성 도중 프레임 또는 추적 결과가 바뀌었습니다. 다시 생성하세요.')
        import broadcast_reconstruction
        for i,(event_id,snapshot) in enumerate(metadata['broadcastReconstructions'].items()):
            if progress:progress('생성 결과와 현재 자료 대조',i,len(case['events']),'장면')
            if broadcast_reconstruction.current(case_id,event_id,strict=True)['captureId']!=snapshot['captureId']:
                temp.unlink(missing_ok=True);temp.with_suffix('.json').unlink(missing_ok=True)
                raise RuntimeError('생성 도중 공간 장면이 변경됐습니다. 다시 생성하세요.')
        metadata['selectionRevision']=revision
        metadata['recordsVersion']=case.get('recordsVersion')
        from job_store import digest
        metadata['reportInputSignature']=digest({'records':case.get('recordsVersion'),'referees':case.get('referees'),'editorial':metadata.get('editorialSha256'),'wideReference':metadata.get('wideReferenceSha256'),
            'captures':{k:v['captureId'] for k,v in metadata['broadcastReconstructions'].items()},
            'moments':{e['id']:e.get('broadcastSelection',{}).get('analysisMoment') for e in case['events']},'layout':metadata['layoutVersion']})
        metadata['reportGenerationSeconds']=round(time.perf_counter()-started,3)
        from datetime import datetime,timezone
        completed=datetime.now(timezone.utc);metadata['generatedAt']=completed.isoformat()
        upload_time=case.get('uploadCompletedAt')
        metadata['deliveryTiming']={'start':'upload-completed','uploadCompletedAt':upload_time,'targetMinutes':90,'elapsedSeconds':None,'withinTarget':None}
        if upload_time:
            elapsed=(completed-datetime.fromisoformat(upload_time)).total_seconds()
            metadata['deliveryTiming'].update(elapsedSeconds=round(elapsed,3),withinTarget=0<=elapsed<=5400)
        temp.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
        if progress:progress('PDF 개정 보관',0,1,'파일')
        result=report_versions.store(case_id,temp,metadata)
        temp.with_suffix('.json').unlink(missing_ok=True);temp.unlink(missing_ok=True)
        import report_delivery
        result['delivery']=report_delivery.result(case_id,result['reportId'])
        return result
    finally:LOCK.release()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--case',required=True);p.add_argument('--inputs',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--notes',type=Path);p.add_argument('--pose',type=Path);a=p.parse_args()
    create(a.case,a.inputs,a.output,a.notes,a.pose)
