"""Bounded RF-DETR jobs sharing the existing persistent GPU execution lane."""
from collections import deque
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time

class RecoveryJobs:
    def create_recovery(self, value):
        from fpa_cv_jobs import JobError, valid_id, atomic_json
        if not isinstance(value, dict) or not valid_id(value.get('id')):
            raise JobError('보강 작업 ID를 확인하세요.')
        plan=value.get('plan') or {}; windows=plan.get('windows') or []
        if plan.get('schema')!='fpa-substitution-redetection/v1' or not isinstance(windows,list) or not 1<=len(windows)<=8 or any(not isinstance(w,dict) for w in windows):
            raise JobError('보강 구간을 확인하세요.')
        total=0; ids=set()
        for w in windows:
            a,z=w.get('from'),w.get('to'); wid=w.get('id')
            if (type(a) not in (int,float) or type(z) not in (int,float) or not math.isfinite(a+z)
                    or a<0 or not 0<z-a<=80 or type(wid) is not int or not 0<wid<1000000 or wid in ids):
                raise JobError('보강 범위가 잘못되었습니다.')
            total+=z-a;ids.add(wid)
        if total>80:raise JobError('보강은 한 번에 80초 이하로 요청하세요.')
        info,_=self._upload(value.get('uploadId'))
        fingerprint=hashlib.sha256(json.dumps({'uploadId':info['id'],'plan':plan},sort_keys=True).encode()).hexdigest()
        with self.condition:
            old=self.jobs.get(value['id'])
            if old:
                if old.get('requestHash')!=fingerprint:raise JobError('같은 작업 ID의 내용이 다릅니다.',409)
                return self.public(old)
            python=Path(os.getenv('FPA_CV_RF_PYTHON','/workspace/runtime/fpa-cv/rfdetr-venv/bin/python'))
            model=Path(os.getenv('FPA_CV_RF_MODEL',str(self.root.parent/'rf-detr-medium.pth')))
            if not python.is_file() or not model.is_file():raise JobError('RF-DETR 실행 환경을 준비해야 합니다.',503)
            if not self.capability.get('ready') or self.capability.get('gpu') not in ('0','cuda','cuda:0'):
                raise JobError('CUDA GPU가 준비된 뒤 보강을 시작하세요.',503)
            folder=self.root/'jobs'/value['id'];folder.mkdir()
            atomic_json(folder/'recovery-plan.json',plan)
            job={'id':value['id'],'uploadId':info['id'],'name':info['name'],'size':info['size'],'kind':'recovery',
                 'model':'RF-DETR Medium','device':'0','deviceLabel':self.capability['gpuLabel'],
                 'options':{'device':'gpu','plan':deepcopy(plan)},'requestHash':fingerprint,
                 'status':'queued','stage':'RF-DETR 보강 대기','progress':0,'createdAt':time.time()}
            self.jobs[job['id']]=job;self._save(job);self.queue.append(job['id']);self.condition.notify_all()
            return self.public(job)

    def _execute_recovery(self, job):
        from fpa_cv_jobs import ROOT
        info,source=self._upload(job['uploadId']);folder=self.root/'jobs'/job['id'];output=folder/'output';output.mkdir(exist_ok=True)
        command=[os.getenv('FPA_CV_RF_PYTHON','/workspace/runtime/fpa-cv/rfdetr-venv/bin/python'),'-u',str(ROOT/'scripts/fpa_cv_substitution_redetect.py'),
                 '--plan',str(folder/'recovery-plan.json'),'--video',str(source),'--output',str(output/'recovery.json'),
                 '--model',os.getenv('FPA_CV_RF_MODEL',str(self.root.parent/'rf-detr-medium.pth')),
                 '--device','0','--half','--detector','rfdetr','--scope','court','--result-id',job['id'],'--progress-json']
        if info.get('storage')=='s3':command+=['--s3-key',info['key']]
        with self.lock:
            if self.closing or job['status']=='cancelling':
                job.update(status='interrupted' if self.closing else 'cancelled',stage='보강 중단',finishedAt=time.time());self._save(job);return
            env=self.env();env['PYTHONPATH']=str(ROOT/'scripts')+os.pathsep+env.get('PYTHONPATH','')
            process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=os.name=='posix')
            if os.name=='posix':process._fpa_process_group=process.pid
            self.processes[job['id']]=process
        tail=deque(maxlen=8)
        with process.stdout,(folder/'process.log').open('w') as log:
            for line in process.stdout:
                log.write(line);log.flush()
                if line.startswith('FPA_PROGRESS '):
                    try:
                        p=json.loads(line.removeprefix('FPA_PROGRESS '))
                        with self.lock:
                            if not self.closing and job['status']!='cancelling':
                                job.update(status='running',stage='RF-DETR 교체선수 보강 중',**{k:p[k] for k in ('progress','eta','elapsed','processedFrames','totalFrames') if k in p});self._save(job)
                    except (ValueError,TypeError):pass
                elif line.strip():tail.append(line.strip())
        code=process.wait()
        with self.lock:
            if self.closing or job['status']=='cancelling':
                job.update(status='interrupted' if self.closing else 'cancelled',stage='보강 중단',finishedAt=time.time());self._save(job);return
            if code:raise RuntimeError('\n'.join(tail)[-1200:] or 'RF-DETR 보강 실패')
        payload=json.loads((output/'recovery.json').read_text())
        if payload.get('id')!=job['id'] or not all(w.get('frames') for w in payload.get('windows',[])):
            raise RuntimeError('완성된 보강 결과를 확인하지 못했습니다.')
        self._archive(job,info,output,['recovery.json'])
        with self.lock:
            job.update(status='completed',progress=100,eta=0,stage='RF-DETR 보강 완료',finishedAt=time.time(),windowCount=len(payload['windows']));self._save(job)
