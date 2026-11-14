"""One report followed by sequential, source-bound standard video jobs."""
import json,re,threading,time,uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import case_store,report_jobs,video_jobs,broadcast_reconstruction,review_flow
from job_store import atomic,lease,now

ROOT=case_store.ROOT/'outputs/kbl-report-video-batches'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='report-video-batch')
ACTIVE=set()
LOCK=threading.Lock()

def path(job):
    if not re.fullmatch(r'[a-f0-9]{24}',str(job)):raise ValueError('작업 ID를 확인하세요.')
    return ROOT/job/'status.json'

def status(job):
    data=json.loads(path(job).read_text())
    if data['state'] in ('queued','running') and job not in ACTIVE:
        data={**data,'state':'interrupted','stage':'작업이 중단됐습니다. 다시 요청하면 완료된 결과를 재사용합니다.'}
    return data

def latest(case):
    case_store.load_case(case)
    found=[]
    for p in ROOT.glob('*/status.json'):
        try:
            item=status(p.parent.name)
            if item.get('caseId')==case:found.append(item)
        except (OSError,ValueError,KeyError,json.JSONDecodeError):continue
    return max(found,key=lambda x:x.get('createdAt',''),default=None)

def readiness(case):
    data=case_store.load_case(case);rows=[]
    for e in data['events']:
        try:
            scene=broadcast_reconstruction.current(case,e['id'],strict=True)
            if not video_jobs.enabled():raise ValueError('영상 제작이 비활성화되어 있습니다.')
            video_jobs.executable()
            if not scene.get('poseVariantId'):
                import broadcast_pose,video_pose_refit
                if not video_pose_refit.BLENDER.is_file():raise ValueError('자동 자세 보정에 필요한 Blender를 찾을 수 없습니다.')
                if len(scene.get('crewAnalysis',{}).get('rows',[]))!=3:raise ValueError('세 심판의 시야 장면을 먼저 확인하세요.')
                pose=broadcast_pose.validate_pose(case,e['id'],scene['poseJobId'],scene['state']['entities'])
                video_jobs.video_pose_with_camera(case,e['id'],pose)
                rows.append({'eventId':e['id'],'number':e['number'],'ready':True,'autoPrepare':True})
            else:
                import pose_variant,broadcast_pose
                prepared=video_jobs.inputs(case,e['id'])
                pending=pose_variant.pending_placed_people(scene,prepared['pose'])
                if pending:
                    if any(any(len(p.get(k,[]))!=17 for k in ('keypoints','scores','depth')) for p in pending):raise ValueError('배치된 선수의 관절 자료가 부족합니다. 관절 검수를 확인하세요.')
                    _,_,_,frame=broadcast_reconstruction.context(case,e['id'],require_floor=False)
                    broadcast_pose.camera_inputs(frame,[{'spatialEligible':True}])
                rows.append({'eventId':e['id'],'number':e['number'],'ready':True,'autoPrepare':bool(pending)})
        except (ValueError,RuntimeError,OSError,KeyError,StopIteration) as exc:
            from diagnostics import safe
            rows.append({'eventId':e['id'],'number':e['number'],'ready':False,'message':safe(exc)[:250]})
    return {'caseId':case,'events':rows,'ready':bool(rows) and all(r['ready'] for r in rows)}

def submit(case,payload):
    if not isinstance(payload,dict) or set(payload)!={'revision','events'}:raise ValueError('제작할 장면을 확인하세요.')
    current=review_flow.require_report(case)
    if type(payload['revision']) is not int or payload['revision']!=current['revision']:raise RuntimeError('경기 자료가 바뀌었습니다. 새로고침하세요.')
    events=payload['events'];valid=[e['id'] for e in current['events']]
    if not isinstance(events,list) or not events or any(not isinstance(e,str) or e not in valid for e in events) or len(events)!=len(set(events)):raise ValueError('제작할 장면을 확인하세요.')
    checks=readiness(case);bad=[e for e in checks['events'] if e['eventId'] in events and (not e['ready'] or e.get('autoPrepare'))]
    if bad:raise RuntimeError('영상 제작 전 공유 자세와 공간 장면을 확인하세요: '+', '.join(str(e['number'])+'번' for e in bad))
    fingerprint=report_jobs.stamp(case)
    with LOCK,lease(ROOT/'submit.lock') as acquired:
        if not acquired:raise RuntimeError('다른 제작 요청을 등록 중입니다. 다시 시도하세요.')
        for p in ROOT.glob('*/status.json'):
            try:
                saved=status(p.parent.name)
                if saved.get('caseId')==case and saved['state'] in ('queued','running'):
                    if saved.get('fingerprint')==fingerprint and saved.get('events')==events:return {'job':saved}
                    raise RuntimeError('이 경기의 PDF·영상 제작이 진행 중입니다.')
            except (OSError,ValueError,KeyError,json.JSONDecodeError):continue
        report=report_jobs.submit(case,payload['revision'])['job']
        job=uuid.uuid4().hex[:24];data={'jobId':job,'caseId':case,'events':events,'fingerprint':fingerprint,
            'state':'queued','stage':'PDF 생성 대기','reportJobId':report['jobId'],'videos':[], 'createdAt':now()}
        atomic(path(job),data);ACTIVE.add(job)
        try:POOL.submit(run,job)
        except Exception:ACTIVE.discard(job);raise
        return {'job':data}

def run(job):
    data=json.loads(path(job).read_text())
    def save(**changes):data.update(changes,updatedAt=now());atomic(path(job),data)
    try:
        save(state='running',stage='PDF 생성 중')
        report=report_jobs.status(data['reportJobId'])
        while report['state'] in ('queued','running'):
            time.sleep(2);report=report_jobs.status(data['reportJobId'])
        if report['state']!='complete':raise RuntimeError(report.get('error') or 'PDF 생성이 중단됐습니다.')
        save(report=report['result'])
        for index,event in enumerate(data['events']):
            if report_jobs.stamp(data['caseId'])!=data['fingerprint']:
                raise RuntimeError('경기 또는 코멘트가 바뀌어 나머지 영상 제작을 중단했습니다. 최신 자료로 다시 요청하세요.')
            save(stage=f'영상 제작 {index+1}/{len(data["events"])}')
            try:
                item=video_jobs.submit(data['caseId'],event)['job']
                while item['state'] in ('queued','running'):
                    time.sleep(3);item=video_jobs.status(item['jobId'])
                row={'eventId':event,'jobId':item['jobId'],'state':item['state']}
                if item['state']=='complete':row['result']=item.get('result',{})
                else:row['error']=item.get('error') or item.get('stage') or '영상 제작이 중단됐습니다.'
            except (ValueError,RuntimeError,OSError,KeyError,StopIteration) as exc:
                from diagnostics import safe
                row={'eventId':event,'state':'failed','error':safe(exc)[:250]}
            data['videos'].append(row);save()
        ready_delivery=('complete','ready-for-download')
        failed=(data.get('report',{}).get('delivery',{}).get('state') not in ready_delivery or
            any(v['state']!='complete' or v.get('result',{}).get('delivery',{}).get('state') not in ready_delivery for v in data['videos']))
        save(state='partial' if failed else 'complete',stage='PDF·영상 전달 확인 필요' if failed else 'PDF·영상 제작 완료',completedAt=now())
    except Exception as exc:
        from diagnostics import safe
        save(state='failed',stage='제작 확인 필요',error=safe(exc)[:250],completedAt=now())
    finally:ACTIVE.discard(job)
