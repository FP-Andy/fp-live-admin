"""Reclaim only verified, unreferenced copies of completed-game wide footage."""
import json, os, re, time, zipfile
from contextlib import ExitStack
from pathlib import Path
from job_store import atomic, lease, now

MIN_AGE = 48 * 60 * 60
RECENT_ACTIVITY = 2 * 60 * 60
SHA = re.compile(rb'(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])')
PREPARED = re.compile(rb'prepared-([0-9a-f-]{36})-(\d+)')
MEDIA = re.compile(rb'/([0-9a-f-]{36})/(\d+)\.mp4')
KEEP_RECENT_GAMES = 3  # Latest/current game and its two predecessors.

def retained_matches(current_mid, matches):
    """Protect the latest three known games, the requested game, and ambiguity."""
    from datetime import date
    identified={};ambiguous=set()
    for row in matches:
        mid=row.get('fpcMatchId')
        if not mid:continue
        try:
            day=date.fromisoformat(row['date']);number=str(row.get('gameNumber','')).strip()
            if not number.isdigit():raise ValueError()
            key=(day,int(number))
        except (KeyError,ValueError,TypeError):
            ambiguous.add(mid);continue
        if mid in identified and identified[mid]!=key:
            ambiguous.add(mid);continue
        identified[mid]=key
    protected={current_mid}|ambiguous
    if current_mid not in identified or current_mid in ambiguous:
        return protected|set(identified)
    if identified:
        ordered=sorted(identified.values(),reverse=True)
        cutoff=ordered[min(KEEP_RECENT_GAMES,len(ordered))-1]
        protected.update(mid for mid,key in identified.items() if key>=cutoff)
        # Reopening an older game must not evict its two predecessors, and
        # must not evict the newest games either.
        preceding=sorted((key for key in identified.values() if key<=identified[current_mid]),reverse=True)
        cutoff=preceding[min(KEEP_RECENT_GAMES,len(preceding))-1]
        protected.update(mid for mid,key in identified.items() if cutoff<=key<=identified[current_mid])
    return protected

def references(roots, sessions):
    """Scan current and historical records, including exported review packages."""
    protected = {sid: set() for sid in sessions}; hashes = set()
    def inspect(raw, label):
        hashes.update(x.decode('ascii') for x in SHA.findall(raw))
        for pattern in (PREPARED, MEDIA):
            for sid, index in pattern.findall(raw):
                sid = sid.decode('ascii')
                if sid in protected: protected[sid].add(int(index))
        relevant = [sid for sid in sessions if sid.encode('ascii') in raw]
        if not relevant or not label.endswith('.json'): return
        try: data = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc: raise RuntimeError('과거 판독 근거를 확인할 수 없어 자동 정리를 중단했습니다.') from exc
        def visit(value):
            if isinstance(value, dict):
                sid=value.get('sessionId') or value.get('session_id')
                part=value.get('part') if 'part' in value else value.get('partIndex')
                if sid in protected and type(part) is int and part>=0: protected[sid].add(part)
                for child in value.values(): visit(child)
            elif isinstance(value, list):
                for child in value: visit(child)
        visit(data)
    for root in roots:
        root=Path(root)
        if not root.is_dir(): raise RuntimeError('과거 경기 자료를 확인할 수 없어 자동 정리를 중단했습니다.')
        for directory, dirs, files in os.walk(root, followlinks=False):
            if any((Path(directory)/name).is_symlink() for name in dirs):
                raise RuntimeError('판독 자료에 확인할 수 없는 연결 경로가 있어 자동 정리를 중단했습니다.')
            for name in files:
                path=Path(directory)/name
                if path.is_symlink(): raise RuntimeError('판독 자료의 연결 파일을 확인할 수 없어 자동 정리를 중단했습니다.')
                if name.endswith('.json'):
                    inspect(path.read_bytes(), name)
                elif name.endswith('.zip'):
                    try:
                        with zipfile.ZipFile(path) as archive:
                            for info in archive.infolist():
                                if info.filename.endswith(('.json','.md')):
                                    if info.file_size > 64*1024**2: raise RuntimeError('판독 자료 묶음이 너무 커 자동 정리를 중단했습니다.')
                                    inspect(archive.read(info), info.filename)
                    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
                        raise RuntimeError('판독 자료 묶음을 확인할 수 없어 자동 정리를 중단했습니다.') from exc
    return {sid:{i+d for i in indices for d in (-1,0,1) if i+d>=0} for sid,indices in protected.items()}, hashes

def completed_cases(mid, clock):
    import case_store, match_library, report_versions
    matches=[m for m in match_library.read()['matches'] if m.get('fpcMatchId')==mid]
    ids=set()
    for match in matches:
        ids.update(match.get('caseIds') or [])
        if match.get('caseId'):ids.add(match['caseId'])
    if not ids:return []
    for key in ids:
        root=case_store.CASES.get(key)
        if not root or not (root/'case.json').is_file():return []
        try:
            case=case_store.load_case(key)
            day=time.mktime(time.strptime(case['date'],'%Y-%m-%d'))
            if clock-day < MIN_AGE:return []
            activity=root/'work-sessions.json'
            if activity.exists() and clock-activity.stat().st_mtime < RECENT_ACTIVITY:return []
            flow=json.loads((root/'review-flow.json').read_text()).get('events',{})
            if not all(flow.get(e['id'],{}).get('spatial',{}).get('token') for e in case['events']):return []
            versions=report_versions.index(key).get('versions',[])
            if not any((report_versions.folder(key)/(v['id']+'.pdf')).is_file() for v in versions):return []
        except (OSError, ValueError, KeyError, TypeError):return []
    return sorted(ids)

