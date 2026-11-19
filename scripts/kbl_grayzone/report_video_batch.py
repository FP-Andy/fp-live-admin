"""One report followed by sequential, source-bound standard video jobs."""
import json,re,threading,time,uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import case_store,report_jobs,video_jobs,broadcast_reconstruction,review_flow
from job_store import atomic,digest,lease,now

ROOT=case_store.ROOT/'outputs/kbl-report-video-batches'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='report-video-batch')
ACTIVE=set()
LOCK=threading.Lock()
CASE_LOCKS={}
CASE_LOCKS_GUARD=threading.Lock()

def case_lock(case):
    with CASE_LOCKS_GUARD:return CASE_LOCKS.setdefault(case,threading.Lock())

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

def active(case):
    for p in ROOT.glob('*/status.json'):
        try:
            item=status(p.parent.name)
            if item.get('caseId')==case and item.get('state') in ('queued','running'):return item
        except (OSError,ValueError,KeyError,TypeError):continue
    return None

def save_automatic_scene(case,event,payload,expected_capture,internal_key=None):
    """Do not let a second automatic preparation replace an active video scene."""
    with case_lock(case):
        running=active(case)
        if running:
            import server_auto_pose
            if not server_auto_pose.permitted(case,event,running['jobId'],internal_key):
                raise RuntimeError('이 경기의 영상 제작이 진행 중입니다. 자동 보정을 다시 시작하지 않습니다.')
        if not isinstance(expected_capture,str) or not re.fullmatch(r'[a-f0-9]{24}',expected_capture):raise ValueError('자동 보정의 원본 장면을 확인하세요.')
        current=broadcast_reconstruction.current(case,event,strict=True)
        if current.get('captureId')!=expected_capture:raise RuntimeError('자동 보정 중 장면이 변경됐습니다. 현재 장면을 다시 확인하세요.')
        review_flow.require_stage(case,'spatial',event)
        return broadcast_reconstruction.save(case,event,payload)

def video_stamp(case,event):
    """Bind one video's actual inputs, excluding report prose and other scenes."""
    data=case_store.load_case(case)
    entry=next((e for e in data['events'] if e['id']==event),None)
    if not entry:raise ValueError('판독 장면을 찾을 수 없습니다.')
    scene=broadcast_reconstruction.current(case,event,strict=True)
    scene_file=case_store.CASES[case]/'reconstructions'/event/'current.json'
    identity={'event':event,'frame':entry.get('selectedBroadcastFrame'),
                   'broadcast':entry.get('broadcast'),'scene':video_jobs.sha(scene_file),
                   'referees':video_jobs.referee_labels(case,event,scene)}
    import pose_variant
    neutral=pose_variant.approved_neutral(case,event,scene)
    if neutral:identity['neutralPoseApproval']=neutral
    return digest(identity)

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
                neutral=pose_variant.approved_neutral(case,e['id'],scene,pending) if pending else []
                if pending and not neutral:
                    if any(any(len(p.get(k,[]))!=17 for k in ('keypoints','scores','depth')) for p in pending):raise ValueError('배치된 선수의 관절 자료가 부족합니다. 관절 검수를 확인하세요.')
                    pose_variant.placed_people_camera(case,e['id'],scene,prepared['pose'])
                rows.append({'eventId':e['id'],'number':e['number'],'ready':True,'autoPrepare':bool(pending and not neutral),**({'neutralFallback':neutral} if neutral else {})})
        except (ValueError,RuntimeError,OSError,KeyError,StopIteration) as exc:
            from diagnostics import safe
            rows.append({'eventId':e['id'],'number':e['number'],'ready':False,'message':safe(exc)[:250]})
    return {'caseId':case,'events':rows,'ready':bool(rows) and all(r['ready'] for r in rows)}

