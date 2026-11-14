"""Conservative, frame-local camera correspondence. Never assign roster IDs."""
import copy,math
import cv2,numpy as np
from scipy.optimize import linear_sum_assignment

TRANSFORMS=[np.array(t,dtype=float) for t in (
    [[1,0,0],[0,1,0],[0,0,1]], [[-1,0,28],[0,-1,15],[0,0,1]],
    [[-1,0,28],[0,1,0],[0,0,1]], [[1,0,0],[0,-1,15],[0,0,1]])]

def point(T,xy):return (T@np.array([*xy,1.]))[:2].tolist()

def search_score(primary,secondary):
    """Loose ranking only, never permission to fuse observations."""
    a=np.array([p['xy'] for p in primary if p['role']=='player']);b=[p for p in secondary if p['role']=='player']
    if min(len(a),len(b))<4:return 100.
    scores=[]
    for T in TRANSFORMS:
        y=np.array([point(T,p['xy']) for p in b]);d=np.linalg.norm(a[:,None]-y[None,:],axis=2)
        i,j=linear_sum_assignment(d);scores.append(float(np.median(d[i,j]))+max(0,len(a)-len(b))*.15)
    return min(scores)

def align(primary,secondary):
    """Resolve court symmetry with >=5 independent, spread-out player matches."""
    a=[p for p in primary if p['role']=='player'];b=[p for p in secondary if p['role']=='player']
    if min(len(a),len(b))<5:return {'state':'insufficient-correspondence'}
    trials=[]
    for k,T in enumerate(TRANSFORMS):
        x=np.array([p['xy'] for p in a]);y=np.array([point(T,p['xy']) for p in b])
        distances=np.linalg.norm(x[:,None,:]-y[None,:,:],axis=2)
        rows,cols=linear_sum_assignment(distances)
        pairs=[(i,j,float(distances[i,j])) for i,j in zip(rows,cols) if distances[i,j]<1.25]
        if len(pairs)<5:continue
        spread=np.ptp(x[[i for i,_,_ in pairs]],axis=0)
        coverage=len(pairs)/len(a);median=float(np.median([d for _,_,d in pairs]))
        if min(spread)<2.5 or coverage<.65 or median>.65:continue
        trials.append({'state':'matched','transform':T.tolist(),'orientation':k,'medianMeters':median,
            'score':median+(1-coverage),'coverage':coverage,
            'pairs':[{'primaryId':a[i]['id'],'wideId':b[j]['id'],'distanceMeters':d} for i,j,d in pairs]})
    trials.sort(key=lambda r:r['score'])
    if not trials:return {'state':'geometry-disagreement'}
    if len(trials)>1 and trials[1]['score']-trials[0]['score']<.25:return {'state':'orientation-ambiguous'}
    return trials[0]

def transform_camera(camera,T):
    """Keep each camera's image rays; transform its world coordinates only."""
    A=np.eye(3);A[:2,:2]=T[:2,:2];offset=np.array([T[0,2],T[1,2],0.])
    R=np.array(camera['worldToCamera']);out=copy.deepcopy(camera)
    out['worldToCamera']=(R@A.T).tolist()
    out['translation']=(np.array(camera['translation'])-R@A.T@offset).tolist()
    out['source']='wide-floor-camera; player-layout-aligned'
    return out

def project(camera,xy,height):
    R=np.array(camera['worldToCamera']);t=np.array(camera['translation']);K=np.array(camera['K'])
    p=R@np.array([*xy,height])+t
    if p[2]<=0:return None
    # This camera uses zero distortion. Keep an explicit check for future models.
    if np.linalg.norm(camera['distortion'])>1e-5:return None
    q=K@p;return (q[:2]/q[2]).tolist()

