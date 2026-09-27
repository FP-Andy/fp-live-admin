"""Conservative pre-association suppression; never cap the people count.

Reject only a new, contained observation on an established person. An existing
independent track wins protection, including people in a duel. Weak-colour
attached shadows and near-identical duplicate detections are candidates;
detached shadows cannot be reliably removed by this model-free filter.
"""
import numpy as np


def overlap(a, b):
    area_a = max(0, a[2]-a[0])*max(0, a[3]-a[1])
    area_b = max(0, b[2]-b[0])*max(0, b[3]-b[1])
    intersection = max(0, min(a[2],b[2])-max(a[0],b[0]))*max(0, min(a[3],b[3])-max(a[1],b[1]))
    return intersection/max(1e-9, min(area_a, area_b)), min(area_a, area_b)/max(1e-9, max(area_a, area_b))


def suppress_new_duplicates(detections, appearances, colors, established):
    """Return kept indices and audit reasons, preserving detector provenance.

    `established` contains independently tracked boxes in the same pixel system.
    A new detection near two existing players is ambiguous and is kept.
    """
    xyxy=np.asarray(detections.xyxy)
    owners=[]
    for box in xyxy:
        candidates=[(i,overlap(box,old)[0]) for i,old in enumerate(established)]
        owners.append([i for i,score in candidates if score>.65])
    removed={}
    for i,box in enumerate(xyxy):
        if len(owners[i])!=1: continue
        for j,body in enumerate(xyxy):
            if i==j or j in removed or owners[j]!=owners[i]: continue
            coverage,ratio=overlap(box,body)
            # Preserve whichever detection best fits the previous body. A larger
            # shadow-inclusive box must not win just because it has more area.
            old=established[owners[i][0]]
            def fit(b):
                cov,r=overlap(b,old)
                return cov*r
            if fit(body)<=fit(box)+.05: continue
            a,b=colors[i],colors[j]
            same=a.get('group') and a.get('group')==b.get('group')
            shadow=a.get('strength',0)<.045 and b.get('group') and b.get('strength',0)>=.15
            identical=coverage>.9 and ratio>.75 and same
            attached_shadow=coverage>.75 and shadow
            area=lambda b: (b[2]-b[0])*(b[3]-b[1])
            expanded_attachment=coverage>.9 and .2<ratio<.72 and area(box)>area(body) and same and a.get('strength',0)<.7*b.get('strength',0)
            if identical or attached_shadow or expanded_attachment:
                removed[i]='attached-shadow' if attached_shadow else 'expanded-attachment' if expanded_attachment else 'duplicate-body'
                break
    return [i for i in range(len(xyxy)) if i not in removed],removed