def submit(case,payload):
    if not isinstance(payload,dict) or set(payload)!={'revision','events'}:raise ValueError('제작할 장면을 확인하세요.')
    if case not in case_store.CASES:raise ValueError('등록되지 않은 경기입니다.')
    events=payload['events']
    if type(payload['revision']) is not int or not isinstance(events,list) or not events or any(not isinstance(e,str) or not re.fullmatch(r'review-[0-9]+',e) for e in events) or len(events)!=len(set(events)):raise ValueError('제작할 장면을 확인하세요.')
    # Only register the request here. Scene validation and file hashing may take
    # longer than the public gateway timeout and must happen in the worker.
    with LOCK,lease(ROOT/'submit.lock') as acquired:
        if not acquired:raise RuntimeError('다른 제작 요청을 등록 중입니다. 다시 시도하세요.')
        for p in ROOT.glob('*/status.json'):
            try:
                saved=status(p.parent.name)
                if saved.get('caseId')==case and saved['state'] in ('queued','running'):
                    if saved.get('events')==events:return {'job':saved}
                    raise RuntimeError('이 경기의 PDF·영상 제작이 진행 중입니다.')
            except (OSError,ValueError,KeyError,json.JSONDecodeError):continue
        job=uuid.uuid4().hex[:24];data={'jobId':job,'caseId':case,'revision':payload['revision'],'events':events,
            'state':'queued','stage':'영상 제작 준비 확인 중','videos':[], 'createdAt':now()}
        atomic(path(job),data);ACTIVE.add(job)
        try:POOL.submit(run,job)
        except Exception:
            ACTIVE.discard(job);data.update(state='failed',stage='제작 확인 필요',error='제작 작업을 시작하지 못했습니다.',completedAt=now());atomic(path(job),data);raise
        return {'job':data}

