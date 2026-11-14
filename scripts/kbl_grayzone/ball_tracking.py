"""Conservative ball association. Missing observations remain missing.

Tiled YOLO sports-ball detections are proposals, not ground truth. Require
colour/temporal support, and let operator keyframes override ambiguous proposals.
Only bounded forward/backward optical-flow checks and bounded interpolation bridge gaps.
"""
import math
import cv2
import numpy as np

def orange_fraction(frame,box):
    x1,y1,x2,y2=map(int,box);h,w=frame.shape[:2]
    patch=frame[max(0,y1):min(h,y2+1),max(0,x1):min(w,x2+1)]
    if not patch.size:return 0.
    hsv=cv2.cvtColor(patch,cv2.COLOR_BGR2HSV)
    mask=((hsv[:,:,0]>=2)&(hsv[:,:,0]<=28)&(hsv[:,:,1]>=65)&(hsv[:,:,2]>=35))
    return float(mask.mean())

def proposals(model,frame,top,bottom):
    found=[]
    for x0,x1 in [(0,760),(580,1340),(1160,1920)]:
        result=model.predict(frame[top:bottom,x0:x1],classes=[32],imgsz=1280,conf=.07,device="cpu",verbose=False)[0]
        for b,conf in zip(result.boxes.xyxy.tolist(),result.boxes.conf.tolist()):
            box=[b[0]+x0,b[1]+top,b[2]+x0,b[3]+top];bw=box[2]-box[0];bh=box[3]-box[1]
            if not 3<=bw<=42 or not 3<=bh<=42 or not .5<=bw/bh<=2:continue
            orange=orange_fraction(frame,box)
            if orange<.12 and conf<.45:continue
            point=[(box[0]+box[2])/2,(box[1]+box[3])/2]
            existing=next((p for p in found if math.dist(p["point"],point)<max(bw,bh)),None)
            candidate={"point":point,"box":box,"confidence":float(conf),"orange":orange,"source":"detected"}
            if existing:
                if conf>existing["confidence"]:found.remove(existing);found.append(candidate)
            else:found.append(candidate)
    return found

def flow_pair(previous,current,point):
    # Nine features across the ball patch, and reverse tracking to reject drift.
    seeds=np.array([[point[0]+dx,point[1]+dy] for dy in [-2,0,2] for dx in [-2,0,2]],np.float32).reshape(-1,1,2)
    args=dict(winSize=(15,15),maxLevel=3,criteria=(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,25,.01))
    forward,status,err=cv2.calcOpticalFlowPyrLK(previous,current,seeds,None,**args)
    if forward is None:return None
    backward,back_status,_=cv2.calcOpticalFlowPyrLK(current,previous,forward,None,**args)
    if backward is None:return None
    fb=np.linalg.norm(backward-seeds,axis=2).ravel()
    valid=(status.ravel()==1)&(back_status.ravel()==1)&(fb<1.3)&(err.ravel()<25)
    if valid.sum()<5:return None
    delta=(forward-seeds).reshape(-1,2)[valid];median=np.median(delta,axis=0)
    if np.median(np.linalg.norm(delta-median,axis=1))>2.5 or np.linalg.norm(median)>45:return None
    return (np.asarray(point)+median).tolist()

def associate(candidate_frames,fps):
    """Accept temporal neighbours or high confidence + orange. Never one weak hit."""
    accepted=[]
    for i,f in enumerate(candidate_frames):
        choices=[]
        for c in f["candidates"]:
            support=0
            for neighbour in candidate_frames[max(0,i-2):min(len(candidate_frames),i+3)]:
                dt=abs(neighbour["t"]-f["t"])
                if not .001<dt<=.25:continue
                if any(math.dist(c["point"],n["point"])<=12+750*dt for n in neighbour["candidates"]):support+=1
            guided=c.get("motionVerified") and support>=1 and c["confidence"]>=.06 and c["orange"]>=.055
            if guided if c.get("motionVerified") else ((c["confidence"]>=.4 and c["orange"]>=.2) or (support>=2 and c["orange"]>=.2)):
                choices.append((c["confidence"]+min(support,3)*.1+c["orange"]*.15,c))
        if choices:
            choices.sort(key=lambda item:item[0],reverse=True)
            # Ambiguous competing balls are left for an operator.
            if len(choices)>1 and choices[0][0]-choices[1][0]<.1:continue
            accepted.append({"t":f["t"],**choices[0][1],"reviewed":False})
    return accepted

