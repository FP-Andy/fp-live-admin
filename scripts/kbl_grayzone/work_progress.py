"""Counted work units, never a timer-based invented percentage."""
import os,math
from pathlib import Path
from job_store import atomic,now

def update(phase,completed=None,total=None,unit=None,path=None):
    target=path or os.environ.get('KBL_PROGRESS_FILE')
    if not target:return
    row={'phase':str(phase)[:160],'updatedAt':now()}
    if type(completed) in (int,float) and type(total) in (int,float) and math.isfinite(completed) and math.isfinite(total) and total>0 and 0<=completed<=total:
        row.update(completed=completed,total=total,unit=unit or '개',percent=round(completed/total*100,1))
    atomic(Path(target),row)