def run(job):
    data=json.loads(path(job).read_text())
    def save(**changes):data.update(changes,updatedAt=now());atomic(path(job),data)
    def refresh_report_flag():
        try:changed=report_jobs.stamp(data['caseId'])!=data['fingerprint']
        except (ValueError,RuntimeError,OSError,KeyError,StopIteration):changed=True
        if changed:data['reportNeedsRefresh']=True
    try:
        # Register first, then run pose preparation in a server-owned browser.
        # No user tab needs to remain open once the batch is acknowledged.
        with case_lock(data['caseId']):
            save(state='running',stage='영상 제작 준비 확인 중')
            current=review_flow.require_report(data['caseId'])
            if data['revision']!=current['revision']:raise RuntimeError('경기 자료가 바뀌었습니다. 새로고침하세요.')
            valid={e['id'] for e in current['events']}
            if any(e not in valid for e in data['events']):raise ValueError('제작할 장면을 확인하세요.')
            checks=readiness(data['caseId']);bad=[e for e in checks['events'] if e['eventId'] in data['events'] and not e['ready']]
            if bad:raise RuntimeError('영상 제작을 준비할 수 없는 장면이 있습니다: '+', '.join(str(e['number'])+'번' for e in bad))
            pending=[e for e in checks['events'] if e['eventId'] in data['events'] and e.get('autoPrepare')]
        import server_auto_pose,auto_pose_review,report_inputs
        for index,row in enumerate(pending):
            event=row['eventId']
            save(stage=f'자세 자동 보정 {index+1}/{len(pending)} · {row["number"]}번 장면')
            # Snapshot the exact source; manual edits and comment changes still
            # fail closed instead of silently overwriting another operator.
            source=broadcast_reconstruction.current(data['caseId'],event,strict=True)['captureId']
            version=report_inputs.version(data['caseId'])
            try:
                with server_auto_pose.authorize(data['caseId'],event,job) as key:
                    result=server_auto_pose.render(data['caseId'],event,key)
            except Exception as exc:
                # The save may have succeeded before the browser lost its
                # response. Reconcile only an exact pose-derived scene from
                # this source; finalize checks geometry and editorial version.
                candidate=broadcast_reconstruction.current(data['caseId'],event,strict=True)
                if candidate.get('captureId')==source or not candidate.get('poseVariantId'):raise
                try:
                    auto_pose_review.finalize(data['caseId'],event,{'previousCaptureId':source,
                        'captureId':candidate['captureId'],'version':version})
                except Exception:
                    raise exc
                continue
            if result['previousCaptureId']!=source:raise RuntimeError('자동 보정 중 기준 장면이 변경됐습니다.')
            auto_pose_review.finalize(data['caseId'],event,{**result,'version':version})
        with case_lock(data['caseId']):
            current=review_flow.require_report(data['caseId'])
            if data['revision']!=current['revision']:raise RuntimeError('경기 자료가 바뀌었습니다. 새로고침하세요.')
            checks=readiness(data['caseId']);bad=[e for e in checks['events'] if e['eventId'] in data['events'] and (not e['ready'] or e.get('autoPrepare'))]
            if bad:raise RuntimeError('자동 자세 준비를 완료하지 못했습니다: '+', '.join(str(e['number'])+'번' for e in bad))
            video_inputs={event:video_stamp(data['caseId'],event) for event in data['events']}
            report=report_jobs.submit(data['caseId'],data['revision'])['job']
            save(videoInputs=video_inputs,reportJobId=report['jobId'],fingerprint=report.get('fingerprint') or report_jobs.stamp(data['caseId']))
        save(state='running',stage='PDF 생성 중')
        report=report_jobs.status(data['reportJobId'])
        while report['state'] in ('queued','running'):
            progress=report.get('progress') or {};suffix=f" · {progress['completed']}/{progress['total']}{progress.get('unit') or ''}" if progress.get('total') is not None and progress.get('completed') is not None else ''
            save(stage='PDF · '+(report.get('stage') or '생성 중')+suffix)
            time.sleep(2);report=report_jobs.status(data['reportJobId'])
        if report['state']=='complete':save(report=report['result'])
        else:save(reportIssue=report.get('error') or 'PDF 생성이 중단됐습니다. 최신 자료로 PDF를 다시 생성해 주세요.',reportNeedsRefresh=True)
        for index,event in enumerate(data['events']):
            refresh_report_flag()
            save(stage=f'영상 제작 {index+1}/{len(data["events"])}',currentEvent=event)
            try:
                if video_stamp(data['caseId'],event)!=data['videoInputs'][event]:
                    raise RuntimeError('이 장면의 기준 화면·배치 또는 심판 매칭이 바뀌었습니다. 장면을 확인해 주세요.')
                item=video_jobs.submit(data['caseId'],event)['job']
                while item['state'] in ('queued','running'):
                    progress=item.get('progress') or {};suffix=f" · {progress['completed']}/{progress['total']}" if progress.get('total') is not None and progress.get('completed') is not None else ''
                    save(stage=f'영상 제작 {index+1}/{len(data["events"])} · {item.get("stage") or "진행 중"}{suffix}')
                    time.sleep(3);item=video_jobs.status(item['jobId'])
                row={'eventId':event,'jobId':item['jobId'],'state':item['state']}
                if item['state']=='complete':row['result']=item.get('result',{})
                else:row['error']=item.get('error') or item.get('stage') or '영상 제작이 중단됐습니다.'
            except (ValueError,RuntimeError,OSError,KeyError,StopIteration) as exc:
                from diagnostics import safe
                row={'eventId':event,'state':'failed','error':safe(exc)[:250]}
            data['videos'].append(row);save()
        # A previously finished scene can be edited while a later video runs.
        # Keep its versioned file, but do not present it as the current scene.
        for row in data['videos']:
            if row['state']!='complete':continue
            try:current=video_stamp(data['caseId'],row['eventId'])==data['videoInputs'][row['eventId']]
            except (ValueError,RuntimeError,OSError,KeyError,StopIteration):current=False
            if not current:row.update(state='stale',error='제작 후 이 장면의 기준 화면·배치 또는 심판 매칭이 바뀌었습니다. 장면을 확인해 주세요.')
        refresh_report_flag()
        ready_delivery=('complete','ready-for-download')
        failed=(data.get('reportNeedsRefresh') or data.get('report',{}).get('delivery',{}).get('state') not in ready_delivery or
            any(v['state']!='complete' or v.get('result',{}).get('delivery',{}).get('state') not in ready_delivery for v in data['videos']))
        save(state='partial' if failed else 'complete',stage='PDF·영상 전달 확인 필요' if failed else 'PDF·영상 제작 완료',currentEvent=None,completedAt=now())
    except Exception as exc:
        from diagnostics import safe
        save(state='failed',stage='제작 확인 필요',error=safe(exc)[:250],completedAt=now())
    finally:ACTIVE.discard(job)
