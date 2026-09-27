"""Compact RGB samples for overhead footage, independent of team colours.

Keep several colours (rather than a mean) so shirt stripes, shadows and pitch
background can be distinguished after the operator picks the five uniforms.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path


def appearance(frame, box):
    import numpy as np
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2-x1, y2-y1
    # Image-up is not anatomical-up in a top-down camera. Sample the inset
    # silhouette in every direction, then remove local background colour mass.
    left, right = max(0, int((x1+.06*bw)*w)), min(w, int((x2-.06*bw)*w))
    top, bottom = max(0, int((y1+.06*bh)*h)), min(h, int((y2-.06*bh)*h))
    if right <= left or bottom <= top:
        return []
    pixels = frame[top:bottom, left:right, ::-1].reshape(-1, 3).astype(np.int32)
    keys = (pixels[:, 0]//32)*64 + (pixels[:, 1]//32)*8 + pixels[:, 2]//32
    bins, counts = np.unique(keys, return_counts=True)
    means=np.array([pixels[keys==key].mean(axis=0) for key in bins])
    weights=counts.astype(float)/len(pixels)
    # Estimate local pitch/background in a ring outside the entire person box.
    # Subtract shared colour mass before ranking: bright green keeper shirts
    # must not win merely because every crop also contains a green pitch.
    ex1,ex2=max(0,int((x1-.35*bw)*w)),min(w,int((x2+.35*bw)*w))
    ey1,ey2=max(0,int((y1-.25*bh)*h)),min(h,int((y2+.25*bh)*h))
    ring=frame[ey1:ey2,ex1:ex2,::-1]
    mask=np.ones(ring.shape[:2],dtype=bool)
    mask[max(0,int(y1*h)-ey1):min(ey2-ey1,int(y2*h)-ey1),max(0,int(x1*w)-ex1):min(ex2-ex1,int(x2*w)-ex1)]=False
    background=ring[mask].astype(np.int32)
    if len(background):
        bgkeys=(background[:,0]//32)*64+(background[:,1]//32)*8+background[:,2]//32
        histogram=np.bincount(bgkeys,minlength=512)/len(background)
        weights=np.maximum(0,weights-histogram[bins])
        # RGB-bin boundaries must not turn slightly different shades of nearby
        # grass into a keeper shirt. Suppress residual bins near dominant ring
        # colours; bright keeper cloth remains far from the darker grass.
        dominant=np.flatnonzero(histogram>=.015)
        if len(dominant):
            bgmeans=np.array([background[bgkeys==key].mean(axis=0) for key in dominant])
            nearby=np.min(np.linalg.norm(means[:,None,:]-bgmeans[None,:,:],axis=2),axis=1)<32
            weights[nearby]*=.08
        if weights.sum()<.04:
            return []
        weights/=weights.sum()
    saturation=(means.max(axis=1)-means.min(axis=1))/np.maximum(1,means.max(axis=1))
    # Keep neutral uniforms, but prevent black shorts and white court paint
    # from crowding all coloured shirt bins out of the compact descriptor.
    weights*=.35+.65*saturation
    if weights.sum():
        weights/=weights.sum()
    order=np.argsort(-weights)[:12]
    return [{"rgb": np.rint(means[i]).astype(int).tolist(),
             "weight": round(float(weights[i]), 5)} for i in order if weights[i]>.00001]


def enrich(run: Path, video: Path | None = None):
    """Add appearance to an existing run without changing its UUID or track IDs."""
    import cv2
    path = run / "tracks.json"
    original = path.read_text()
    data = json.loads(original)
    source = video or run / "preview.mp4"
    offset = 0 if video else data["video"]["clipStart"]
    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        raise ValueError(f"Cannot open {source}")
    try:
        for i, entry in enumerate(data["frames"]):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0, entry["t"]-offset)*1000)
            ok, frame = cap.read()
            if not ok:
                raise ValueError(f"Cannot read frame at {entry['t']}; original unchanged")
            for box in entry["boxes"]:
                box["appearance"] = appearance(frame, box["box"])
            if i % 100 == 0:
                print(f"Colour samples: {i+1}/{len(data['frames'])}", flush=True)
    finally:
        cap.release()
    data["detector"]["appearance"] = "overhead-rgb12-local-background/v3"
    backup = run / "tracks.before-colors-v3.json"
    if not backup.exists():
        backup.write_text(original)
    temp = run / "tracks.colors.tmp"
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    temp.replace(path)
    print(f"Saved colour samples, preserved run/track IDs: {path}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--video", type=Path, help="Original video; otherwise use run/preview.mp4")
    args = parser.parse_args()
    enrich(args.run, args.video)
