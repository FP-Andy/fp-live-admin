"""Bounded, codec-independent stills. Originals and analysis data are never changed."""
import subprocess
from collections import OrderedDict
from threading import BoundedSemaphore, Lock
from fastapi import HTTPException

_slots=BoundedSemaphore(2)
_lock=Lock()
_cache=OrderedDict()

def extract_frame(upload_id,seconds,url_factory):
    key=(upload_id,round(seconds,3))
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    if not _slots.acquire(timeout=2):raise HTTPException(503,'교체 장면을 준비 중입니다. 잠시 후 다시 시도하세요.')
    try:
        url=url_factory()
        result=subprocess.run(['ffmpeg','-nostdin','-v','error','-threads','1','-ss',str(key[1]),'-i',url,
            '-frames:v','1','-vf','scale=1280:-2','-threads','1','-an','-sn','-dn','-f','image2pipe','-vcodec','mjpeg','pipe:1'],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35,check=False)
        data=result.stdout
        if result.returncode or not data.startswith(b'\xff\xd8') or len(data)>4*1024*1024:
            raise HTTPException(502,'이 시각의 교체 장면을 추출하지 못했습니다. 시각과 영상을 확인하세요.')
        with _lock:
            _cache[key]=data
            while len(_cache)>32:_cache.popitem(last=False)
        return data
    except (subprocess.TimeoutExpired,OSError):
        # Never expose decoder stderr or signed object URLs to the browser.
        raise HTTPException(503,'교체 장면 추출이 지연됐습니다. 잠시 후 다시 시도하세요.')
    finally:_slots.release()
