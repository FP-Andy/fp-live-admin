"""Python equivalent of the review UI's colors.mjs classifier.

The operator supplies every palette; no kit colors or video-specific rules are
embedded here. Scores are heuristic evidence, not identity probabilities.
"""
from functools import lru_cache
import json
import math
from pathlib import Path

GROUPS = ('home_gk', 'home', 'referee', 'away', 'away_gk')


@lru_cache(maxsize=8192)
def rgb_to_lab(rgb):
    r,g,b = [v/255/12.92 if v/255<=.04045 else ((v/255+.055)/1.055)**2.4 for v in rgb]
    f = lambda v: math.cbrt(v) if v>.008856 else 7.787*v+16/116
    x=f((.4124564*r+.3575761*g+.1804375*b)/.95047)
    y=f(.2126729*r+.7151522*g+.072175*b)
    z=f((.0193339*r+.119192*g+.9503041*b)/1.08883)
    return 116*y-16,500*(x-y),200*(y-z)


def uniform_distance(a,b):
    x,y=rgb_to_lab(tuple(a)),rgb_to_lab(tuple(b))
    cx,cy=math.hypot(x[1],x[2]),math.hypot(y[1],y[2])
    saturation=lambda rgb:(max(rgb)-min(rgb))/(max(rgb) or 1)
    if cx<18 or cy<18 or saturation(a)<.30 or saturation(b)<.30:
        return math.hypot((x[0]-y[0])*.5,x[1]-y[1],x[2]-y[2])
    return math.hypot(55*(x[1]/cx-y[1]/cy),55*(x[2]/cx-y[2]/cy),.20*(x[0]-y[0]),.15*(cx-cy))


def validate_uniforms(uniforms):
    if not isinstance(uniforms,dict) or set(uniforms)!=set(GROUPS):
        raise ValueError('Uniforms must contain home_gk, home, referee, away, away_gk')
    for samples in uniforms.values():
        if not isinstance(samples,list) or len(samples)>8:
            raise ValueError('Each uniform group accepts at most eight RGB samples')
        for rgb in samples:
            if not isinstance(rgb,list) or len(rgb)!=3 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=255 for v in rgb):
                raise ValueError('Uniform samples must be RGB triples in [0,255]')
    return uniforms


def load_uniforms(path):
    data=json.loads(Path(path).read_text())
    uniforms=validate_uniforms(data.get('uniforms',data))
    if not any(uniforms.values()):
        raise ValueError('Pick uniform colors in the review UI before retracking')
    return uniforms


def classify_uniform(appearance,uniforms):
    if not appearance:
        return {'group':None,'strength':0,'margin':0,'scores':{}}
    scores={group:sum(p['weight']*max(0,1-min(uniform_distance(p['rgb'],rgb) for rgb in samples)/32)**2 for p in appearance) if samples else 0 for group,samples in uniforms.items()}
    ranked=sorted(scores.items(),key=lambda row:-row[1])
    group,strength=ranked[0] if ranked else (None,0)
    second=ranked[1][1] if len(ranked)>1 else 0
    margin=(strength-second)/strength if strength>0 else 0
    return {'group':group if strength>=.10 and margin>=.28 else None,
            'strength':strength,'margin':margin,'scores':scores}


def observed_team(appearance,uniforms):
    return uniform_team(classify_uniform(appearance,uniforms))


def uniform_team(result):
    """Reuse the classification already computed for duplicate suppression."""
    if result['margin']<.4:
        return 0
    return {'home':1,'home_gk':1,'away':2,'away_gk':2}.get(result['group'],0)
