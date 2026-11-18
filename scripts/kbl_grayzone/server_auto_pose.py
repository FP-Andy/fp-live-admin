"""Run the unchanged reconstruction renderer inside a private worker browser."""
import json,os,re,secrets,subprocess,threading
from contextlib import contextmanager
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
KEYS={}
LOCK=threading.Lock()

@contextmanager
def authorize(case,event,job):
    key=secrets.token_urlsafe(32)
    with LOCK:
        if (case,event) in KEYS:raise RuntimeError('이 장면의 자동 보정이 이미 진행 중입니다.')
        KEYS[(case,event)]=(job,key)
    try:yield key
    finally:
        with LOCK:KEYS.pop((case,event),None)

def permitted(case,event,job,key):
    if not isinstance(key,str):return False
    with LOCK:expected=KEYS.get((case,event))
    return bool(expected and expected[0]==job and secrets.compare_digest(expected[1],key))

def render(case,event,key):
    if not re.fullmatch(r'[a-z0-9-]+',case) or not re.fullmatch(r'review-\d+',event):raise ValueError('자동 보정 장면을 확인하세요.')
    socket=ROOT/'run/courtside.sock'
    settings={'caseId':case,'eventId':event,'key':key}
    if socket.exists():settings['socketPath']=str(socket)
    else:
        # Local-only development server. Production uses its Unix socket.
        settings['port']=int(os.environ.get('KBL_LOCAL_PORT','4350'))
    try:
        proc=subprocess.run(['node',str(ROOT/'scripts/kbl_grayzone/render_auto_pose.mjs')],input=json.dumps(settings).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=31*60)
        if proc.returncode:raise RuntimeError('서버에서 자동 자세 보정을 완료하지 못했습니다. 작업 상태를 확인하세요.')
        result=json.loads(proc.stdout)
        if not all(isinstance(result.get(k),str) and re.fullmatch('[a-f0-9]{24}',result[k]) for k in ('previousCaptureId','captureId')):raise ValueError()
        return result
    except subprocess.TimeoutExpired as exc:raise RuntimeError('자동 자세 보정 시간이 초과됐습니다.') from exc
    except (OSError,ValueError,json.JSONDecodeError) as exc:raise RuntimeError('서버 자동 보정 실행을 확인할 수 없습니다.') from exc