def assignments(frame,wide,match,primary_camera):
    """One-to-one matches; preserve all primary positions, add only clear absences."""
    T=np.array(match['transform']);positions={p['id']:p for p in frame.get('floorPositions',[])}
    boxes={b['id']:b for b in frame['boxes'] if b['roleHint'] in ('player','referee')}
    placed={p['id']:{**p,'xy':point(T,p['xy'])} for p in wide['positions']}
    raw={p['id']:p for p in wide['people']};pairs={p['wideId']:p['primaryId'] for p in match['pairs']}
    used=set(pairs.values());blocked=set();candidates=[]
    for wid,p in placed.items():
        if wid in pairs:continue
        role=p['role'];head=project(primary_camera,p['xy'],1.65);foot=project(primary_camera,p['xy'],0)
        if head is None or foot is None:blocked.add(wid);continue
        for bid,b in boxes.items():
            if bid in used or b['roleHint']!=role:continue
            if bid in positions:
                d=math.dist(positions[bid]['xy'],p['xy'])
                if d<1:candidates.append((d,wid,bid))
            else:
                x1,y1,x2,y2=np.array(b['box'])*[1920,1080,1920,1080]
                # A partial torso can recover its floor point from the other camera.
                hip=project(primary_camera,p['xy'],1.)
                if hip and x1-20<=hip[0]<=x2+20 and y1-20<=hip[1]<=y2+30:
                    dx=abs(hip[0]-(x1+x2)/2)/max(20,x2-x1)
                    candidates.append((dx,wid,bid))
        # If any projected torso overlaps a primary detection, an unmatched
        # wide person must not be introduced as a duplicate or role correction.
        for b in boxes.values():
            x1,y1,x2,y2=np.array(b['box'])*[1920,1080,1920,1080]
            if x1-25<=head[0]<=x2+25 and y1-30<=head[1]<=y2+30:blocked.add(wid)
    for score,wid,bid in sorted(candidates):
        if wid in pairs or bid in used:continue
        alternatives=[s for s,w,b in candidates if (w==wid and b!=bid) or (b==bid and w!=wid)]
        if alternatives and min(alternatives)-score<.25:blocked.add(wid);continue
        pairs[wid]=bid;used.add(bid)
    result=[];counts={r:sum(b['roleHint']==r for b in boxes.values()) for r in ('referee','player')}
    for wid,p in placed.items():
        person=raw.get(wid)
        if not person:continue
        existing=pairs.get(wid);role=p['role']
        if not existing:
            if wid in blocked or person.get('roleConfidence',0)<.85 or counts[role]>=(3 if role=='referee' else 10):continue
            # Unmatched in-view players are likely detection/association errors.
            head=project(primary_camera,p['xy'],1.65)
            if role=='player' and head and 0<=head[0]<1920 and 0<=head[1]<1080:continue
            counts[role]+=1
        result.append({'id':existing or 'wide-'+wid,'wideId':wid,'role':role,'xy':p['xy'],
            'newObject':existing is None,'fillPosition':existing not in positions,
            'person':copy.deepcopy(person)})
    return result

def fill_missing_bones(primary,secondary):
    """Fuse world-space directions only. Never mix pixels from two cameras."""
    if not secondary.get('autoAccepted'):return primary
    out=copy.deepcopy(primary);manual={int(i) for i in primary.get('manualJoints',{})}
    from fit_pose import BONES
    supplemented=[]
    for bone,ends in BONES.items():
        if bone in out.get('directions',{}) or any(i in manual for i in ends):continue
        if bone not in secondary.get('directions',{}):continue
        side=bone.rsplit('_',1)[-1]
        if 'arm' in bone:
            chain=['upperarm_'+side,'lowerarm_'+side]
            if primary.get('manualArms3D',{}).get(side) or any(c in out.get('directions',{}) for c in chain):continue
            if not all(c in secondary['directions'] for c in chain):continue
            if any(i in manual for c in chain for i in BONES[c]):continue
            for c in chain:out.setdefault('directions',{})[c]=secondary['directions'][c];supplemented.append(c)
            out.setdefault('armQuality',{})[side]=copy.deepcopy(secondary['armQuality'][side])
        else:out.setdefault('directions',{})[bone]=secondary['directions'][bone];supplemented.append(bone)
    if not supplemented:return primary
    # If the primary torso cannot be recovered, use a complete secondary body
    # orientation; independent image joints still remain editable in their source.
    if not primary.get('autoAccepted'):
        for k in ('bodyHeading','bodyDirection','spineDirection'):out[k]=copy.deepcopy(secondary[k])
    out.update(accepted=True,autoAccepted=True,status='multiview-supplemented',wideSupplementedBones=sorted(set(supplemented)),
               fallbackBones=[b for b in BONES if b not in out['directions']])
    return out
