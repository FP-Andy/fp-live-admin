"""Durable, resumable status for the long-running evidence package build."""
import json
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import case_store
import report_bundle
import report_inputs
import report_jobs
import review_flow
from job_store import atomic, busy, lease, now

ROOT = case_store.ROOT / 'outputs/kbl-review-package-jobs'
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='review-package')
ACTIVE = set()
LOCK = threading.Lock()


def path(job):
    if not isinstance(job,str) or not re.fullmatch(r'[a-f0-9]{24}',job):
        raise ValueError('해설 자료 작업 ID를 확인하세요.')
    return ROOT/job/'status.json'


def status(case_id, job):
    data = json.loads(path(job).read_text())
    if data.get('caseId') != case_id:
        raise ValueError('이 경기의 해설 자료 작업이 아닙니다.')
    if data.get('state') in ('queued','running') and job not in ACTIVE and not busy(path(job).parent/'process.lock'):
        return {**data,'state':'interrupted','stage':'작업이 중단됐습니다. 다시 요청해 주세요.'}
    return data


def latest(case_id):
    case_store.load_case(case_id)
    found=[]
    for p in ROOT.glob('*/status.json'):
        try:
            row=status(case_id,p.parent.name)
            found.append(row)
        except (OSError,ValueError,KeyError,TypeError):
            continue
    return max(found,key=lambda x:x.get('createdAt',''),default=None)


def submit(case_id,payload):
    if not isinstance(payload,dict) or set(payload)!={'revision','version'}:
        raise ValueError('해설 자료의 경기와 코멘트 버전을 확인하세요.')
    case=case_store.load_case(case_id)
    if type(payload['revision']) is not int or payload['revision'] != case['revision'] or payload['version'] != report_inputs.version(case_id):
        raise RuntimeError('경기 또는 코멘트가 바뀌었습니다. 새로고침 후 다시 내려받아 주세요.')
    review_flow.require_report(case_id)
    fingerprint=report_jobs.stamp(case_id)
    with LOCK, lease(ROOT/'submit.lock') as acquired:
        if not acquired:raise RuntimeError('해설 자료 요청을 등록 중입니다. 잠시 후 다시 시도하세요.')
        for p in ROOT.glob('*/status.json'):
            try:
                saved=status(case_id,p.parent.name)
                if saved.get('fingerprint') != fingerprint or saved.get('payload') != payload:
                    continue
                if saved.get('state') in ('queued','running'):
                    return {'job':saved}
                if saved.get('state') == 'complete':
                    report_bundle.bundle_file(case_id,saved['result']['packageId'])
                    return {'job':saved}
            except (OSError,ValueError,KeyError,TypeError,RuntimeError):
                continue
        job=uuid.uuid4().hex[:24]
        data={'jobId':job,'caseId':case_id,'payload':payload,'fingerprint':fingerprint,
              'state':'queued','stage':'해설 자료 만들기 대기','createdAt':now()}
        atomic(path(job),data);ACTIVE.add(job)
        try:POOL.submit(run,job)
        except Exception:ACTIVE.discard(job);raise
        return {'job':data}


def run(job):
    data=json.loads(path(job).read_text())
    try:
        with lease(path(job).parent/'process.lock') as acquired:
            if not acquired:return
            data.update(state='running',stage='해설 자료를 만들고 있습니다.',updatedAt=now());atomic(path(job),data)
            if report_jobs.stamp(data['caseId'])!=data['fingerprint']:
                raise RuntimeError('대기 중 경기 또는 장면이 바뀌었습니다. 다시 요청해 주세요.')
            result=report_bundle.build(data['caseId'],data['payload'])
            data.update(state='complete',stage='해설 자료 준비 완료',result=result,completedAt=now());atomic(path(job),data)
    except Exception as exc:
        from diagnostics import safe
        data.update(state='failed',stage='해설 자료 만들기 확인 필요',error=safe(exc),completedAt=now());atomic(path(job),data)
    finally:
        ACTIVE.discard(job)
