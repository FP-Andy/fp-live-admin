"""Conservative FIBA floor projection from public NBA-trained court keypoints.

Only straight court/paint/center lines are used. Rim and arc tangent landmarks
are excluded. Reprojection consistency does not certify metric accuracy.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

# Index order: roboflow/sports feat/basketball CourtConfiguration.vertices.
# FIBA court 28 x 15 m, paint 5.8 x 4.9 m. No elevated rim points.
FLOOR_POINTS={0:(0,0),2:(0,5.05),3:(0,9.95),5:(0,15),9:(5.8,5.05),
              10:(5.8,7.5),11:(5.8,9.95),15:(14,0),16:(14,7.5),17:(14,15),
              21:(22.2,5.05),22:(22.2,7.5),23:(22.2,9.95),27:(28,0),
              29:(28,5.05),30:(28,9.95),32:(28,15)}
# Straight baseline/three-point intersections and sideline throw-in marks.
# These are floor points, unlike the rim and curved-arc tangent landmarks.
# roboflow/sports: sports/basketball/config.py, CourtConfiguration (FIBA).
FLOOR_POINTS.update({1:(0,.9),4:(0,14.1),12:(8.3,0),14:(8.3,15),
                     18:(19.7,0),20:(19.7,15),28:(28,.9),31:(28,14.1)})


def estimate_manual_court(points, width=1920, height=1080):
    """Fit every explicitly reviewed point; record residuals instead of discarding points."""
    result={'status':'unavailable','landmarks':points,'reason':'degenerate manual landmarks',
            'metricAccuracyVerified':False,'orientationVerified':False}
    if len(points)<6:return result
    src=np.array([FLOOR_POINTS[p['class_id']] for p in points],np.float64)
    dst=np.array([[p['x'],p['y']] for p in points],np.float64)
    if (not np.isfinite(dst).all() or np.linalg.matrix_rank(src-src.mean(axis=0))<2 or
        np.linalg.matrix_rank(dst-dst.mean(axis=0))<2 or
        cv2.contourArea(cv2.convexHull(dst.astype(np.float32)))<width*height*.002):return result
    H,_=cv2.findHomography(src,dst,0)
    if H is None or not np.isfinite(H).all() or abs(np.linalg.det(H))<1e-12:return result
    # A horizon through the playing surface makes the floor transform unusable.
    corners=np.array([[0,0],[28,0],[28,15],[0,15]],np.float64)
    denominators=np.c_[corners,np.ones(4)]@H[2]
    if np.min(np.abs(denominators))<1e-8 or np.min(denominators)*np.max(denominators)<=0:return result
    try:inverse=np.linalg.inv(H)
    except np.linalg.LinAlgError:return result
    projected=cv2.perspectiveTransform(src[:,None,:],H)[:,0,:]
    errors=np.linalg.norm(projected-dst,axis=1)
    if not np.isfinite(inverse).all() or not np.isfinite(errors).all():return result
    return {**result,'status':'provisional','reason':'operator-reviewed least-squares floor estimate',
            'imageToCourt':inverse.tolist(),'courtToImage':H.tolist(),'inliers':len(points),
            'rejectedLandmarks':[], 'reprojectionRMSEPixels':float(np.sqrt(np.mean(errors**2))),
            'reprojectionMaxPixels':float(np.max(errors)),
            'landmarkResiduals':[{'class_id':p['class_id'],'errorPixels':float(e)} for p,e in zip(points,errors)],
            'units':'meters','courtSize':[28,15],
            'origin':'model-defined baseline corner; not team attack direction'}


def estimate_court(points,width=1920,height=1080):
    chosen=[p for p in points if p['class_id'] in FLOOR_POINTS and p['confidence']>=.75
            and 0<=p['x']<width and 0<=p['y']<height]
    result={'status':'unavailable','landmarks':chosen,'reason':'insufficient reliable floor landmarks',
            'metricAccuracyVerified':False,'orientationVerified':False}
    if len(chosen)<6:return result
    src=np.array([FLOOR_POINTS[p['class_id']] for p in chosen],np.float64)
    dst=np.array([[p['x'],p['y']] for p in chosen],np.float64)
    if cv2.contourArea(cv2.convexHull(dst.astype(np.float32)))<width*height*.02:return result
    H,mask=cv2.findHomography(src,dst,cv2.RANSAC,12)
    if H is None or mask is None or not np.isfinite(H).all():return result
    keep=mask.ravel().astype(bool);inliers=int(keep.sum())
    if inliers<6 or inliers/len(chosen)<.7:return {**result,'reason':'landmark disagreement','inliers':inliers}
    src=src[keep];dst=dst[keep]
    loo=[]
    for i in range(len(src)):
        subset=np.arange(len(src))!=i;test,_=cv2.findHomography(src[subset],dst[subset],0)
        if test is None:return result
        pred=cv2.perspectiveTransform(src[i:i+1,None,:],test)[0,0]
        loo.append(float(np.linalg.norm(pred-dst[i])))
    if not np.isfinite(loo).all() or np.median(loo)>15 or max(loo)>45:
        return {**result,'reason':'leave-one-landmark-out inconsistency','holdoutMedianPx':float(np.median(loo))}
    try:inverse=np.linalg.inv(H)
    except np.linalg.LinAlgError:return result
    return {**result,'status':'provisional','reason':'floor-line consistency passed; manual survey pending',
            'landmarks':[p for p,ok in zip(chosen,keep) if ok],
            'rejectedLandmarks':[p for p,ok in zip(chosen,keep) if not ok],
            'imageToCourt':inverse.tolist(),'courtToImage':H.tolist(),'inliers':inliers,
            'holdoutMedianPx':float(np.median(loo)),'holdoutMaxPx':max(loo),'units':'meters',
            'courtSize':[28,15],'origin':'model-defined baseline corner; not team attack direction'}


def attach(results):
    for path in sorted(results.glob('review-[0-9]*.json')):
        packet=json.loads(path.read_text());court_path=results/f'court-{path.name}'
        if not court_path.exists():continue
        model=json.loads(court_path.read_text())
        if model['inputSha256']!=packet['inputSha256']:raise ValueError('Court and tracking input mismatch')
        by_frame={r['frameIndex']:r for r in model['frames']};passed=0
        for frame in packet['frames']:
            raw=by_frame.get(frame['frameIndex'],{});preds=(raw.get('result') or [{}])[0].get('predictions',[])
            points=max(preds,key=lambda p:p.get('confidence',0)).get('keypoints',[]) if preds else []
            frame['court']=estimate_court(points,packet['width'],packet['height']);court=frame['court']
            frame['floorPositions']=[]
            if court['status']!='provisional':continue
            passed+=1;H=np.array(court['imageToCourt'])
            for box in frame['boxes']:
                x,y=box['footpointPixels'];w,h=packet['width'],packet['height']
                # Scoreboard overlays and clipped feet are not floor observations.
                if y>=.97*h or x<3 or x>w-3 or (.20*w<x<.85*w and y>.86*h):continue
                pos=cv2.perspectiveTransform(np.array([[[x,y]]],np.float64),H)[0,0]
                if not np.isfinite(pos).all() or not (-2<pos[0]<30 and -2<pos[1]<17):continue
                frame['floorPositions'].append({'id':box['id'],'role':box['roleHint'],'xy':pos.tolist(),
                                                'status':'bbox-footpoint-proxy','source':'broadcast',
                                                'approvedForOcclusion':False})
        packet['courtSummary']={'modelId':model['modelId'],'wallSeconds':model['wallSeconds'],'provisionalFrames':passed,
                                'totalFrames':len(packet['frames']),'metricAccuracyVerified':False,
                                'note':'NBA-trained landmark model evaluated on FIBA straight lines; no arc/rim anchors; manual validation required'}
        temp=path.with_suffix('.tmp');temp.write_text(json.dumps(packet,ensure_ascii=False,indent=2));temp.replace(path)
        print(path.name,json.dumps(packet['courtSummary']),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--results',type=Path,required=True);a=p.parse_args();attach(a.results)
