"""Copyable support evidence without credentials, request bodies, or local variables."""
import re,traceback,uuid
from pathlib import Path
from urllib.parse import urlsplit
from job_store import atomic,now
ROOT=Path(__file__).resolve().parents[2]
def safe(value):
    text=str(value)[:8000]
    text=re.sub(r'(?i)Bearer\s+[^\s\"\']+','Bearer [REDACTED]',text)
    text=re.sub(r'''(?i)((?:api[_-]?key|token|password|authorization|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&},]+)''',r'\1"[REDACTED]"',text)
    text=re.sub(r'\b(?:rf_[A-Za-z0-9]{15,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b','[REDACTED]',text)
    return text

def record(handler,message,exc=None):
    item={'errorId':uuid.uuid4().hex[:16],'at':now(),'method':getattr(handler,'command','POST'),'endpoint':urlsplit(handler.path).path,'message':safe(message)}
    if exc:
        item['exceptionType']=type(exc).__name__
        item['trace']=[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(exc.__traceback__)[-12:]]
    atomic(ROOT/'outputs/kbl-diagnostics'/(item['errorId']+'.json'),item)
    return item