def motion_guided(video,raw,anchors,model,progress):
    """Find free small moving blobs, then independently verify each with YOLO.

    Motion alone never establishes a ball. People boxes and their margins are
    excluded before proposal generation; the detector must agree at its centre.
    One video field avoids comb artefacts in these interlaced recordings.
    """
    cap=cv2.VideoCapture(str(video));fps=cap.get(cv2.CAP_PROP_FPS)
    top=max(0,int(min(p[1] for p in anchors)-100));bottom=min(1080,int(max(p[1] for p in anchors)+10))
    references=[]
    for t in range(0,30,3):
        cap.set(cv2.CAP_PROP_POS_MSEC,t*1000);ok,f=cap.read()
        if ok:references.append(cv2.resize(f[::2],(1920,1080))[top:bottom])
    if not references:cap.release();return []
    background=cv2.cvtColor(np.median(references,axis=0).astype(np.uint8),cv2.COLOR_BGR2GRAY)
    cap.set(cv2.CAP_PROP_POS_FRAMES,0);previous=None;items=[]
    for index in range(int(cap.get(cv2.CAP_PROP_FRAME_COUNT))):
        ok,frame=cap.read()
        if not ok:break
        frame=cv2.resize(frame[::2],(1920,1080));gray=cv2.cvtColor(frame[top:bottom],cv2.COLOR_BGR2GRAY)
        if previous is None:previous=gray;continue
        mask=((cv2.absdiff(gray,previous)>18)&(cv2.absdiff(gray,background)>27)).astype(np.uint8)*255;previous=gray
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        f=raw[min(len(raw)-1,round(index/fps*5))]
        for b in f["boxes"]:
            x1,y1,x2,y2=b["box"];cv2.rectangle(mask,(int(x1*1920)-3,int(y1*1080)-top-4),(int(x2*1920)+3,int(y2*1080)-top+4),0,-1)
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x,y,w,h=cv2.boundingRect(contour);area=cv2.contourArea(contour)
            if not (4<=w<=23 and 4<=h<=23 and .55<=w/h<=1.8 and area>=10 and area/(w*h)>=.4):continue
            orange=orange_fraction(frame,[x,y+top,x+w,y+top+h])
            if orange<.055:continue
            items.append({"frame":index,"t":index/fps,"point":[x+w/2,y+top+h/2],"orange":orange})
    selected=[]
    for item in items:
        neighbours=[q for q in items if .02<abs(q["t"]-item["t"])<.08 and math.dist(item["point"],q["point"])<30]
        if len(neighbours)<2:continue
        if any(abs(item["t"]-q["t"])<.09 and math.dist(item["point"],q["point"])<45 for q in selected):continue
        selected.append(item)
    verified=[]
    for i,item in enumerate(selected):
        cap.set(cv2.CAP_PROP_POS_FRAMES,item["frame"]);ok,frame=cap.read()
        if not ok:continue
        frame=cv2.resize(frame[::2],(1920,1080));x,y=item["point"]
        left=max(0,min(1470,round(x)-225));up=max(0,min(790,round(y)-145))
        result=model.predict(frame[up:up+290,left:left+450],classes=[32],imgsz=1280,conf=.04,device="cpu",verbose=False)[0]
        candidates=[]
        for b,confidence in zip(result.boxes.xyxy.tolist(),result.boxes.conf.tolist()):
            box=[b[0]+left,b[1]+up,b[2]+left,b[3]+up];point=[(box[0]+box[2])/2,(box[1]+box[3])/2]
            if math.dist(point,item["point"])>10 or not 3<box[2]-box[0]<30 or not 3<box[3]-box[1]<30:continue
            orange=orange_fraction(frame,box)
            if orange<.055:continue
            candidates.append({"point":point,"box":box,"confidence":float(confidence),"orange":orange,"source":"detected","motionVerified":True})
        if candidates:verified.append({"t":item["t"],"candidates":[max(candidates,key=lambda c:c["confidence"])]})
        if i%10==0:progress("작은 움직임 후보 확대 검증",20+int(55*i/max(1,len(selected))))
    cap.release()
    return verified

def bridge(samples,max_gap=.35,max_speed=900,fps=30):
    out=[]
    for i,s in enumerate(samples):
        out.append(s)
        if i+1==len(samples):continue
        n=samples[i+1];dt=n["t"]-s["t"]
        if s.get("missing") or n.get("missing"):continue
        if dt<=1/fps+.001 or dt>max_gap or math.dist(s["point"],n["point"])/dt>max_speed:continue
        # Never bridge an explicit operator 'not visible' keyframe.
        for frame in range(round(s["t"]*fps)+1,round(n["t"]*fps)):
            t=frame/fps;u=(t-s["t"])/dt
            out.append({"t":t,"point":[a+(b-a)*u for a,b in zip(s["point"],n["point"])],
                        "confidence":min(s.get("confidence",1),n.get("confidence",1))*.7,
                        "source":"interpolated","reviewed":False,"boundedBy":[s["t"],n["t"]]})
    return sorted(out,key=lambda s:s["t"])
