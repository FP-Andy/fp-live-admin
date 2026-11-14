"""Bounded full-frame/half-court landmark inference in original image coordinates."""
import cv2
from broadcast_geometry import estimate_court

def infer(image,predict):
    h,w=image.shape[:2];attempts=[]
    # Opposite halves are separate proposals, never merged before geometry checks.
    # Clock/crowd regions dominate panoramic sources at the model's 640px input.
    regions=[(0,0,w,h),(0,round(h*.43),round(w*.61),round(h*.89)),
             (round(w*.39),round(h*.43),w,round(h*.89))]
    for n,(x1,y1,x2,y2) in enumerate(regions):
        raw=predict(image[y1:y2,x1:x2],confidence=10)
        preds=raw.get('predictions',[])
        points=max(preds,key=lambda p:p.get('confidence',0)).get('keypoints',[]) if preds else []
        points=[{**p,'x':p['x']+x1,'y':p['y']+y1} for p in points]
        court=estimate_court(points,w,h);attempts.append({'region':[x1,y1,x2,y2],'raw':raw,'court':court})
        if court.get('imageToCourt'):
            court['inferenceRegion']=[x1,y1,x2,y2];court['inferenceMethod']='wide-full-frame' if n==0 else 'wide-half-court-crop'
            return court,attempts
    return court,attempts
