"""Read only non-secret recorder segment identifiers for one authorized match."""
import json
import math
import os
import stat
from uuid import UUID

from .courtside_recording_source import recording_key

MAX_STATE_BYTES=16*1024*1024

def parts_for_match(root,match_id):
    mid=str(UUID(str(match_id)));flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    fd=os.open(root,flags);rows=[]
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                try:
                    sid=str(UUID(entry.name))
                    if sid!=entry.name or not entry.is_dir(follow_symlinks=False):continue
                    directory=os.open(entry.name,flags,dir_fd=fd)
                    try:
                        state_fd=os.open('state.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
                        with os.fdopen(state_fd,'rb') as source:
                            info=os.fstat(source.fileno())
                            if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_STATE_BYTES:continue
                            content=source.read(MAX_STATE_BYTES+1)
                            if len(content)>MAX_STATE_BYTES:continue
                            state=json.loads(content)
                    finally:os.close(directory)
                    if not isinstance(state,dict) or str(UUID(str(state.get('id'))))!=sid or str(UUID(str(state.get('match_id'))))!=mid:continue
                    raw=state.get('parts')
                    if not isinstance(raw,list):continue
                    parts=[]
                    for index,item in enumerate(raw):
                        if not isinstance(item,dict):continue
                        name=item.get('name')
                        try:
                            if recording_key(mid,sid,name)!=item.get('key'):continue
                        except ValueError:continue
                        duration=item.get('duration')
                        if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 0<duration<=300:duration=None
                        parts.append({'number':index+1,'duration':duration,'sourcePartName':name})
                    created=state.get('created_at');created=created[:64] if isinstance(created,str) else None
                    status=state.get('status');status=status[:32] if isinstance(status,str) else None
                    rows.append({'id':sid,'created_at':created,'status':status,'parts':parts})
                    if len(rows)>1000:raise OverflowError('too many recordings')
                except (OSError,ValueError,TypeError,KeyError,UnicodeError,json.JSONDecodeError):
                    continue
    finally:os.close(fd)
    return sorted(rows,key=lambda row:row.get('created_at') or '',reverse=True)
