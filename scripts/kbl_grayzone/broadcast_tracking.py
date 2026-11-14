"""Public basketball model on broadcast footage; proposals, never reviewed truth.

Broadcast coordinates are independent of FPC coordinates. Shot boundaries reset
association, and no floor projection or cross-camera identity is invented here.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import time
from types import SimpleNamespace

import cv2
import numpy as np
try:
    from .basketball_detector import BasketballDetector, SOURCE, overlap, suppress
except ImportError:
    from basketball_detector import BasketballDetector, SOURCE, overlap, suppress


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def role(d):
    if d['class'].startswith('player'): return 'player'
    if d['class'] in ('ball', 'ball-in-basket'): return 'ball'
    return d['class']


def people_nms(detections):
    # Action subclasses and conflicting referee/player hypotheses describe one body.
    kept = []
    for d in sorted(detections, key=lambda x: -x['confidence']):
        if role(d) not in ('player', 'referee'): continue
        if not any(overlap(d['box'], k['box']) > .65 for k in kept): kept.append(d)
    return kept


def balls_nms(detections):
    kept = []
    for d in sorted(detections, key=lambda x: -x['confidence']):
        if role(d) != 'ball': continue
        if not any(overlap(d['box'], k['box']) > .35 for k in kept): kept.append(d)
    return kept


def detect(detector, frame, ball_tiles=False):
    raw = suppress(detector.predict(frame, threshold=.15))
    full_balls = balls_nms(raw)
    if ball_tiles:
        h, w = frame.shape[:2]
        # Size is relative to this source; no wide-camera 30px ball veto.
        size = min(640, h, w)
        for y in sorted(set([0, max(0, h-size)])):
            for x in sorted(set([0, max(0, (w-size)//2), max(0, w-size)])):
                raw.extend(d for d in detector.predict(frame[y:y+size, x:x+size], (x,y), threshold=.3) if role(d)=='ball')
    return people_nms(raw), balls_nms(raw), full_balls


def build_tracker(rate):
    from ultralytics.trackers.byte_tracker import BYTETracker
    t = BYTETracker(SimpleNamespace(track_high_thresh=.3, track_low_thresh=.15,
                    new_track_thresh=.4, track_buffer=24, match_thresh=.8, fuse_score=True), frame_rate=rate)
    return t


def apply_xyah_camera_motion(tracker, warp):
    """Apply image-plane motion without rotating aspect ratio into pixel height.

    ByteTrack's state is XYAH, unlike BoT-SORT's XYWH. A Kronecker 2D
    rotation across every state pair corrupts A/H even for tiny camera rolls.
    The aspect ratio is dimensionless and stays fixed for this similarity model.
    """
    if warp is None or np.shape(warp)!=(2,3) or not np.isfinite(warp).all():return False
    scale=float(np.linalg.norm(warp[:,0]));angle=float(np.arctan2(warp[1,0],warp[0,0]))
    if not .94<=scale<=1.06 or abs(angle)>.04 or np.linalg.norm(warp[:,2])>150:return False
    J=np.eye(8);J[:2,:2]=warp[:,:2];J[4:6,4:6]=warp[:,:2];J[3,3]=scale;J[7,7]=scale
    unique={id(t):t for t in tracker.tracked_stracks+tracker.lost_stracks}
    for track in unique.values():
        if track.mean is None:continue
        track.mean=J@track.mean;track.mean[:2]+=warp[:,2];track.covariance=J@track.covariance@J.T
    return True


def cut_signature(frame):
    hsv = cv2.cvtColor(cv2.resize(frame, (160,90)), cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0,1], None, [24,24], [0,180,0,256])
    return cv2.normalize(hist, hist).ravel()


def video(detector, source, output, event, selected, end_seconds=8, processing=None, selected_is_broadcast=False,progress=None):
    from ultralytics.engine.results import Boxes
    from ultralytics.trackers.utils.gmc import GMC
    cap = cv2.VideoCapture(str(source)); fps = cap.get(cv2.CAP_PROP_FPS)
    width, height = int(cap.get(3)), int(cap.get(4)); total=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    selected_index=int(selected) if selected_is_broadcast else round((selected/event['wide']['fps']-event['sync']['wideAtBroadcastZero'])*fps)
    from action_window import window_frames
    if selected_is_broadcast:first,end=window_frames(total,fps,selected_index,end_seconds)
    else:first,end=0,min(total,round(end_seconds*fps))
    length=end-first;cap.set(cv2.CAP_PROP_POS_FRAMES,first)
    stride = max(1, round(fps/10)); tracker = build_tracker(fps/stride);gmc=GMC(method='sparseOptFlow',downscale=2)
    vote = defaultdict(Counter); shot = 0; prev = None; frames=[]; selected_raw=None
    start = time.perf_counter(); before = dict(detector.timing)
    requested = set(range(first,end,stride)) | {selected_index}
    count=0
    for index in range(first,end):
        ok, frame = cap.read()
        if not ok: break
        if index not in requested: continue
        signature=cut_signature(frame)
        cut_distance = float(cv2.compareHist(prev, signature, cv2.HISTCMP_BHATTACHARYYA)) if prev is not None else 0.
        if cut_distance>.55:
            shot += 1; tracker=build_tracker(fps/stride);gmc=GMC(method='sparseOptFlow',downscale=2);vote.clear()
        prev=signature
        tiled = index % (stride*2)==0 or index==selected_index
        people, balls, full_balls=detect(detector,frame,tiled)
        if index==selected_index:
            selected_raw={'frameIndex':index,'t':index/fps,'people':people,'ballCandidates':balls,'alignmentVerified':False}
        detections=np.array([[*d['box'],d['confidence'],0 if role(d)=='player' else 1] for d in people],np.float32).reshape(-1,6)
        warp=gmc.apply(frame);motion_applied=apply_xyah_camera_motion(tracker,warp)
        tracked=tracker.update(Boxes(detections,(height,width)))
        boxes=[]
        for row in tracked:
            x1,y1,x2,y2,tid,confidence,cls,det_index=row.tolist(); tid=int(tid)
            vote[tid]['player']*=.9;vote[tid]['referee']*=.9
            # Upstream reindexes high/low subsets, so det_index is not a raw index.
            vote[tid]['player' if int(cls)==0 else 'referee']+=confidence
            best=vote[tid].most_common(1)[0][0]; total=sum(vote[tid].values());fraction=vote[tid][best]/max(total,1e-9)
            boxes.append({'id':f's{shot}-t{tid}','box':[x1/width,y1/height,x2/width,y2/height],
                          'roleHint':best if fraction>=.65 else 'unknown','confidence':confidence,
                          'roleEvidenceFraction':fraction,'footpointPixels':[(x1+x2)/2,y2],
                          'footpointStatus':'bbox-bottom proxy; not ankle-verified', 'source':'observed'})
        # Multiple orange objects can be false positives. Keep the candidates for review.
        credible=[b for b in balls if b['confidence']>=.45]
        ball=credible[0] if len(credible)==1 else None
        frames.append({'frameIndex':index,'t':index/fps,'shotId':shot,'boxes':boxes,'rawPeople':people,
                       'cameraMotion':{'warp':warp.tolist(),'applied':motion_applied},
                       'ballCandidates':balls,'ball':ball,'ballStatus':'candidate-unverified' if ball else 'ambiguous' if credible else 'missing',
                       'fullFrameBallCount':len(full_balls),'ballTiles':tiled,'cutDistance':cut_distance})
        count+=1
        if progress:progress(count,len(requested))
        if count%20==0: print(f"{event['id']} {index}/{end}",flush=True)
    cap.release()
    elapsed=time.perf_counter()-start
    with source.open('rb') as stream:source_hash=hashlib.file_digest(stream,'sha256').hexdigest()
    if processing:
        if processing['processedSha256']!=source_hash or processing['originalSha256']!=event['broadcast']['sha256']:
            raise ValueError('Processing proxy provenance mismatch')
        source_hash=processing['originalSha256']
    result={'schema':'kbl-broadcast-tracks/v1','eventId':event['id'],'source':'broadcast','inputSha256':source_hash,
            'datasetId':f'broadcast-rfdetr-{source_hash[:16]}-v2','fps':fps,'width':width,'height':height,
            'coverageSeconds':[first/fps,end/fps], 'trackHz':fps/stride,'detector':detector.execution,
            'tracker':'ByteTrack + XYAH-safe sparse optical flow GMC; per-shot anonymous IDs; decayed model role votes',
            'coordinateSpace':'image','status':'unreviewed','staffClassSupported':False,
            'crossCameraIdentityVerified':False,'alignmentVerified':False,'processing':processing,'frames':frames,'selectedFrame':selected_raw,
            'summary':{'wallSeconds':elapsed,'videoSeconds':length/fps,'processedFrames':len(frames),'shots':shot+1,
                       'inference':{k:detector.timing[k]-before[k] for k in before},
                       'framesWithSingleBallCandidate':sum(f['ball'] is not None for f in frames),
                       'sampledFramesWithFullFrameBall':sum(f['fullFrameBallCount']>0 for f in frames)}}
    atomic(output,result);print(json.dumps({'event':event['id'],**result['summary']}),flush=True)


def corpus(detector, root, output):
    manifest=json.loads((root/'manifest.json').read_text());rows=[];counts=Counter();start=time.perf_counter()
    for n,item in enumerate(manifest['images']):
        image_path=root/item['file']; image=cv2.imread(str(image_path))
        if image is None: raise ValueError('Cannot decode selected corpus image')
        people, balls, full=detect(detector,image,ball_tiles=False)
        proposals=[{**d,'class':role(d)} for d in people+balls if d['confidence']>=.3]
        counts.update(d['class'] for d in proposals)
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
        row={**item,'proposals':proposals,'annotationStatus':'unreviewed-model-proposals',
             'quality':{'laplacianVariance':float(cv2.Laplacian(gray,cv2.CV_64F).var()),'meanIntensity':float(gray.mean())},
             'reviewRequired':['missed players','referee/staff confusion','ball false positives','partial bodies','replay/closeup view']}
        rows.append(row)
        if (n+1)%50==0: print(f'corpus {n+1}/{len(manifest["images"])}',flush=True)
    atomic(output,{'schema':'kbl-broadcast-proposals/v1','status':'unreviewed; not training ground truth',
                   'sourceModel':SOURCE,'execution':detector.execution,'wallSeconds':time.perf_counter()-start,
                   'classCounts':dict(counts),'images':rows,'staffClassSupported':False,
                   'splitPolicy':manifest['splitPolicy'],'imageCounts':manifest['imageCounts']})
    print(json.dumps({'proposalImages':len(rows),'classCounts':dict(counts)}),flush=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('--case',type=Path,required=True);p.add_argument('--corpus',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--device',default='cuda');a=p.parse_args()
    # Loading torch first makes the CUDA shared libraries available to ORT.
    import torch
    cv2.setNumThreads(2);detector=BasketballDetector(threads=3,device=a.device)
    case=json.loads((a.case/'case.json').read_text());selections=json.loads((a.case/'selections.json').read_text())
    processing=json.loads((a.case/'processing-inputs.json').read_text()) if (a.case/'processing-inputs.json').exists() else {}
    for e in case['events']:
        out=a.output/f"{e['id']}.json"
        if not out.exists():video(detector,a.case/'broadcast'/e['broadcast']['file'],out,e,selections['events'][e['id']]['selectedFrame'],processing=processing.get(e['broadcast']['file']))
    if not (a.output/'proposals.json').exists():corpus(detector,a.corpus,a.output/'proposals.json')


if __name__=='__main__':main()
