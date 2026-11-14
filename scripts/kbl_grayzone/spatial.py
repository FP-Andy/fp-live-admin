"""The same nine-anchor court warp as geometry.mjs, for pre-tracker ROI gates."""
import math
import numpy as np

def basis(t): return np.array([2*(t-.5)*(t-1),4*t*(1-t),2*t*(t-.5)])
def project(x,y,anchors):
    return np.einsum("i,j,jik->k",basis(x/28),basis(y/15),np.asarray(anchors).reshape(3,3,2))
def unproject(px,py,anchors):
    x,y=14.,7.5
    for _ in range(18):
        p=project(x,y,anchors)
        jac=np.column_stack([(project(x+.01,y,anchors)-p)/.01,(project(x,y+.01,anchors)-p)/.01])
        if abs(np.linalg.det(jac))<1e-9:return None
        error=np.array([px,py])-p
        dx,dy=np.linalg.solve(jac,error);x+=np.clip(dx,-15,15);y+=np.clip(dy,-10,10)
        if np.linalg.norm(error)<.05:return [float(x),float(y)]
    return None
def boundary(anchors,margin=0):
    points=[]
    for x in np.linspace(-margin,28+margin,65):points.append(project(x,-margin,anchors))
    for y in np.linspace(-margin,15+margin,40)[1:]:points.append(project(28+margin,y,anchors))
    for x in np.linspace(28+margin,-margin,65)[1:]:points.append(project(x,15+margin,anchors))
    for y in np.linspace(15+margin,-margin,40)[1:]:points.append(project(-margin,y,anchors))
    return np.asarray(points,dtype=np.float32)
def valid_anchors(anchors):
    a=np.asarray(anchors,dtype=float)
    if a.shape!=(9,2) or not np.isfinite(a).all() or (a<0).any() or (a[:,0]>1920).any() or (a[:,1]>1080).any():return False
    for x in np.linspace(0,28,9):
        for y in np.linspace(0,15,9):
            p=project(x,y,a);jac=np.column_stack([(project(x+.01,y,a)-p)/.01,(project(x,y+.01,a)-p)/.01])
            if np.linalg.det(jac)<1:return False
    return True
