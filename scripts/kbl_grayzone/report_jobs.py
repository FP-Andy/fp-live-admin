"""Persistent report task status. Polling never starts work or inference."""
import json,uuid,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from job_store import atomic,digest,lease,busy,now
import case_store
ROOT=case_store.ROOT/'outputs/kbl-report-jobs'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='report-pdf');ACTIVE={}

def folder(job):
    import re
    if not re.fullmatch(r'[a-f0-9]{24}',job):raise ValueError('리포트 작업 ID를 확인하세요.')
    return ROOT/job

def status(job):
    path=folder(job);data=json.loads((path/'status.json').read_text())
    if data['state'] in ('queued','running') and job not in ACTIVE and not busy(path/'process.lock'):
        data.update(state='interrupted',error='리포트 생성 연결이 중단됐습니다. 기존 PDF는 보관되어 있습니다. PDF 생성을 다시 누르세요.')
    return data

def stamp(key):
    from report_inputs import version
    from wide_reference import version as wide_version
    case=case_store.load_case(key);root=case_store.CASES[key]
    return digest({'case':key,'revision':case['revision'],'records':case.get('recordsVersion'),'editorial':version(key),'wideReference':wide_version(root),
        'captures':{e['id']:json.loads((root/'reconstructions'/e['id']/'current.json').read_text()).get('captureId') for e in case['events']},'layout':'summary-clips-v12'})

def submit(key,revision):
    case=case_store.load_case(key)
    if revision!=case['revision']:raise RuntimeError('경기 자료가 바뀌었습니다. 다시 불러오세요.')
    fingerprint=stamp(key)
    with lease(ROOT/'submit.lock') as acquired:
        if not acquired:raise RuntimeError('PDF 작업을 등록 중입니다. 잠시 후 다시 시도하세요.')
        for path in ROOT.glob('*/status.json'):
            data=json.loads(path.read_text())
            if data.get('fingerprint')==fingerprint and data['state'] in ('queued','running','complete'):
                saved=status(data['jobId'])
                if saved['state']=='complete' and saved.get('result',{}).get('reportId'):
                    import report_delivery
                    saved['result']['delivery']=report_delivery.result(key,saved['result']['reportId']);atomic(path,saved)
                if saved['state'] in ('queued','running','complete'):return {'job':saved}
        job=uuid.uuid4().hex[:24];data={'jobId':job,'caseId':key,'revision':revision,'fingerprint':fingerprint,'state':'queued','stage':'PDF 생성 대기','createdAt':now()}
        atomic(folder(job)/'status.json',data);ACTIVE[job]=True;POOL.submit(run,job);return {'job':data}

def run(job):
    path=folder(job);data=json.loads((path/'status.json').read_text());started=time.monotonic()
    try:
        with lease(path/'process.lock') as acquired:
            if not acquired:return
            def progress(phase,completed=None,total=None,unit=None):
                data.update(state='running',stage=phase,updatedAt=now(),progress={'phase':phase,'completed':completed,'total':total,'unit':unit or '개','updatedAt':now()})
                atomic(path/'status.json',data)
            from case_report import generate_case_report
            if stamp(data['caseId'])!=data['fingerprint']:
                raise RuntimeError('대기 중 경기 자료가 변경됐습니다. 최신 자료로 PDF 생성을 다시 누르세요.')
            result=generate_case_report(data['caseId'],data['revision'],progress=progress)
            completed=now()
            data.update(state='complete',stage='PDF 개정 보관 완료',result=result,completedAt=completed,seconds=round(time.monotonic()-started,3),
                        progress={'phase':'PDF 개정 보관','completed':1,'total':1,'unit':'파일','updatedAt':completed});atomic(path/'status.json',data)
    except Exception as exc:
        from diagnostics import safe
        data.update(state='failed',stage='PDF 생성 확인 필요',error=safe(exc),completedAt=now());atomic(path/'status.json',data)
    finally:ACTIVE.pop(job,None)
