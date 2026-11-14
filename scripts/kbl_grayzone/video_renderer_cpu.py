"""1080p CPU renderer using the frozen review-1 scene and procedural court."""
from pathlib import Path
import math,cv2,numpy as np
import video_scene_context as base

PTH=Path(__file__).parent;W,H=1920,1080
texture=cv2.imread(str(PTH/'video-assets/procedural-court.png'))
if texture is None:raise RuntimeError('court texture missing')
# The texture apron has a solid outer edge. Match the surrounding infinite
# background to that edge so the projected texture never exposes a large
# rectangular or triangular floor boundary during camera movement.
BACKGROUND=tuple(int(v) for v in texture[0,0])
P=F=C=Actor=None
K=np.array(base.pose['camera']['K'],float)
R=base.R.copy();t=base.t.copy();shadow_points=[]
_verts0=_normals=_bright=_plane=None
def prepare(data,joints):
 global P,F,C,Actor,shadow_points,_verts0,_normals,_bright,_plane
 P=data['vertices'].copy();oldActor=data['actor'];keep=oldActor!='basket';F=data['faces'][keep].copy();C=data['colors'][keep].copy();Actor=oldActor[keep].copy()
 # Add thin white basketball nets and a backboard target rectangle. These are
 # illustrative FIBA-scale geometry and do not assert arena survey accuracy.
 verts=[];faces=[];colors=[]
 def wire(a,b,width=.006,color=(220,225,225)):
  a=np.array(a,float);b=np.array(b,float);v=b-a;side=np.cross(v,[0,0,1.])
  if np.linalg.norm(side)<1e-6:side=np.cross(v,[0,1.,0])
  side=side/np.linalg.norm(side)*width/2;idx=len(verts);verts.extend([a-side,a+side,b+side,b-side]);faces.extend([[idx,idx+1,idx+2],[idx,idx+2,idx+3]]);colors.extend([color,color])
 for hoop,board,back in [(1.575,1.2,-.8),(26.425,26.8,28.8)]:
  # Ring as a round orange tube, not a floating flat outline.
  first=len(verts);ringSteps=48;crossSteps=8
  for i in range(ringSteps):
   a=2*math.pi*i/ringSteps
   for j in range(crossSteps):
    b=2*math.pi*j/crossSteps;verts.append((hoop+(.225+.018*math.cos(b))*math.cos(a),7.5+(.225+.018*math.cos(b))*math.sin(a),3.05+.018*math.sin(b)))
  for i in range(ringSteps):
   for j in range(crossSteps):
    a=first+i*crossSteps+j;b=first+((i+1)%ringSteps)*crossSteps+j;c=first+((i+1)%ringSteps)*crossSteps+(j+1)%crossSteps;d=first+i*crossSteps+(j+1)%crossSteps
    faces.extend([[a,b,c],[a,c,d]]);colors.extend([(226,74,24),(226,74,24)])
  for i in range(12):
   angle=2*math.pi*i/12
   chain=[]
   for j in range(6):
    u=j/5;rad=.225*(1-u)+.12*u;ang=angle+(.13 if i%2 else -.13)*u;chain.append((hoop+rad*math.cos(ang),7.5+rad*math.sin(ang),3.045-.43*u))
   for a,b in zip(chain,chain[1:]):wire(a,b,.006)
  for j in [1,2,3,4,5]:
   u=j/5;rad=.225*(1-u)+.12*u;ring=[(hoop+rad*math.cos(a),7.5+rad*math.sin(a),3.045-.43*u) for a in np.linspace(0,2*math.pi,25)]
   for a,b in zip(ring,ring[1:]):wire(a,b,.005)
  outer=[(board,6.6,2.9),(board,8.4,2.9),(board,8.4,3.95),(board,6.6,3.95)]
  for a,b in zip(outer,outer[1:]+outer[:1]):wire(a,b,.035)
  corners=[(board,7.205,3.04),(board,7.795,3.04),(board,7.795,3.49),(board,7.205,3.49)]
  for a,b in zip(corners,corners[1:]+corners[:1]):wire(a,b,.014)
  wire((board,7.5,3.05),(hoop+(-.225 if hoop<14 else .225),7.5,3.05),.05,(200,205,210))
  wire((back,7.5,.05),(back,7.5,4.08),.13,(89,105,120));wire((back,7.5,4.08),(board,7.5,4.08),.11,(89,105,120));wire((board,7.5,4.08),(board,7.5,3.95),.08,(89,105,120))
 off=len(P);P=np.vstack([P,np.array(verts)]);F=np.vstack([F,np.array(faces,dtype=np.int64)+off]);C=np.vstack([C,np.array(colors,dtype=np.uint8)]);Actor=np.r_[Actor,np.full(len(faces),'basket')]
 # The lighting and face planes are static, avoiding recomputation per frame.
 _verts0=P[F[:,0]];normals=np.cross(P[F[:,1]]-_verts0,P[F[:,2]]-_verts0);_plane=np.einsum('ij,ij->i',normals,_verts0)
 lens=np.maximum(np.linalg.norm(normals,axis=1),1e-9);_normals=normals
 light=np.array([.25,-.35,.90]);light/=np.linalg.norm(light)
 _bright=np.clip(.73+.25*np.abs((normals@light)/lens),.55,1.)
 shadow_points=[]
 for actor,q in joints.items():
  q=np.asarray(q,float)
  for i in (15,16):shadow_points.append((q[i,0],q[i,1],max(0.,float(q[i,2]-.08))))
