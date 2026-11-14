"""Freeze approved case frames and retain the provenance of interpolated boxes."""
import argparse
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import cv2
from basketball_detector import deinterlace
from case_store import CASES, load_case


def sample_boxes(frames,t,max_gap=.25):
    before=[f for f in frames if f['t']<=t+1e-7]
    if not before:return []
    a=before[-1]
    if abs(t-a['t'])<1e-6:return [dict(b,boxSource='detected') for b in a['boxes']]
    following=next((f for f in frames if f['t']>t),None)
    if following is None or following['t']-a['t']>max_gap:return []
    next_boxes={b['id']:b for b in following['boxes']};u=(t-a['t'])/(following['t']-a['t']);out=[]
    for b in a['boxes']:
        r=next_boxes.get(b['id'])
        if r is None:continue
        role=b['roleHint'] if b['roleHint']==r['roleHint'] else 'unknown'
        out.append(dict(b,box=[x+(y-x)*u for x,y in zip(b['box'],r['box'],strict=True)],
                        roleHint=role,confidence=min(b['confidence'],r['confidence']),
                        boxSource='interpolated',boxEvidenceTimes=[a['t'],following['t']]))
    return out


def extract_frame(path,frame):
    cap=cv2.VideoCapture(str(path));cap.set(cv2.CAP_PROP_POS_FRAMES,frame);ok,image=cap.read();cap.release()
    if not ok:raise ValueError('Selected frame cannot be decoded')
    return image


def prepare(case_id,results,output,clips=None,progress=None):
    data=load_case(case_id);rows=[];output.mkdir(parents=True,exist_ok=True)
    for event in data['events']:
        if progress:progress('판독 기준 프레임 추출',len(rows),len(data['events']),'장면')
        if not event.get('wide'):
            from case_store import broadcast_packet,broadcast_index
            import broadcast_pose
            packet=broadcast_packet(case_id,event['id']);selected=broadcast_index(event,packet['fps'])
            frame=next(f for f in packet['frames'] if f['frameIndex']==selected)
            source=CASES[case_id]/'broadcast'/event['broadcast']['file']
            with source.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=packet['inputSha256']:raise ValueError('중계 원본이 변경됐습니다.')
            key=f'{case_id}-{event["id"]}-broadcast';name=key+'.png'
            cv2.imwrite(str(output/name),extract_frame(source,selected))
            people=[dict(b,id=b['id'],role=b['roleHint'],pixelBox=[v*s for v,s in zip(b['box'],[packet['width'],packet['height']]*2)]) for b in frame['boxes']]
            current=broadcast_pose.current(case_id,event['id'])
            rows.append(dict(clipId=key,eventId=event['id'],game=data['title'],timestamp=selected/packet['fps'],frameIndex=selected,
                fps=packet['fps'],people=people,image=name,imageSha256=hashlib.sha256((output/name).read_bytes()).hexdigest(),
                inputSha256=packet['inputSha256'],datasetId=packet['datasetId'],coordinateSpace='image',ball=frame.get('ball'),
                pose=current['job']['result'] if current and current['job']['state']=='complete' else None,
                runtime={'totalSeconds':packet['summary']['wallSeconds']+packet.get('roleProcessing',{}).get('wallSeconds',0)+packet.get('courtSummary',{}).get('wallSeconds',0)},
                sourceMode='broadcast-only',selectionStatus=event['selectionStatus'],calibrationStatus='provisional'))
            continue
        if clips and event['wide']['id'] not in clips:continue
        if event['selectedFrame'] is None:raise ValueError('Every incident needs an approved frame')
        wide=event['wide'];key=wide['id'];root=results/'tracks'/key
        runtime=json.loads((root/'runtime.json').read_text())
        if runtime['inputSha256']!=wide['sha256']:raise ValueError('Tracking belongs to another source')
        source=CASES[case_id]/'wide'/Path(wide['file']).name
        with source.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=wide['sha256']:raise ValueError('Source media changed')
        tracks=json.loads((root/'people.json').read_text());ball=json.loads((root/'ball.json').read_text())
        selected=event['selectedFrame'];timestamp=selected/wide['fps']
        boxes=sample_boxes(tracks['frames'],timestamp)
        people=[]
        for b in boxes:
            box=[v*(1920 if i%2==0 else 1080) for i,v in enumerate(b['box'])]
            role=b['roleHint'];people.append(dict(b,id='T'+str(b['id']),role=role,pixelBox=box,
                poseEligible=role=='player' or role.startswith('ref'),groundContactVerified=False))
        image=deinterlace(extract_frame(source,selected));name=key+'.png';cv2.imwrite(str(output/name),image)
        ball_near=min(ball.get('samples',[]),key=lambda s:abs(s['t']-timestamp),default=None)
        if not ball_near or ball_near.get('missing') or abs(ball_near['t']-timestamp)>.51/wide['fps']:ball_near=None
        row=dict(clipId=key,eventId=event['id'],game=data['title'],timestamp=timestamp,frameIndex=selected,
                 fps=wide['fps'],people=people,image=name,imageSha256=hashlib.sha256((output/name).read_bytes()).hexdigest(),
                 inputSha256=wide['sha256'],coordinateSpace='image',anchors=None,ball=ball_near,
                 trackingSha256=hashlib.sha256((root/'people.json').read_bytes()).hexdigest(),
                 datasetId=event.get('trackingStatus',{}).get('datasetId'),
                 roleCounts=dict(Counter(p['role'] for p in people)),runtime=runtime,
                 selectionStatus=event['selectionStatus'],calibrationStatus='not-calibrated')
        rows.append(row)
    if progress:progress('판독 기준 프레임 추출',len(rows),len(data['events']),'장면')
    (output/'inputs.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    return rows


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--case',required=True);p.add_argument('--results',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--clips',nargs='+');a=p.parse_args()
    rows=prepare(a.case,a.results,a.output,a.clips)
    print(json.dumps([{'clip':r['clipId'],'frame':r['frameIndex'],'people':len(r['people']),'posePeople':sum(p['poseEligible'] for p in r['people'])} for r in rows],ensure_ascii=False))
