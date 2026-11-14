"""Bound inference to a confirmed play, while retaining source frame numbers."""
import math
def window_frames(total,fps,selected,seconds=12):
    if type(seconds) not in (int,float) or not math.isfinite(seconds) or not 2<=seconds<=30:raise ValueError('플레이 추적 길이는 2~30초로 지정하세요.')
    if total<1 or not 0<=selected<total:raise ValueError('선택 프레임 범위를 확인하세요.')
    length=min(total,max(1,round(seconds*fps)))
    first=max(0,min(total-length,selected-length//2))
    return first,first+length