def project(points,R,t,K):
 q=points@R.T+t;uv=q@K.T;return uv[:,:2]/uv[:,2,None],q[:,2]

def ground_horizon_polygon(R,t,K,width=W,height=H):
 """Screen area whose camera rays meet the ground plane, with no far edge."""
 camera=-np.asarray(R,float).T@np.asarray(t,float)
 if abs(camera[2])<1e-8:return np.empty((0,2),dtype=np.int32)
 # A pixel ray has world-z component R[:,2] · K^-1 · [x,y,1].
 line=np.asarray(R,float)[:,2]@np.linalg.inv(np.asarray(K,float))
 def value(p):return camera[2]*(line[0]*p[0]+line[1]*p[1]+line[2])
 corners=[np.array(p,dtype=float) for p in ((0,0),(width-1,0),(width-1,height-1),(0,height-1))]
 out=[]
 for a,b in zip(corners,corners[1:]+corners[:1]):
  va,vb=value(a),value(b);inside_a=va<=0;inside_b=vb<=0
  if inside_a:out.append(a)
  if inside_a!=inside_b:out.append(a+(b-a)*(va/(va-vb)))
 return np.rint(out).astype(np.int32).reshape(-1,2)

def draw(outpath=None,R=R,t=t,hide=None):
 if P is None:raise RuntimeError('prepare scene first')
 im=np.full((H,W,3),BACKGROUND,np.uint8)
 def clip(points):
  q=np.asarray(points,float)@R.T+t;out=[]
  for a,b in zip(q,np.roll(q,-1,axis=0)):
   ina=a[2]>=.05;inb=b[2]>=.05
   if ina:out.append(a)
   if ina!=inb:out.append(a+(b-a)*((.05-a[2])/(b[2]-a[2])))
  if not out:return np.empty((0,2),dtype=np.int32)
  h=np.asarray(out)@K.T;return np.clip(np.rint(h[:,:2]/h[:,2,None]),-30000,30000).astype('int32')
 # Texture pixels map to (x/100-2,y/100-2,0) in the saved court frame.
 transform=np.column_stack((R[:,0]/100.,R[:,1]/100.,t-2*R[:,0]-2*R[:,1]))
 Htex=K@transform
 # The whole surround and the outer texture edge share one color, with no
 # projected edge or horizon seam outside the court apron.
 floor=clip([[-4,-3,0],[32,-3,0],[32,19,0],[-4,19,0]])
 if len(floor)>=3:
  projected=cv2.warpPerspective(texture,Htex,(W,H),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
  mask=np.zeros((H,W),np.uint8);cv2.fillConvexPoly(mask,floor,255,cv2.LINE_AA);cv2.copyTo(projected,mask,im)
  shadows=np.zeros((H,W),np.uint8)
  for x,y,height in shadow_points:
   ring=np.array([[x+.27*math.cos(a),y+.16*math.sin(a),.006] for a in np.linspace(0,2*math.pi,16)])
   uv,depth=project(ring,R,t,K)
   if np.min(depth)>.05 and np.max(np.abs(uv))<30000:
    opacity=int(65*math.exp(-height*2.5));cv2.fillConvexPoly(shadows,np.rint(uv).astype(np.int32),opacity,cv2.LINE_AA)
  shadows=cv2.GaussianBlur(shadows,(0,0),8);shadows=cv2.bitwise_and(shadows,mask);factor=(1.-shadows.astype(np.float32)/255.)[:,:,None];im=(im.astype(np.float32)*factor).astype(np.uint8)
 q=P@R.T+t;depth=q[F,2];valid=(depth.max(axis=1)>=.05)
 if hide:valid &= Actor!=hide
 # Per-pixel depth resolves intersecting meshes and clips triangles crossing
 # the near plane rather than dropping them. Both windings are retained.
 ids=np.flatnonzero(valid);colors=(C[ids]*_bright[ids,None]).astype(np.uint8)[:,::-1]
 from video_depth import draw as draw_depth
 draw_depth(im,q,F[ids],colors,K)
 if outpath:cv2.imwrite(str(outpath),im)
 return im
