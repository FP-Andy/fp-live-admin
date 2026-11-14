"""Conservative evidence for map-facing mesh selection, not measured 3D pose."""
import math
import numpy as np

LEGS={'l':(11,13,15),'r':(12,14,16)}

def shoe_centers(asset):
    """Two connected shoe components in the exact saved mesh coordinate frame."""
    try:
        part=next(p for p in asset['parts'] if p['material']=='shoes')
        faces=np.asarray(part['indices'],dtype=np.int64).reshape(-1,3)
        xyz=np.asarray(asset['positions'],float).reshape(-1,3)
        if not np.isfinite(xyz).all() or len(faces)<2 or faces.min()<0 or faces.max()>=len(xyz):return None
        parents={int(v):int(v) for v in np.unique(faces)}
        def root(a):
            while parents[a]!=a:parents[a]=parents[parents[a]];a=parents[a]
            return a
        for tri in faces:
            a=root(int(tri[0]));parents[root(int(tri[1]))]=a;parents[root(int(tri[2]))]=a
        components={}
        for v in parents:components.setdefault(root(v),[]).append(v)
        groups=sorted(components.values(),key=len,reverse=True)
        if len(groups)!=2 or min(map(len,groups))<20:return None
        return np.array([xyz[g].mean(axis=0) for g in groups])
    except (KeyError,TypeError,ValueError,StopIteration):return None

def baseline_leg_rig_matches_mesh(original,probe,saved_asset,probe_asset):
    """Never score regenerated baseline against an unrelated saved body."""
    try:
        if original['id']!=probe['id'] or abs(float(original.get('meshBodyHeading',original['bodyHeading']))-float(probe['meshBodyHeading']))>1e-5:return False
        a,b=shoe_centers(saved_asset),shoe_centers(probe_asset)
        if a is None or b is None:return False
        if min(max(np.linalg.norm(a[0]-b[0]),np.linalg.norm(a[1]-b[1])),max(np.linalg.norm(a[0]-b[1]),np.linalg.norm(a[1]-b[0])))>.01:return False
        h=float(probe['meshBodyHeading']);c,s=math.cos(h),math.sin(h);rot=np.array([[c,-s,0],[s,c,0],[0,0,1]])
        nearest=[]
        for side in ('l','r'):
            rig=probe['legRig'][side];ankle=rot@(np.asarray(rig['hip'],float)+np.asarray(rig['ankle'],float));d=np.linalg.norm(b-ankle,axis=1);nearest.append(int(np.argmin(d)))
            if not np.isfinite(d).all() or float(d.min())>.20:return False
        return nearest[0]!=nearest[1]
    except (KeyError,TypeError,ValueError,IndexError):return False

def leg_reprojection(person,entity,camera):
    """Project final leg rig, compare each knee/ankle relative to its hip.

    Uses image joints as approximate observations, not actual measured 3D.
    """
    try:
        if not isinstance(camera,dict):return None
        K=np.asarray(camera['K'],float);R=np.asarray(camera['worldToCamera'],float);t=np.asarray(camera['translation'],float).reshape(3)
        d=np.asarray(camera.get('distortion',[0,0,0,0,0]),float).ravel();d=np.pad(d,(0,max(0,5-len(d))))[:5]
        if K.shape!=(3,3) or R.shape!=(3,3) or not all(np.isfinite(v).all() for v in (K,R,t,d)):return None
        h=float(entity['bodyHeading']);c,s=math.cos(h),math.sin(h);rot=np.array([[c,-s,0],[s,c,0],[0,0,1]])
        def project(v):
            v=rot@v+np.array([entity['x'],entity['y'],0.]);q=R@v+t
            if q[2]<=.05:raise ValueError('point behind camera')
            x,y=q[0]/q[2],q[1]/q[2];k1,k2,p1,p2,k3=d;r=x*x+y*y;f=1+k1*r+k2*r*r+k3*r*r*r
            uv=K@np.array([x*f+2*p1*x*y+p2*(r+2*x*x),y*f+p1*(r+2*y*y)+2*p2*x*y,1]);return uv[:2]/uv[2]
        points=np.asarray(person['keypoints'],float);usable=person['jointUsable'];scores=person['scores'];manual=person.get('manualJoints') or {}
        if points.shape!=(17,2) or not np.isfinite(points).all():return None
        direct={};swapped={}
        for side,(hip,knee,ankle) in LEGS.items():
            if not all(usable[i] and (scores[i]>=.3 or str(i) in manual) for i in (hip,knee,ankle)):return None
            if any(n in person.get('fallbackBones',[]) for n in ('thigh_'+side,'calf_'+side)):return None
            rig=person['legRig'][side];h3=np.asarray(rig['hip'],float);p=[project(h3),project(h3+rig['knee']),project(h3+rig['ankle'])]
            other=LEGS['r' if side=='l' else 'l']
            for pos,i in enumerate((knee,ankle),1):
                direct[i]=float(np.linalg.norm((p[pos]-p[0])-(points[i]-points[hip])))
                swapped[i]=float(np.linalg.norm((p[pos]-p[0])-(points[other[pos]]-points[other[0]])))
        if not all(math.isfinite(x) for x in list(direct.values())+list(swapped.values())):return None
        return {'direct':direct,'swapped':swapped}
    except (KeyError,TypeError,ValueError,IndexError,OverflowError,FloatingPointError,ZeroDivisionError):return None

def leg_candidate_is_safer(before,after,box_diagonal):
    """Require matching labels, meaningful gain and no large individual regression."""
    if not before or not after or not math.isfinite(box_diagonal) or box_diagonal<=1:return False
    keys=set(before['direct'])
    if len(keys)!=4 or set(after['direct'])!=keys or set(after['swapped'])!=keys:return False
    initial=float(np.mean(list(before['direct'].values())));final=float(np.mean(list(after['direct'].values())));reverse=float(np.mean(list(after['swapped'].values())))
    return final<initial*.85 and initial-final>.025*box_diagonal and reverse-final>.025*box_diagonal and all(after['direct'][k]<=before['direct'][k]+.035*box_diagonal for k in keys)
