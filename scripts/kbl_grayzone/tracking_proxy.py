"""Lossless, provenance-checked first-window transport for early selected frames.

Only use when the exact original window starts at frame zero. Any incompatibility
falls back to the original. A pending transport must never silently switch input.
"""
import hashlib, os, shutil, subprocess, uuid
from pathlib import Path


def file_sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(source, event, selected, dest):
    import cv2
    import numpy as np
    from action_window import window_frames
    source=Path(source); dest=Path(dest)
    stat=source.stat(); original=file_sha(source)
    if original != event['broadcast']['sha256']:
        raise ValueError('중계 원본 해시 불일치')
    fps=float(event['broadcast']['fps']); total=int(event['broadcast']['frames'])
    seconds=event.get('broadcastSelection',{}).get('actionWindowSeconds',12)
    first,end=window_frames(total,fps,selected,seconds)
    if first != 0 or end == total:
        return source,None
    dest.mkdir(parents=True,exist_ok=True)
    proxy=dest/'tracking-window.mp4';temp=dest/('tracking-window-'+uuid.uuid4().hex+'.mp4')
    bundled=Path(__file__).resolve().parents[2]/'runtime/kbl-cv/tools/ffmpeg'
    ffmpeg=os.environ.get('KBL_FFMPEG_PATH') or shutil.which('ffmpeg') or (str(bundled) if bundled.is_file() and os.access(bundled,os.X_OK) else None)
    if not proxy.exists() and not ffmpeg:return source,None
    try:
        # Copy encoded video packets. No video re-encoding or pixel resampling.
        if not proxy.exists():
            subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-i',str(source),'-t',str(end/fps),'-map','0:v:0','-c:v','copy','-an','-movflags','+faststart','-n',str(temp)],check=True,timeout=180,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            os.replace(temp,proxy)
        a=cv2.VideoCapture(str(source)); b=cv2.VideoCapture(str(proxy))
        try:
            if not a.isOpened() or not b.isOpened():raise ValueError('영상 디코딩 실패')
            afps=a.get(cv2.CAP_PROP_FPS);bfps=b.get(cv2.CAP_PROP_FPS);atotal=round(a.get(cv2.CAP_PROP_FRAME_COUNT)); btotal=round(b.get(cv2.CAP_PROP_FRAME_COUNT))
            if abs(afps-fps)>1e-6 or abs(bfps-fps)>1e-6 or atotal!=total or btotal!=end or window_frames(btotal,bfps,selected,seconds)!=(first,end):
                raise ValueError('추적 구간 메타데이터 불일치')
            for frame in range(first,end):
                ok,x=a.read(); ok2,y=b.read()
                if not ok or not ok2 or x.shape!=y.shape or not np.array_equal(x,y):raise ValueError(f'원본 프레임 불일치: {frame}')
        finally:
            a.release();b.release()
        if (source.stat().st_size,source.stat().st_mtime_ns)!=(stat.st_size,stat.st_mtime_ns):raise ValueError('원본이 처리 중 변경됐습니다.')
        return proxy,{'originalSha256':original,'processedSha256':file_sha(proxy),'method':'stream-copy-prefix-pixel-verified-v1','firstFrame':first,'endFrameExclusive':end}
    finally:
        if temp.exists():temp.unlink()