def ensure_capacity(required, current_mid, on_progress=lambda *_:None, check_cancel=lambda:None, prune_older=False):
    """Free required bytes, or prune older caches when explicitly requested."""
    import wide_preparation as wide, storage_policy, case_store, review_intake, match_library
    if not prune_older and storage_policy.free_bytes(wide.STORE) >= required:return {'removed':0,'bytes':0}
    storage_policy.external_root()
    keep=retained_matches(current_mid,match_library.read()['matches'])
    groups=[]
    for folder in wide.STORE.iterdir():
        if folder.is_symlink() or not folder.is_dir() or folder.name in keep:continue
        try:
            mid=wide.fpc_sources.match_id(folder.name);data=wide.read(mid)
            if data.get('state') in ('running','queued'):continue
            cases=completed_cases(mid,time.time())
            if cases:groups.append((min((case_store.CASES[c]/'case.json').stat().st_mtime for c in cases),mid,cases))
        except (ValueError, OSError, KeyError):continue
    groups.sort()
    removed=0;removed_bytes=0
    if not groups:return {'removed':0,'bytes':0}
    import boto3, fpc_sources
    from botocore.config import Config
    settings=fpc_sources.config();client=boto3.client('s3',region_name=settings['region'],config=Config(connect_timeout=5,read_timeout=10,retries={'max_attempts':1}))
    with lease(wide.STORE/'retention.lock') as held:
        if not held:raise RuntimeError('다른 자동 공간 정리가 진행 중입니다. 잠시 후 다시 시도하세요.')
        for _,mid,cases in groups:
            if not prune_older and storage_policy.free_bytes(wide.STORE)>=required:break
            check_cancel();on_progress('이전 경기의 보존 구간과 FPC 원본을 확인하고 있습니다.')
            with lease(wide.folder(mid)/'job.lock') as held_job:
                if not held_job:continue
                if mid in retained_matches(current_mid,match_library.read()['matches']):continue
                data=wide.read(mid)
                if data.get('state') in ('running','queued') or not completed_cases(mid,time.time()):continue
                rows=[r for r in data.get('recordings',[]) if not r.get('recordingActive') and r.get('status')=='ready']
                sessions={r['session_id'] for r in rows}
                if not sessions:continue
                # Hold the same locks used by selection and saved wide evidence
                # while checking references and deleting; busy cases are skipped.
                with review_intake.LOCK, ExitStack() as stack:
                    locks=[case_store.CASES[c]/'wide-reference.lock' for c in cases]
                    for case in cases:
                        c=case_store.load_case(case); intake=c.get('intakeId')
                        if intake:
                            locks += [review_intake.folder(intake)/'sequence-sync'/(e['id']+'.lock') for e in c['events']]
                    if any(not stack.enter_context(lease(p)) for p in locks):continue
                    roots=[case_store.ROOT/'outputs/kbl-cases',case_store.ROOT/'outputs/kbl-intake']
                    protected,hashes=references(roots,sessions)
                    if mid in retained_matches(current_mid,match_library.read()['matches']):continue
                    audit=[];before=storage_policy.free_bytes(wide.STORE)
                    for row in rows:
                        sid=row['session_id']
                        for part in row['parts']:
                            check_cancel()
                            if not prune_older and storage_policy.free_bytes(wide.STORE)>=required:break
                            if part['index'] in protected[sid]:continue
                            meta=wide.cache_info(mid,sid,part);path=wide.part_path(mid,sid,part['index'])
                            if not meta or meta.get('sha256') in hashes or not meta.get('etag') or path.is_symlink() or not path.is_file():continue
                            try:remote=client.head_object(Bucket=settings['bucket'],Key=part['key'])
                            except Exception:continue
                            if remote.get('ContentLength')!=part['bytes'] or remote.get('ETag')!=meta['etag']:continue
                            if wide.cache_info(mid,sid,part)!=meta:continue
                            path.unlink();path.with_suffix('.json').unlink(missing_ok=True)
                            removed+=1;removed_bytes+=part['bytes'];audit.append({'sessionId':sid,'part':part['index'],'bytes':part['bytes'],'sha256':meta['sha256']})
                            # A sparse image can remain physically full even
                            # after deletion. Do not evict everything pointlessly.
                            if not prune_older and sum(x['bytes'] for x in audit)>=256*1024**2 and storage_policy.free_bytes(wide.STORE)<=before:break
                        if not prune_older and storage_policy.free_bytes(wide.STORE)>=required:break
                    if audit:
                        data=wide.read(mid);data.update(state='listed',updatedAt=now(),message='이전 경기의 미사용 광각 캐시를 자동 정리했습니다. 판독 근거 구간은 보존됩니다.')
                        wide.write(mid,data)
                        history=case_store.ROOT/'outputs/kbl-cleanup-history';history.mkdir(exist_ok=True)
                        atomic(history/('wide-auto-'+str(time.time_ns())+'.json'),{'matchId':mid,'cases':cases,'at':now(),'remoteETagAndSizeVerified':True,'removed':audit})
    return {'removed':removed,'bytes':removed_bytes}
