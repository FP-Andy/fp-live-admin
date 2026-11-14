"""Reviewer arm targets in body axes, relative to shoulder; not measured pose.

Project onto rig bone lengths and conservative prototype hinge/twist limits.
The browser preview implements the same projection, tested against this solver.
"""
import math
import numpy as np

def unit(v):
    v=np.asarray(v,dtype=float);n=np.linalg.norm(v)
    if n<1e-8:raise ValueError('팔 관절이 겹칩니다. 팔꿈치와 손목을 분리하세요.')
    return v/n

def rotate(v,axis,angle):
    axis=unit(axis);v=np.asarray(v)
    return v*math.cos(angle)+np.cross(axis,v)*math.sin(angle)+axis*np.dot(axis,v)*(1-math.cos(angle))

def swing(v,a,b):
    dot=float(np.clip(np.dot(a,b),-1,1))
    if dot>1-1e-10:return np.asarray(v)
    axis=np.cross(a,b)
    if dot< -1+1e-10:
        basis=np.zeros(3);basis[int(np.argmin(np.abs(a)))]=1;axis=np.cross(a,basis)
    return rotate(v,axis,math.acos(dot))

def solve_arm(target,rig):
    u=unit(target['elbow']);e=u*rig['upperLength'];v=unit(np.asarray(target['wrist'])-e)
    a=unit(rig['neutralUpper']);b=unit(rig['neutralLower']);pole=unit(swing(unit(np.cross(a,b)),a,u))
    bend=math.acos(float(np.clip(np.dot(u,v),-1,1)));raw_bend=bend
    bend=min(bend,math.radians(145));desired=unit(np.cross(u,v)) if raw_bend>=math.radians(8) else pole
    twist=math.atan2(float(np.dot(u,np.cross(pole,desired))),float(np.dot(pole,desired)));raw_twist=twist
    twist=max(-math.radians(110),min(math.radians(110),twist));hinge=rotate(pole,u,twist)
    v=rotate(u,hinge,bend);w=e+v*rig['lowerLength']
    return dict(elbow=e.tolist(),wrist=w.tolist(),upper=u.tolist(),lower=v.tolist(),
        limited=raw_bend>math.radians(145)+1e-7 or abs(raw_twist)>math.radians(110)+1e-7,
        flexionDegrees=math.degrees(bend),twistDegrees=math.degrees(twist))
