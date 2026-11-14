"""Small durable job records and process-independent leases; no inference on reads."""
import fcntl, hashlib, json, os, tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

def now():return datetime.now(timezone.utc).isoformat()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def atomic(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix=path.name+'.',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(value,f,ensure_ascii=False,separators=(',',':'),allow_nan=False);f.flush();os.fsync(f.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

@contextmanager
def lease(path):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a') as f:
        acquired=False
        try:
            try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);acquired=True
            except BlockingIOError:pass
            yield acquired
        finally:
            if acquired:fcntl.flock(f,fcntl.LOCK_UN)

def busy(path):
    with lease(path) as acquired:return not acquired

class RecoverableJobError(RuntimeError):
    """Transport interrupted; the immutable remote job can still be running."""
