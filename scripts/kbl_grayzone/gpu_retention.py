"""Reclaim T4 duplicates only after an old result is verified on the app store."""
import base64, datetime, hashlib, json, logging, re, shlex, threading, time
from pathlib import Path
from contextlib import ExitStack
from job_store import lease

ROOT = Path(__file__).resolve().parents[2]
MIN_AGE_SECONDS = 48 * 60 * 60
INTERVAL_SECONDS = 60 * 60
MAX_CANDIDATES = 30
_LOCK = threading.Lock()
_last_started = 0.0
_running = False

# Runs only under the worker and per-dispatch locks on the remote T4. Preserve
# metadata; erase large, reproducible duplicate files only after both copies of
# the result archive have identical SHA-256. Never follow symlinks.
REMOTE = r'''import fcntl, hashlib, json, os, pathlib, re, shutil, sys
root=pathlib.Path(sys.argv[1]); items=json.loads(sys.argv[2]); removed=[]
lock=root/'worker.lock'
if lock.is_symlink(): sys.exit(1)
with lock.open('a') as worker:
 try: fcntl.flock(worker,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:
  print(json.dumps({'cleanedJobs':[]})); sys.exit(0)
 for item in items:
  job=item['job']; sha=item['sha256']
  if not re.fullmatch(r'[a-f0-9]{24}',job) or not re.fullmatch(r'[a-f0-9]{64}',sha): continue
  folder=root/'jobs'/job
  if folder.is_symlink() or not folder.is_dir(): continue
  dispatch=folder/'dispatch.lock'
  if dispatch.is_symlink(): continue
  with dispatch.open('a') as held:
   try: fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError: continue
   phase=folder/'phase'; archive=folder/'result.tar'; marker=folder/'retention-cleaned.sha256'
   if marker.is_file() and not marker.is_symlink() and marker.read_text().strip()==sha:
    removed.append(job); continue
   if phase.is_symlink() or archive.is_symlink() or not phase.is_file() or not archive.is_file(): continue
   if phase.read_text().strip()!='complete': continue
   digest=hashlib.sha256()
   with archive.open('rb') as f:
    for block in iter(lambda:f.read(1024*1024),b''): digest.update(block)
   if digest.hexdigest()!=sha: continue
   for name in ('tracks.json','court-raw.json','result.json','meshes.json','frame.jpg','fitted.json','wide-result.json','wide-frame.jpg','reuse-cache.tar.gz','worker-code.tar.gz'):
    p=folder/name
    if not p.is_symlink() and p.is_file(): p.unlink()
   for p in (folder/'profiles',root/'outputs'/'kbl-pose-frames'/job,root/'outputs'/'kbl-pose-cache'/job):
    if not p.is_symlink() and p.is_dir():
     try: shutil.rmtree(p)
     except OSError: pass
   marker.write_text(sha+'\n')
   archive.unlink()
   removed.append(job)
print(json.dumps({'cleanedJobs':removed}))
'''


# Limit expensive local verification to jobs that still have a remote copy.
# Historical app records may outlive a previous manual T4 cleanup.
REMOTE_LIST = r'''import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1])/'jobs'; jobs=[]
if root.is_dir() and not root.is_symlink():
 for folder in root.iterdir():
  if folder.is_symlink() or not folder.is_dir() or not re.fullmatch(r'[a-f0-9]{24}',folder.name): continue
  phase=folder/'phase'; archive=folder/'result.tar'; marker=folder/'retention-cleaned.sha256'
  try:
   if not phase.is_symlink() and phase.is_file() and phase.read_text().strip()=='complete' and ((archive.is_file() and not archive.is_symlink()) or (marker.is_file() and not marker.is_symlink())): jobs.append(folder.name)
  except OSError: pass
print(json.dumps(jobs))
'''

def remote_command(code, *args):
    encoded=base64.b64encode(code.encode()).decode('ascii')
    return shlex.join(['python3','-c',f'import base64;exec(base64.b64decode({encoded!r}))',*args])

def candidates(root=ROOT, clock=None):
    """Yield old, local completion records; caller holds their transport locks."""
    outputs = root / 'outputs'
    yield from (outputs / 'kbl-pose-frames').glob('*/transport.json')
    yield from (outputs / 'kbl-cases').glob('*/gpu-jobs/*/transport.json')
    yield from (outputs / 'kbl-cases').glob('*/multiview/**/transport.json')

def verified(ticket_path, clock=None):
    try:
        if ticket_path.is_symlink() or ticket_path.parent.is_symlink(): return None
        ticket = json.loads(ticket_path.read_text())
        job, expected = ticket.get('jobId'), ticket.get('artifacts', {}).get('gpu-result.tar')
        if ticket.get('state') != 'complete' or not isinstance(job,str) or not re.fullmatch('[a-f0-9]{24}',job): return None
        if not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected): return None
        completed = datetime.datetime.fromisoformat(ticket['completedAt'].replace('Z','+00:00'))
        if completed.tzinfo is None: return None
        if (time.time() if clock is None else clock) - completed.timestamp() < MIN_AGE_SECONDS: return None
        marker = ticket_path.parent / 't4-retention.json'
        if marker.is_file() and not marker.is_symlink():
            data=json.loads(marker.read_text())
            if data.get('jobId')==job and data.get('sha256')==expected:return None
        archive = ticket_path.parent / 'gpu-result.tar'
        if archive.is_symlink() or not archive.is_file(): return None
        digest=hashlib.sha256()
        with archive.open('rb') as f:
            for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
        if digest.hexdigest()!=expected:return None
        return {'job':job,'sha256':expected}
    except (OSError,ValueError,TypeError,KeyError):return None

def cleanup(config, root=ROOT, clock=None):
    import gpu_bridge
    if not isinstance(config.get('workspace'),str) or not config['workspace'].startswith('/') or '..' in Path(config['workspace']).parts:
        raise ValueError('T4 작업 경로가 올바르지 않습니다.')
    available=set(json.loads(gpu_bridge.ssh(config,remote_command(REMOTE_LIST,config['workspace']),timeout=30)))
    if not available:return {'eligible':0}
    items=[]
    with ExitStack() as stack:
        for path in candidates(root,clock):
            if len(items)>=MAX_CANDIDATES:break
            try:
                initial=verified(path,clock)
                if not initial or initial['job'] not in available:continue
                if not stack.enter_context(lease(path.parent/'transport.lock')):continue
                item=verified(path,clock)
                if item:items.append((item,path))
            except OSError:continue
        if not items:return {'eligible':0}
        command=remote_command(REMOTE,config['workspace'],json.dumps([item for item,_ in items],separators=(',',':')))
        result=gpu_bridge.ssh(config,command,timeout=90)
        data=json.loads(result)
        from job_store import atomic
        for item,path in items:
            if item['job'] in data.get('cleanedJobs',[]):
                atomic(path.parent/'t4-retention.json',{'jobId':item['job'],'sha256':item['sha256']})
        return {'eligible':len(items),'cleaned':len(data.get('cleanedJobs',[]))}

def request_cleanup(config):
    """Run off the production path, at most once an hour per worker process."""
    global _running,_last_started
    with _LOCK:
        now=time.monotonic()
        if _running or (_last_started and now-_last_started<INTERVAL_SECONDS):return
        _running=True;_last_started=now
    def run():
        global _running
        try:cleanup(config)
        except Exception:logging.getLogger(__name__).exception('T4 duplicate cleanup skipped')
        finally:
            with _LOCK:_running=False
    threading.Thread(target=run,name='kbl-t4-retention',daemon=True).start()
