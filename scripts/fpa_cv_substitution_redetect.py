#!/usr/bin/env python3
"""Re-detect bounded substitution windows with YOLO26s or optional RF-DETR.

Outputs a separate, revision-bound sidecar. Original tracks and reviews are
never written. --source-offset supports an explicitly timed source clip.
"""
import argparse
import hashlib
from contextlib import nullcontext
import json
import math
import os
from pathlib import Path
import time
import uuid
from fpa_cv_detection_merge import remove_crop_fragments


def crop_tiles(roi, scope='touchline'):
    """Two overlapping high-detail views of the lower touchline, in camera space."""
    if len(roi)!=4 or any(len(p)!=2 or any(not math.isfinite(n) or not 0<=n<=1 for n in p) for p in roi):
        raise ValueError('Four normalized court corners are required')
    bottom=sorted(roi,key=lambda p:p[1])[-2:]
    left=max(0,min(p[0] for p in roi)-.08);right=min(1,max(p[0] for p in roi)+.08)
    top=max(0,min(p[1] for p in (roi if scope=='court' else bottom))-(.05 if scope=='court' else .40));end=min(1,max(p[1] for p in bottom)+.16)
    width=right-left
    return [[left,top,left+width*.62,end],[left+width*.38,top,right,end]]


def nms(rows, threshold=.5):
    def iou(a,b):
        intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
        return intersection/max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection)
    kept=[]
    for row in sorted(rows,key=lambda x:x[4],reverse=True):
        if all(iou(row,old)<threshold for old in kept):kept.append(row)
    return kept


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',type=Path,required=True);parser.add_argument('--video',required=True)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--model',required=True)
    parser.add_argument('--device',default='auto');parser.add_argument('--source-offset',type=float,default=0)
    parser.add_argument('--window-ids',nargs='*',type=int);parser.add_argument('--sample-fps',type=float,default=15)
    parser.add_argument('--s3-key')
    parser.add_argument('--half',action='store_true',help='CUDA half precision; recorded in provenance')
    parser.add_argument('--tile-batch',action='store_true',help='Predict both overlapping crops together')
    parser.add_argument('--detector',choices=['yolo','rfdetr'],default='yolo')
    parser.add_argument('--scope',choices=['touchline','court'],default='touchline')
    parser.add_argument('--stop-file',type=Path,help='Stop after a frame if this file appears')
    args=parser.parse_args()
    if args.output.exists():parser.error('Preserve prior results; choose a new output file')
    if not math.isfinite(args.source_offset) or args.source_offset<0 or not 1<=args.sample_fps<=30:parser.error('Invalid time or sampling')
    plan=json.loads(args.plan.read_text());windows=[w for w in plan['windows'] if args.window_ids is None or w['id'] in args.window_ids]
    if plan.get('schema')!='fpa-substitution-redetection/v1' or not windows:parser.error('No eligible windows')
    if args.detector=='yolo' and plan.get('model') and Path(args.model).name!=plan['model']:parser.error('Use the same YOLO detector as the original analysis')
    if not Path(args.model).is_file():parser.error('An existing local model checkpoint is required; no automatic model download')
    for w in windows:
        if not 0<w['to']-w['from']<=80.01 or w['from']<args.source_offset:parser.error('Invalid bounded window')
    os.environ.setdefault('YOLO_AUTOINSTALL','false')
    import cv2,numpy as np,torch
    from ultralytics import YOLO
    from ultralytics.engine.results import Boxes
    from ultralytics.utils import YAML
    from ultralytics.utils.checks import check_yaml
    from types import SimpleNamespace
    from fpa_cv_bytetrack import ColorBYTETracker
    from fpa_cv_colors import appearance
    from fpa_cv_uniforms import classify_uniform,uniform_team
    cv2.setNumThreads(1);torch.set_num_threads(2)
    device=args.device if args.device!='auto' else '0' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    if args.half and device in ('cpu','mps'):parser.error('--half requires CUDA')
    if args.detector=='rfdetr':
        try:
            from rfdetr import RFDETRMedium
            from rfdetr.util.coco_classes import COCO_CLASSES
            from PIL import Image
        except ImportError as exc:
            parser.error(f'RF-DETR is optional; use the isolated experiment environment: {exc}')
        rf_device='cuda' if device.isdigit() or device.startswith('cuda:') else device
        if rf_device=='cuda':torch.cuda.set_device(int(device.split(':')[-1]) if device!='cuda' else 0)
        model=RFDETRMedium(device=rf_device,resolution=1024,pretrain_weights=args.model)
        model.optimize_for_inference(compile=False,dtype=torch.float16 if args.half else torch.float32)
        labels=COCO_CLASSES.items() if isinstance(COCO_CLASSES,dict) else enumerate(COCO_CLASSES)
        person=next(k for k,v in labels if v=='person')
    else:model=YOLO(args.model)
    tiles=crop_tiles(plan['roi'],args.scope);reader=nullcontext(None)
    if args.s3_key:
        from fpa_cv_remote_video import S3VideoReader
        from fpa_cv_storage import storage
        reader=S3VideoReader(storage(),args.s3_key)
    output={**plan,'id':uuid.uuid4().hex,'windows':[],'detector':{'model':Path(args.model).name,'modelSha256':hashlib.sha256(Path(args.model).read_bytes()).hexdigest(),'device':device,'imgsz':1280,'confidence':.1,'tiles':tiles,'sampleFps':args.sample_fps,'sourceOffset':args.source_offset,'method':'touchline-overlapping-crops/v1'}}
    output['detector'].update(half=args.half,tileBatch=args.tile_batch if args.detector=='yolo' else False,engine=args.detector,scope=args.scope,imgsz=1024 if args.detector=='rfdetr' else 1280,method='bounded-crops-fragment-filter/v2')
    removed_fragments=0
    start=time.monotonic()
    with reader as remote:
        cap=cv2.VideoCapture(remote.url if remote else args.video)
        fps=cap.get(cv2.CAP_PROP_FPS);count=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not cap.isOpened() or fps<=0:raise ValueError('Cannot open source video')
        try:
            for w in windows:
                first=round((w['from']-args.source_offset)*fps);last=math.ceil((w['to']-args.source_offset)*fps-1e-7)
                if first<0 or last>count+1:raise ValueError('Source clip does not cover the requested window')
                stride=max(1,round(fps/args.sample_fps));cap.set(cv2.CAP_PROP_POS_FRAMES,first)
                tracker=ColorBYTETracker(SimpleNamespace(**YAML.load(check_yaml('bytetrack.yaml'))),observation_fps=fps/stride)
                result={**w,'frames':[]}
                for index in range(first,min(last,count)):
                    if args.stop_file and args.stop_file.exists():raise InterruptedError('Stopped; completed source and existing results are unchanged')
                    ok,frame=cap.read()
                    if not ok:raise ValueError('Decode failed; incomplete result not saved')
                    if (index-first)%stride:continue
                    height,width=frame.shape[:2];rows=[]
                    bounds=[[round(n*(width if i%2==0 else height)) for i,n in enumerate(tile)] for tile in tiles]
                    if args.tile_batch and args.detector=='yolo':
                        # Rounding normalized crops can differ by one pixel.
                        # Equal shapes let YOLO use rectangular padding instead
                        # of padding both touchline crops to 1280 x 1280.
                        crop_width=min(z-x for x,y,z,v in bounds)
                        bounds=[[x,y,x+crop_width,v] for x,y,z,v in bounds]
                    crops=[frame[y:v,x:z] for x,y,z,v in bounds]
                    options=dict(classes=[0],imgsz=1280,conf=.1,device=device,half=args.half,verbose=False)
                    if args.detector=='rfdetr':
                        for (x,y,z,v),crop in zip(bounds,crops):
                            detection=model.predict(Image.fromarray(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB)),threshold=.1)
                            for box,score,cls in zip(detection.xyxy.tolist(),detection.confidence.tolist(),detection.class_id.tolist()):
                                if cls==person:rows.append([box[0]+x,box[1]+y,box[2]+x,box[3]+y,score,0])
                    else:
                        predictions=model.predict(crops,**options) if args.tile_batch else [model.predict(c,**options)[0] for c in crops]
                        for (x,y,z,v),detection in zip(bounds,predictions):
                            for box,score in zip(detection.boxes.xyxy.cpu().tolist(),detection.boxes.conf.cpu().tolist()):
                                rows.append([box[0]+x,box[1]+y,box[2]+x,box[3]+y,score,0])
                    teams=[uniform_team(classify_uniform(appearance(frame,[v/(width if i%2==0 else height) for i,v in enumerate(row[:4])]),plan['uniforms'])) for row in rows]
                    count_before=len(rows);rows=remove_crop_fragments(rows,bounds,teams);removed_fragments+=count_before-len(rows)
                    rows=nms(rows);detections=Boxes(np.asarray(rows,dtype=np.float32).reshape(-1,6),(height,width)).cpu().numpy()
                    colors=[classify_uniform(appearance(frame,b),plan['uniforms']) for b in detections.xyxyn]
                    tracked=tracker.update(detections,teams=[uniform_team(c) for c in colors]);boxes=[]
                    for row in tracked:
                        box=[round(max(0,min(1,float(n))),6) for n in row[:4]/np.array([width,height,width,height])]
                        boxes.append({'id':1000000000+w['id']*1000000+int(row[4]),'box':box,'confidence':round(float(row[5]),4),'appearance':appearance(frame,box),'zone':'redetection'})
                    t=round(args.source_offset+index/fps,6)
                    if w['from']-1e-6<=t<w['to']+1e-6:result['frames'].append({'t':t,'boxes':boxes})
                    if len(result['frames'])%30==0:print(json.dumps({'window':w['id'],'sourceTime':t,'samples':len(result['frames']),'elapsed':round(time.monotonic()-start,1)}),flush=True)
                output['windows'].append(result)
        finally:cap.release()
    output['elapsedSeconds']=time.monotonic()-start
    output['detector']['removedCropFragments']=removed_fragments
    args.output.parent.mkdir(parents=True,exist_ok=True);temp=args.output.with_suffix('.tmp');temp.write_text(json.dumps(output,separators=(',',':')));temp.replace(args.output)
    print(json.dumps({'done':True,'windows':len(windows),'elapsed':output['elapsedSeconds']}),flush=True)


if __name__=='__main__':main()
