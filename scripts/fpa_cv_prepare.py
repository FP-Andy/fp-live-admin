#!/usr/bin/env python3
"""Detect a single original video frame for operator calibration."""
import argparse
import json
import math
from pathlib import Path
from contextlib import nullcontext


def read_frame(source,time,remote=False):
    import cv2
    cap=cv2.VideoCapture(source,cv2.CAP_FFMPEG,[cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,20000,cv2.CAP_PROP_READ_TIMEOUT_MSEC,20000]) if remote else cv2.VideoCapture(source)
    try:
        fps=cap.get(cv2.CAP_PROP_FPS);count=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not cap.isOpened() or fps<=0 or count<=0 or time>=count/fps:raise ValueError('초기 장면 시각을 영상 안에서 선택하세요.')
        index=min(count-1,round(time*fps))
        cap.set(cv2.CAP_PROP_POS_FRAMES,index)
        ok,frame=cap.read()
        if not ok:raise ValueError('초기 장면을 읽지 못했습니다.')
        return frame,fps,count,index
    finally:cap.release()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--model',required=True)
    parser.add_argument('--device',required=True)
    parser.add_argument('--time',type=float,required=True)
    parser.add_argument('--s3-key',help='Read only the selected frame range from private S3')
    args=parser.parse_args()
    if not math.isfinite(args.time) or args.time<0:parser.error('Invalid frame time')
    print('FPA_PROGRESS '+json.dumps({'stage':'초기 장면 검출 중','progress':10}),flush=True)
    import cv2
    import torch
    cv2.setNumThreads(1)
    torch.set_num_threads(1)
    from ultralytics import YOLO
    from fpa_cv_colors import appearance
    reader=nullcontext(None)
    if args.s3_key:
        from fpa_cv_remote_video import S3VideoReader
        from fpa_cv_storage import storage
        reader=S3VideoReader(storage(),args.s3_key)
    with reader as remote:
        frame,fps,count,index=read_frame(remote.url if remote else str(args.video),args.time,bool(remote))
    if remote:print('S3_FRAME_READ '+json.dumps({'bytes':remote.bytes_read,'sourceBytes':remote.size,'requests':remote.requests}),flush=True)
    model=YOLO(args.model)
    result=model.predict(frame,classes=[0],imgsz=1280,conf=.1,device=args.device,verbose=False)[0]
    boxes=[]
    for xyxy,confidence in zip(result.boxes.xyxyn.cpu().tolist(),result.boxes.conf.cpu().tolist()):
        box=[round(max(0,min(1,n)),6) for n in xyxy]
        if box[0]>=box[2] or box[1]>=box[3]:continue
        boxes.append({'id':len(boxes)+1,'box':box,'confidence':round(confidence,4),'appearance':appearance(frame,box)})
    args.output.mkdir(parents=True,exist_ok=True)
    # Lossless snapshot: the eyedropper samples the original decoded pixels.
    if not cv2.imwrite(str(args.output/'frame.png'),frame):raise ValueError('초기 장면 저장 실패')
    payload={'frameIndex':index,'time':index/fps,'fps':fps,'duration':count/fps,'width':frame.shape[1],'height':frame.shape[0],
             'device':args.device,'model':Path(args.model).name,'boxes':boxes}
    (args.output/'detections.json').write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
    print('FPA_PROGRESS '+json.dumps({'stage':'초기 장면 준비 완료','progress':100}),flush=True)


if __name__=='__main__':main()
