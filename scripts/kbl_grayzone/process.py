"""Reassociate FPC detections after curved-ROI rejection; detect/track the ball."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"scripts"))
sys.path.insert(0,str(ROOT/"runtime/fpa-cv/packages"))
from spatial import boundary,unproject

def atomic(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix(".tmp");temp.write_text(json.dumps(data,ensure_ascii=False,separators=(",",":")));temp.replace(path)

def reassociate(raw,profile,manual):
    import cv2
    import numpy as np
    from types import SimpleNamespace
    from ultralytics.engine.results import Boxes
    from fpa_cv_bytetrack import ColorBYTETracker
    from fpa_cv_uniforms import classify_uniform
    tracker=ColorBYTETracker(SimpleNamespace(track_high_thresh=.18,track_low_thresh=.08,new_track_thresh=.2,
        track_buffer=12,match_thresh=.8,fuse_score=True),frame_rate=30,observation_fps=raw["detector"]["sampleFps"])
    anchors=profile["anchors"];contour=boundary(anchors);margin=boundary(anchors,1.5)
    refs=[e for e in manual.get("snapshots",[{}])[0].get("entities",[]) if e["role"].startswith("ref")] if manual.get("snapshots") else []
    roles={};seed_source={};frames=[];outside=0;total=0
    for i,f in enumerate(raw["frames"]):
        kept=[];teams=[];first_roles={}
        for b in f["boxes"]:
            total+=1;box=b["box"];foot=[(box[0]+box[2])*960,box[3]*1080]
            candidate=next((e for e in refs if i==0 and math.dist(e["foot"],foot)<45),None)
            known_role=seed_source.get(b["id"])
            inside=cv2.pointPolygonTest(contour,tuple(foot),False)>=0
            ref_allowed=(candidate or known_role) and cv2.pointPolygonTest(margin,tuple(foot),False)>=0
            if not inside and not ref_allowed:outside+=1;continue
            appearance=b.get("appearance",[])
            color=classify_uniform(appearance,profile.get("palettes",{}))
            group=color.get("group");teams.append(1 if group=="home" else 2 if group=="away" else 0)
            if candidate:
                first_roles[len(kept)]=candidate["role"];seed_source[b["id"]]=candidate["role"]
            kept.append(b)
        rows=np.array([[b["box"][0]*1920,b["box"][1]*1080,b["box"][2]*1920,b["box"][3]*1080,b["confidence"],0] for b in kept],dtype=np.float32).reshape(-1,6)
        detections=Boxes(rows,(1080,1920))
        output=tracker.update(detections,teams=teams);boxes=[]
        for row in output:
            track=int(row[4]);idx=int(row[7]);original=kept[idx]
            if idx in first_roles:roles[track]=first_roles[idx]
            # Known referee fragments are only propagated with this track ID.
            norm=[float(row[j]/([1920,1080,1920,1080][j])) for j in range(4)]
            boxes.append({"id":track,"box":norm,"confidence":float(row[5]),"appearance":original.get("appearance",[]),
                          "roleHint":roles.get(track),"sourceTrackId":original["id"]})
        frames.append({"t":f["t"],"boxes":boxes})
    return {"schema":"kbl-tracks/v3","datasetId":str(uuid.uuid4()),"video":raw["video"],
            "detector":{**raw["detector"],"roiBeforeAssociation":True,"sourceDatasetId":raw["datasetId"],
                        "source":"cached FPC person observations; curved-ROI gated before fresh ColorBYTETracker association",
                        "outsideObservationsExcluded":outside,"inputObservations":total},
            "profile":profile,"frames":frames}

def detect_ball(video,cache,anchors,raw,progress):
    import cv2
    from ultralytics import YOLO
    from ball_tracking import motion_guided
    if cache.exists():return json.loads(cache.read_text())
    cap=cv2.VideoCapture(str(video));fps=cap.get(cv2.CAP_PROP_FPS);count=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    model=YOLO(str(ROOT/"runtime/fpa-cv/yolo26s.pt"))
    progress("배경 분리·작은 움직임 후보 수집",10)
    frames=motion_guided(video,raw,anchors,model,progress)
    result={"schema":"kbl-ball-candidates/v3","fps":fps,"duration":count/fps,"frames":frames}
    atomic(cache,result);return result

def finish_ball(video,candidates,keyframes,progress,observations=None,max_interpolation_seconds=.35):
    import cv2
    from collections import deque
    from ball_tracking import associate,flow_pair,orange_fraction,bridge
    if observations is None:
        observations=associate(candidates["frames"],candidates["fps"])
    manual=[{**k,"source":"manual","confidence":1.,"reviewed":True} for k in keyframes]
    fps=candidates["fps"];seeds={round(s["t"]*fps):s for s in observations}
    seeds.update({round(s["t"]*fps):s for s in manual})
    cap=cv2.VideoCapture(str(video));count=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    prev=None;last=None;last_seed=-1000;samples={};window=round(fps*.4);history=deque(maxlen=window+1)
    template=None
    def patch(gray,point):
        return cv2.getRectSubPix(gray,(11,11),tuple(map(float,point)))
    def advance(previous,current,last,template,frame,seed_orange):
        point=flow_pair(previous,current,last["point"])
        if point is None or not 6<=point[0]<frame.shape[1]-6 or not 6<=point[1]<frame.shape[0]-6:return None
        crop=patch(current,point)
        # Small interlaced, desaturated balls are poorly served by an absolute
        # orange threshold. Operator seeds also supply a local appearance check.
        correlation=float(cv2.matchTemplate(crop,template,cv2.TM_CCOEFF_NORMED)[0,0])
        difference=abs(float(crop.mean())-float(template.mean()))
        orange=orange_fraction(frame,[point[0]-5,point[1]-5,point[0]+5,point[1]+5])
        if correlation<.45 or difference>38 or (seed_orange>=.06 and orange<.055):return None
        return point
    for index in range(count):
        ok,frame=cap.read()
        if not ok:raise RuntimeError("Incomplete video during optical flow")
        # Interlaced FPC recordings: use one field for stable local features.
        frame=cv2.resize(frame[::2],(frame.shape[1],frame.shape[0]))
        gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
        if index in seeds:
            seed={**seeds[index],"t":index/fps}
            samples[index]=seed;last=None if seed.get("missing") else seed;last_seed=index
            if last:
                template=patch(gray,last["point"])
                x,y=last["point"];seed_orange=orange_fraction(frame,[x-5,y-5,x+5,y+5])
                backward=seed;current_gray=gray
                for old_index,old_gray,old_frame in reversed(history):
                    if old_index in seeds:break
                    point=advance(current_gray,old_gray,backward,template,old_frame,seed_orange)
                    if point is None:break
                    sample={"t":old_index/fps,"point":point,"confidence":backward["confidence"]*.94,"source":"flow","reviewed":False,"seedTime":index/fps}
                    if old_index not in samples or samples[old_index].get("confidence",0)<sample["confidence"]:samples[old_index]=sample
                    backward=sample;current_gray=old_gray
        elif last is not None and prev is not None and index-last_seed<=window:
            point=advance(prev,gray,last,template,frame,seed_orange)
            if point:
                sample={"t":index/fps,"point":point,"confidence":last["confidence"]*.92,"source":"flow","reviewed":False,"seedTime":last_seed/fps}
                samples[index]=sample;last=sample
            else:last=None
        else:last=None
        prev=gray
        # Only retain short history around a seed scheduled in the next .4 s.
        if any(index<k<=index+window for k in seeds):history.append((index,gray,frame))
        else:history.clear()
    cap.release()
    # Explicit missing seeds split paths; gaps remain unknown beyond 0.35 s.
    filled=bridge(sorted(samples.values(),key=lambda s:s["t"]),fps=fps,max_gap=max_interpolation_seconds)
    valid=[s for s in filled if not s.get("missing")]
    counts={kind:sum(s["source"]==kind for s in valid) for kind in ["manual","detected","flow","interpolated"]}
    return {"schema":"kbl-ball-track/v2","fps":fps,"duration":candidates["duration"],"samples":filled,
            "stats":counts,"coverageSeconds":len(valid)/fps,"candidateCount":sum(len(f["candidates"]) for f in candidates["frames"]),
            "method":"background/motion proposals + body exclusion + enlarged YOLO verification + temporal gates; deinterlaced bidirectional LK + bounded interpolation",
            "maxFlowSeconds":.4,"maxInterpolationSeconds":max_interpolation_seconds,"heightMeasured":False}

def main():
    p=argparse.ArgumentParser();p.add_argument("--clip",required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--profile",type=Path,required=True);p.add_argument("--skip-ball",action="store_true");args=p.parse_args()
    os.environ.setdefault("YOLO_CONFIG_DIR","/private/tmp/kbl-yolo")
    from serve import CLIPS,MEDIA,ANALYSIS,APP
    c=CLIPS[args.clip];profile=json.loads(args.profile.read_text());args.output.mkdir(parents=True,exist_ok=True)
    def progress(stage,value):atomic(args.output/"progress.json",{"state":"running","stage":stage,"progress":value});print(stage,value,flush=True)
    progress("코트 영역 적용·객체 재연결",2)
    raw=json.loads((ANALYSIS/args.clip/"tracks.json").read_text())
    manual_path=APP/"data"/f"{args.clip}.json";manual=json.loads(manual_path.read_text()) if manual_path.exists() else {}
    tracked=reassociate(raw,profile,manual);atomic(args.output/"tracks.json",tracked)
    if not args.skip_ball:
        crop_key=hashlib.sha256(json.dumps(profile["anchors"]).encode()).hexdigest()[:8]
        cache=ROOT/"outputs/kbl-grayzone-analysis/ball-cache"/f"{args.clip}-motion-{crop_key}.json"
        candidates=detect_ball(MEDIA/c["file"],cache,profile["anchors"],raw["frames"],progress)
        progress("공 움직임 연결·짧은 구간 보간",80)
        ball=finish_ball(MEDIA/c["file"],candidates,profile.get("ballKeyframes",[]),progress);atomic(args.output/"ball.json",ball)
    atomic(args.output/"progress.json",{"state":"complete","stage":"분석 완료","progress":100})
    print("COMPLETE",args.clip,flush=True)

if __name__=="__main__":main()
