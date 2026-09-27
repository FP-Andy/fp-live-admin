"""Persistent local/S3 uploads and single-GPU tracking queue."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = {'queued', 'starting', 'running', 'cancelling'}
MAX_UPLOAD = 20 * 1024**3
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'}


class JobError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def atomic_json(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temp.replace(path)


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None


def options_for(value):
    if not isinstance(value, dict):
        raise JobError('분석 설정을 확인하세요.')
    def number(key, default):
        item = value.get(key, default)
        if isinstance(item, bool) or not isinstance(item, (float, int)) or not math.isfinite(item):
            raise JobError('분석 시각은 유효한 숫자여야 합니다.')
        return float(item)
    start, duration = number('start', 0), number('duration', 0)
    if start < 0 or duration < 0:
        raise JobError('분석 시작과 길이는 0 이상이어야 합니다.')
    device = value.get('device', 'gpu')
    if device not in {'gpu', 'cpu'}:
        raise JobError('처리 장치를 확인하세요.')
    roi = value.get('roi')
    if roi is not None:
        if not isinstance(roi, list) or not 3 <= len(roi) <= 12:
            raise JobError('코트 범위는 3–12개의 꼭짓점이 필요합니다.')
        for point in roi:
            if not isinstance(point, list) or len(point) != 2 or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or not 0 <= n <= 1 for n in point):
                raise JobError('코트 좌표를 확인하세요.')
        crosses = [(roi[(i+1)%len(roi)][0]-p[0])*(roi[(i+2)%len(roi)][1]-roi[(i+1)%len(roi)][1])-(roi[(i+1)%len(roi)][1]-p[1])*(roi[(i+2)%len(roi)][0]-roi[(i+1)%len(roi)][0]) for i,p in enumerate(roi)]
        if not (all(v > 1e-6 for v in crosses) or all(v < -1e-6 for v in crosses)):
            raise JobError('코트 꼭짓점을 테두리 순서대로 지정하세요.')
    return {'start': start, 'duration': duration, 'device': device, 'roi': roi}


class TrackingJobs:
    def __init__(self, root, python=None, *, probe=True, start_worker=True, storage=None):
        self.storage = storage
        if self.storage is None and os.getenv('FPA_CV_S3_BUCKET'):
            try:
                from fpa_cv_storage import storage as configured_storage
            except ImportError:
                sys.path.insert(0, str(ROOT/'apps/api'))
                from app.fpa_cv_storage import storage as configured_storage
            self.storage = configured_storage()
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root/'uploads').mkdir(exist_ok=True)
        (self.root/'jobs').mkdir(exist_ok=True)
        self.python = python or sys.executable
        self.model = ROOT/'runtime/fpa-cv/yolo26s.pt'
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.jobs = {}
        self.queue = deque()
        self.process = None
        self.active_id = None
        self.closing = False
        try:
            self.legacy_deletions=json.loads((self.root/'list-state.json').read_text())
            if not isinstance(self.legacy_deletions,dict):self.legacy_deletions={}
        except (OSError,ValueError):self.legacy_deletions={}
        self.capability = {'checking': True, 'ready': False, 'gpu': None, 'gpuLabel': None, 'model': 'YOLO26s', 'maxUploadBytes': MAX_UPLOAD}
        for path in (self.root/'jobs').glob('*/job.json'):
            try:
                job = json.loads(path.read_text())
                if not valid_id(job.get('id')) or path.parent.name != job['id']:
                    continue
                if job['status'] in ACTIVE - {'queued'}:
                    job.update(status='interrupted', error='서버가 종료되어 분석이 중단되었습니다. 재시도할 수 있습니다.', finishedAt=time.time())
                    atomic_json(path, job)
                self.jobs[job['id']] = job
            except (ValueError, KeyError, OSError):
                continue
        self.queue.extend(j['id'] for j in sorted(self.jobs.values(),key=lambda x:x.get('createdAt',0)) if j['status']=='queued' and not j.get('deletedAt'))
        self.worker = None
        if start_worker:
            self.worker = threading.Thread(target=self._work, daemon=True, name='fpa-tracking')
            self.worker.start()
        if probe:
            threading.Thread(target=self._probe, daemon=True, name='fpa-gpu-probe').start()

    def env(self):
        env = os.environ.copy()
        env['PYTHONPATH'] = str(ROOT/'runtime/fpa-cv/packages') + os.pathsep + env.get('PYTHONPATH', '')
        env['YOLO_CONFIG_DIR'] = str(self.root/'config')
        env['MPLCONFIGDIR'] = str(self.root/'matplotlib')
        env['PYTHONUNBUFFERED'] = '1'
        return env

    def _probe(self):
        code = "import json,torch,cv2,ultralytics,lap; gpu='mps' if torch.backends.mps.is_available() else '0' if torch.cuda.is_available() else None; print('FPA_CAP '+json.dumps({'gpu':gpu,'gpuLabel':'Apple GPU · MPS' if gpu=='mps' else torch.cuda.get_device_name(0) if gpu else None}))"
        try:
            result = subprocess.run([self.python, '-c', code], cwd=ROOT, env=self.env(), capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr else 'CV 라이브러리를 불러오지 못했습니다.')
            result = json.loads(next(line.removeprefix('FPA_CAP ') for line in result.stdout.splitlines() if line.startswith('FPA_CAP ')))
            if not self.model.is_file():
                raise RuntimeError('기존 YOLO26s 가중치(runtime/fpa-cv/yolo26s.pt)가 필요합니다.')
            with self.lock:
                self.capability.update(result, ready=True, checking=False)
        except Exception as error:
            with self.lock:
                self.capability.update(checking=False, ready=False, error=str(error))

    def capabilities(self):
        with self.lock:
            return deepcopy(self.capability)

    def receive_upload(self, stream, size, name):
        if not isinstance(size, int) or not 0 < size <= MAX_UPLOAD:
            raise JobError('영상은 20GB 이하로 선택하세요.', 413)
        name = str(name).replace('\\', '/').split('/')[-1]
        name = re.sub(r'[\x00-\x1f\x7f]', '', name).strip()[:180]
        if Path(name).suffix.lower() not in VIDEO_EXTENSIONS:
            raise JobError('MP4, MOV, M4V, AVI, MKV 또는 WebM 영상을 선택하세요.')
        if shutil.disk_usage(self.root).free < size + 512*1024**2:
            raise JobError('영상을 저장할 디스크 공간이 부족합니다.', 507)
        upload_id = uuid.uuid4().hex
        folder = self.root/'uploads'/upload_id
        folder.mkdir()
        part = folder/'upload.part'
        try:
            remaining = size
            with part.open('wb') as out:
                while remaining:
                    chunk = stream.read(min(1024*1024, remaining))
                    if not chunk:
                        raise JobError('영상 전송이 중단되었습니다.')
                    out.write(chunk)
                    remaining -= len(chunk)
            filename = 'source' + Path(name).suffix.lower()
            part.replace(folder/filename)
            info = {'id': upload_id, 'name': name, 'size': size, 'file': filename, 'createdAt': time.time()}
            atomic_json(folder/'upload.json', info)
            return {k: info[k] for k in ('id','name','size')}
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def _upload(self, upload_id):
        if not valid_id(upload_id):
            raise JobError('업로드한 영상을 찾지 못했습니다.', 404)
        folder = self.root/'uploads'/upload_id
        try:
            info = json.loads((folder/'upload.json').read_text())
            source = folder/info['file']
            if source.parent != folder or (not source.is_file() and info.get('storage')!='s3'):
                raise OSError()
            return info, source
        except (OSError, ValueError, KeyError):
            raise JobError('업로드한 영상을 찾지 못했습니다.', 404)

    def register_upload(self, value):
        uid=value.get('id');name=value.get('file');size=value.get('size')
        if not valid_id(uid) or not isinstance(name,str) or not re.fullmatch(r'source\.(mp4|mov|m4v|avi|mkv|webm)',name) or type(size) is not int or not 0<size<=MAX_UPLOAD:
            raise JobError('Invalid S3 upload')
        if value.get('key')!=f'fpa-cv/uploads/{uid}/{name}' or value.get('storage')!='s3' or not self.storage:
            raise JobError('S3 upload storage is not configured')
        if self.storage.head(value['key'])['ContentLength']!=size:raise JobError('S3 video size mismatch')
        with self.lock:
            folder=self.root/'uploads'/uid;folder.mkdir(exist_ok=True)
            path=folder/'upload.json'
            if path.exists():
                previous=json.loads(path.read_text())
                if any(previous.get(k)!=value.get(k) for k in ('key','file','size')):raise JobError('Upload metadata conflict',409)
            else:atomic_json(path,value)
        return {'id':uid}

    def remove_upload(self, uid):
        with self.lock:
            peers=[j for j in self.jobs.values() if j.get('uploadId')==uid]
            if any(j.get('kind')!='preparation' or j['status'] in ACTIVE for j in peers):raise JobError('이 영상을 사용하는 분석이 있습니다.',409)
            for job in peers:
                for key in job.get('s3Assets',{}).values():self.storage.delete(key)
                shutil.rmtree(self.root/'jobs'/job['id']);del self.jobs[job['id']]
            self.queue = deque(key for key in self.queue if key in self.jobs)
            shutil.rmtree(self.root/'uploads'/uid,ignore_errors=True)
        return {'removed':True}

    def start(self, job_id):
        with self.condition:
            self.get(job_id);job=self.jobs[job_id]
            if job['status'] in ACTIVE:return self.public(job)
            if job['status']!='ready' or job.get('deletedAt'):raise JobError('초기 설정 완료 상태에서 분석을 시작하세요.',409)
            job.update(status='queued',stage='대기 중');self._save(job)
            self.queue.append(job_id);self.condition.notify()
            return self.public(job)

    def start_batch(self, ids):
        if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(not valid_id(uid) for uid in ids) or len(set(ids))!=len(ids):raise JobError('분석 목록을 확인하세요.')
        with self.condition:
            jobs=[self.get(uid) for uid in ids]
            if any(j.get('deletedAt') or j['status'] not in {'ready','queued','starting','running','completed'} for j in jobs):raise JobError('분석 준비 상태를 확인하세요.',409)
            return {'jobs':[self.start(j['id']) if j['status']=='ready' else j for j in jobs]}

    def _archive(self, job, info, output, names):
        if info.get('storage')!='s3':return
        assets={name:f"fpa-cv/jobs/{job['id']}/{name}" for name in names}
        with self.lock:
            job.update(stage='S3 결과 저장 중',progress=98,eta=None,storage='s3',s3Assets=assets)
            self._save(job)
        for name in names:
            if self.closing or job['status']=='cancelling':raise RuntimeError('결과 저장 중단')
            key=assets[name]
            mime='application/json' if name.endswith('.json') else 'image/png' if name.endswith('.png') else 'video/mp4'
            self.storage.upload(output/name,key,mime)
        # Keep small initialization artifacts needed for retracking. Original
        # and heavy result files are durable in S3 before releasing disk space.
        for name in ('tracks.json','preview.mp4'):
            if name in assets:(output/name).unlink()

    def create_preparation(self, upload_id, value):
        settings=options_for({'start':value.get('time'), 'device':value.get('device','gpu')})
        return self._enqueue(upload_id,settings,'preparation')

    def create(self, upload_id, value):
        from fpa_cv_initial import validate_initial
        settings = options_for(value)
        if not settings['roi'] or len(settings['roi'])!=4:
            raise JobError('영상에서 코트 네 꼭짓점을 지정하세요.')
        seed=value.get('setup')
        if not isinstance(seed,dict):raise JobError('유니폼과 13명의 초기 설정이 필요합니다.')
        prepared=self.get(seed.get('preparationId'))
        if prepared.get('kind')!='preparation' or prepared['status']!='completed' or prepared['uploadId']!=upload_id:
            raise JobError('이 영상의 초기 장면을 다시 검출하세요.')
        snapshot=json.loads((self.root/'jobs'/prepared['id']/'output/detections.json').read_text())
        try: settings['setup']=validate_initial(seed,snapshot)
        except (ValueError,KeyError,TypeError) as error:raise JobError(str(error))
        end=min(snapshot['duration'],settings['start']+settings['duration']) if settings['duration'] else snapshot['duration']
        if not settings['start']<=snapshot['time']<end:
            raise JobError('초기 설정 장면이 분석 구간 안에 있어야 합니다.')
        # The operator's server-decoded frame is the first tracking frame.
        # Preserve a requested end time, including requests from older clients.
        settings['start']=snapshot['time']
        if settings['duration']:
            settings['duration']=end-snapshot['time']
        return self._enqueue(upload_id,settings,'tracking',ready=value.get('defer') is True)

    def _enqueue(self, upload_id, settings, kind, ready=False):
        info, source = self._upload(upload_id)
        with self.condition:
            caps = self.capability
            if not caps.get('ready'):
                raise JobError(caps.get('error') or '처리 장치를 확인 중입니다. 잠시 후 다시 시작하세요.', 503)
            if settings['device'] == 'gpu' and not caps.get('gpu'):
                raise JobError('사용 가능한 GPU가 없습니다. CPU를 직접 선택하거나 GPU 환경을 확인하세요.', 409)
            job_id = uuid.uuid4().hex
            (self.root/'jobs'/job_id).mkdir()
            job = {'id': job_id, 'uploadId': upload_id, 'name': info['name'], 'size': info['size'], 'options': settings,
                   'kind':kind, 'status': 'ready' if ready else 'queued', 'stage': '초기 설정 완료' if ready else '대기 중', 'progress': 0, 'createdAt': time.time(),
                   'device': caps['gpu'] if settings['device'] == 'gpu' else 'cpu',
                   'deviceLabel': caps['gpuLabel'] if settings['device'] == 'gpu' else 'CPU', 'model': 'YOLO26s'}
            self.jobs[job_id] = job
            self._save(job)
            if not ready:self.queue.append(job_id)
            self.condition.notify()
            return self.public(job)

    def _save(self, job):
        job['updatedAt'] = time.time()
        atomic_json(self.root/'jobs'/job['id']/'job.json', job)

    def public(self, job):
        value = deepcopy(job)
        if job['status'] == 'completed':
            base = '/api/tracking/jobs/' + job['id']
            if job.get('kind')=='preparation':value['result']={'detections':base+'/detections.json','frame':base+'/frame.png'}
            else:
                value['result'] = {'tracks': base+'/tracks.json', 'preview': base+'/preview.mp4', 'original': base+'/source'}
                if job['options'].get('setup'):value['result']['initialReview']=base+'/initial-review.json'
        return value

    def listing(self, deleted=False):
        with self.lock:
            return [self.public(job) for job in sorted(self.jobs.values(), key=lambda job: job.get('deletedAt',job['createdAt']), reverse=True)
                    if job.get('kind')!='preparation' and bool(job.get('deletedAt'))==deleted]

    def legacy_state(self, job, deleted=None):
        """Remove only the list reference to an externally supplied demo run."""
        with self.lock:
            key=job['datasetId']
            if deleted is not None:
                if deleted:self.legacy_deletions.setdefault(key,time.time())
                else:self.legacy_deletions.pop(key,None)
                atomic_json(self.root/'list-state.json',self.legacy_deletions)
            value=deepcopy(job)
            if key in self.legacy_deletions:value['deletedAt']=self.legacy_deletions[key]
            return value

    def delete(self, job_id):
        with self.condition:
            self.get(job_id)
            job=self.jobs[job_id]
            if job.get('kind')=='preparation':raise JobError('초기 장면은 분석 설정에서 관리하세요.',409)
            if job.get('deletedAt'):return self.public(job)
            job['deletedAt']=time.time()
            # Cancel while holding the queue lock so a waiting job cannot start
            # between removal from the list and cancellation.
            if job['status'] in ACTIVE:self.cancel(job_id)
            else:self._save(job)
            return self.public(job)

    def restore(self, job_id):
        with self.condition:
            self.get(job_id)
            job=self.jobs[job_id]
            if not job.get('deletedAt'):return self.public(job)
            if job['status'] in ACTIVE:raise JobError('분석 중지가 끝난 뒤 복원하세요.',409)
            job.pop('deletedAt',None)
            self._save(job)
            return self.public(job)

    def purge(self, job_id):
        """Permanently remove a trashed, stopped run, preserving shared inputs."""
        with self.condition:
            job = self.get(job_id)
            if not job.get('deletedAt') or job['status'] in ACTIVE or self.active_id == job_id:
                raise JobError('삭제한 분석에서 중지가 완료된 작업만 영구 삭제할 수 있습니다.', 409)
            upload_id = job['uploadId']
            peers = [j for j in self.jobs.values() if j['id'] != job_id and j['uploadId'] == upload_id]
            keep_source = any(j.get('kind') != 'preparation' or j['status'] in ACTIVE or self.active_id == j['id'] for j in peers)
            if self.storage:
                for key in job.get('s3Assets',{}).values():self.storage.delete(key)
                if not keep_source:
                    info,_=self._upload(upload_id)
                    if info.get('storage')=='s3':self.storage.delete(info['key'])
                    for prepared in peers:
                        for key in prepared.get('s3Assets',{}).values():self.storage.delete(key)
            if not keep_source:
                for prepared in peers:
                    path = self.root/'jobs'/prepared['id']
                    if path.exists():shutil.rmtree(path)
                    self.jobs.pop(prepared['id'], None)
                path = self.root/'uploads'/upload_id
                if path.exists():shutil.rmtree(path)
            shutil.rmtree(self.root/'jobs'/job_id)
            del self.jobs[job_id]
            self.queue = deque(key for key in self.queue if key in self.jobs)
            return {'id': job_id, 'purged': True, 'datasetId': job.get('datasetId'), 'sourceDeleted': not keep_source}

    def get(self, job_id):
        with self.lock:
            if not valid_id(job_id) or job_id not in self.jobs:
                raise JobError('분석 작업을 찾지 못했습니다.', 404)
            return self.public(self.jobs[job_id])

    def cancel(self, job_id):
        with self.condition:
            self.get(job_id)
            job = self.jobs[job_id]
            if job['status'] not in ACTIVE:
                return self.public(job)
            running = self.active_id == job_id
            job.update(status='cancelling' if running else 'cancelled', stage='중지 중' if running else '취소됨')
            if not running:
                job['finishedAt'] = time.time()
            self._save(job)
            if running and self.process and self.process.poll() is None:
                self.process.terminate()
                threading.Thread(target=self._kill_later, args=(self.process,), daemon=True).start()
            return self.public(job)

    @staticmethod
    def _kill_later(process):
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()

    def retry(self, job_id):
        job = self.get(job_id)
        if job.get('deletedAt'):raise JobError('삭제한 분석을 복원한 뒤 다시 분석하세요.',409)
        if job['status'] not in {'failed', 'cancelled', 'interrupted'}:
            raise JobError('중단되거나 실패한 작업만 재시도할 수 있습니다.', 409)
        if job.get('kind')=='preparation':return self.create_preparation(job['uploadId'],{'time':job['options']['start'],'device':job['options']['device']})
        return self.create(job['uploadId'], job['options'])

    def asset(self, job_id, name):
        job = self.get(job_id)
        if job['status'] != 'completed':
            raise JobError('트래킹이 완료된 뒤 작업을 열 수 있습니다.', 409)
        if name == 'source':
            _, path = self._upload(job['uploadId'])
            return path, 'video/quicktime' if path.suffix.lower()=='.mov' else 'video/mp4' if path.suffix.lower() in {'.mp4','.m4v'} else 'application/octet-stream'
        allowed={'detections.json','frame.png'} if job.get('kind')=='preparation' else {'tracks.json','preview.mp4','initial-review.json'}
        if name not in allowed:
            raise JobError('파일을 찾지 못했습니다.', 404)
        return self.root/'jobs'/job_id/'output'/name, 'application/json' if name.endswith('.json') else 'image/png' if name.endswith('.png') else 'video/mp4'

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closing or bool(self.queue))
                if self.closing:
                    return
                job_id = self.queue.popleft()
                job = self.jobs[job_id]
                if job['status'] != 'queued':
                    continue
                self.active_id = job_id
                job.update(status='starting', stage='영상·모델 준비', startedAt=time.time())
                self._save(job)
            try:
                self._execute(job)
            except Exception as error:
                process = self.process
                if process and process.poll() is None:
                    process.terminate()
                    self._kill_later(process)
                with self.lock:
                    status = 'interrupted' if self.closing else 'cancelled' if job['status']=='cancelling' else 'failed'
                    job.update(status=status, stage='분석 실패' if status=='failed' else '중단됨', error=str(error), finishedAt=time.time())
                    self._save(job)
            finally:
                try:
                    info,source=self._upload(job['uploadId'])
                    if info.get('storage')=='s3':source.unlink(missing_ok=True)
                except (OSError,JobError):pass
                with self.lock:
                    self.active_id = None
                    self.process = None

    def _execute(self, job):
        info, source = self._upload(job['uploadId'])
        folder = self.root/'jobs'/job['id']
        settings = job['options']
        remote_frame=info.get('storage')=='s3' and job.get('kind')=='preparation'
        if info.get('storage')=='s3' and not remote_frame and not source.is_file():
            if not self.storage:raise RuntimeError('S3 worker storage is not configured')
            if shutil.disk_usage(self.root).free < info['size']*1.3+512*1024**2:raise JobError('현재 경기를 처리할 임시 저장 공간이 부족합니다.',507)
            job.update(stage='S3 영상 준비 중');self._save(job)
            self.storage.download(info['key'],source)
        common=[self.python,'-u']
        if job.get('kind')=='preparation':
            command=common+[str(ROOT/'scripts/fpa_cv_prepare.py'),str(source),'--output',str(folder/'output'),
                '--model',str(self.model),'--device',job['device'],'--time',str(settings['start'])]
            if remote_frame:command+=['--s3-key',info['key']]
        else:
            seed=settings['setup']
            atomic_json(folder/'setup.json',seed)
            command=common+[str(ROOT/'scripts/fpa_cv_track.py'),str(source),'--output',str(folder/'output'),
                '--model',str(self.model),'--tracker',str(ROOT/'apps/api/app/bytetrack_player.yaml'),
                '--device',job['device'],'--start',str(settings['start']),'--duration',str(settings['duration']),
                '--sample-fps','15','--imgsz','1280','--conf','.1','--progress-json','--video-name',info['name'],
                '--uniforms',str(folder/'setup.json'),'--initial-setup',str(folder/'setup.json'),'--anchor-frame',str(seed['frameIndex']),
                '--roi',';'.join(','.join(str(n) for n in point) for point in settings['roi'])]
        with self.lock:
            if job['status'] == 'cancelling' or self.closing:
                job.update(status='interrupted' if self.closing else 'cancelled', stage='중단됨', finishedAt=time.time())
                self._save(job)
                return
            self.process = subprocess.Popen(command, cwd=ROOT, env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            process = self.process
        tail = deque(maxlen=12)
        with process.stdout, (folder/'process.log').open('w') as logfile:
            for line in process.stdout:
                logfile.write(line); logfile.flush()
                if line.startswith('FPA_PROGRESS '):
                    try:
                        progress = json.loads(line.removeprefix('FPA_PROGRESS '))
                        with self.lock:
                            if job['status'] != 'cancelling':
                                job.update(status='running', stage=progress.get('stage', '추적 중'), progress=min(99, max(0, progress.get('progress', 0))),
                                           sourceTime=progress.get('sourceTime'), elapsed=progress.get('elapsed'), eta=progress.get('eta'),
                                           processedFrames=progress.get('processedFrames'), totalFrames=progress.get('totalFrames'),
                                           remainingFrames=progress.get('remainingFrames'), processingFps=progress.get('processingFps'),
                                           samples=progress.get('samples', 0), trackCount=progress.get('trackCount', 0))
                                self._save(job)
                    except (ValueError, TypeError):
                        continue
                elif line.strip():
                    tail.append(line.strip())
        code = process.wait()
        with self.lock:
            if self.closing or job['status'] == 'cancelling':
                job.update(status='interrupted' if self.closing else 'cancelled', stage='중단됨', finishedAt=time.time())
                self._save(job)
                return
            elif code != 0:
                job.update(status='failed', stage='분석 실패', error='\n'.join(tail)[-1500:] or '추적 프로세스가 종료되었습니다.', finishedAt=time.time())
                self._save(job)
                return
        # Large result transfers must not block status polling or cancellation.
        output=folder/'output'
        if job.get('kind')=='preparation':
            payload=json.loads((output/'detections.json').read_text())
            if not (output/'frame.png').is_file():raise RuntimeError('초기 장면 이미지가 없습니다.')
            self._archive(job,info,output,['detections.json','frame.png'])
            result={'stage':'초기 장면 준비 완료','actualDevice':payload['device']}
        else:
            from fpa_cv_initial import initial_review
            payload = json.loads((output/'tracks.json').read_text())
            if not payload.get('frames') or not (output/'preview.mp4').is_file() or (output/'preview.mp4').stat().st_size == 0:
                raise RuntimeError('완료된 트래킹 결과와 재생 영상을 확인하지 못했습니다.')
            initial=initial_review(payload,settings['setup'])
            atomic_json(output/'initial-review.json',initial)
            self._archive(job,info,output,['tracks.json','preview.mp4','initial-review.json'])
            result={'stage':'분석 완료','video':payload['video'],'datasetId':payload['datasetId'],
                    'actualDevice':payload['detector']['device'],'samples':len(payload['frames']),
                    'trackCount':len(payload['tracks']),'initialMatched':len(initial['segments'])}
        with self.lock:
            if self.closing or job['status']=='cancelling':
                job.update(status='interrupted' if self.closing else 'cancelled',stage='중단됨',finishedAt=time.time())
            else:job.update(status='completed',progress=100,finishedAt=time.time(),**result)
            self._save(job)

    def close(self):
        with self.condition:
            self.closing = True
            self.condition.notify_all()
            process = self.process
            if process and process.poll() is None:
                process.terminate()
        if process:
            self._kill_later(process)
        if self.worker:
            self.worker.join(timeout=10)
