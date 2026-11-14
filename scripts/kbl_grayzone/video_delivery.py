"""Publish verified videos to the operator's requested local delivery folder."""
import ctypes
import errno
import hashlib
import os
import re
import shutil
import sys
import unicodedata
import uuid
from pathlib import Path

import case_store
import review_videos
import storage_policy


def delivery_root():
    configured=os.environ.get('KBL_VIDEO_DELIVERY_ROOT')
    if configured:return Path(configured).expanduser()
    root=Path.home()/'Desktop'/'아이탑 전달'
    cfg=storage_policy.config()
    if cfg:
        storage_policy.external_root()
        expected=(cfg['mount']/'itop-delivery').resolve()
        if not root.is_symlink() or root.resolve()!=expected:
            raise RuntimeError('바탕화면 전달 폴더의 외장 연결이 변경됐습니다. 저장소 연결을 확인하세요.')
    return root


def part(value, fallback, limit=60):
    text=unicodedata.normalize('NFC',str(value or ''))
    text=re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', ' ',text)).strip(' .')
    text=text.encode('utf-8')[:limit].decode('utf-8','ignore').strip(' .')
    return text or fallback


def names(case, event):
    number=part(case.get('gameNumber'),'미확인',16)
    if number.isascii() and number.isdigit():number=number.zfill(3)
    home=part(case.get('home'),'홈팀');away=part(case.get('away'),'원정팀')
    event_number=event.get('number')
    if type(event_number) is not int or not 1<=event_number<=999:raise ValueError('판독 장면 번호를 확인하세요.')
    fixture=f'{home} vs {away}'
    return f'경기{number}-{fixture}',f'KBL 경기{number} {fixture} - 경기 판독 영상 {event_number:02d}.mp4'

def video_filename(case,event,meta):
    filename=names(case,event)[1]
    return filename[:-4]+' (자세 보정 비교본).mp4' if meta.get('poseMode')=='refit' else filename


def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def clone_or_copy(source, temp, parent):
    # APFS clones are independent files and share blocks until edited. Unlike a
    # hard link, editing a delivery file cannot change the archived source.
    if sys.platform=='darwin':
        fn=getattr(ctypes.CDLL(None,use_errno=True),'clonefile',None)
        if fn:
            fn.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int];fn.restype=ctypes.c_int
            if fn(os.fsencode(source),os.fsencode(temp),0)==0:return 'copy-on-write'
    if storage_policy.free_bytes(parent)<source.stat().st_size+2*1024**3:
        raise RuntimeError('전달용 파일을 복사할 저장 공간이 부족합니다.')
    with source.open('rb') as src,temp.open('xb') as dst:
        shutil.copyfileobj(src,dst,1024*1024);dst.flush();os.fsync(dst.fileno())
    return 'copy'


def place(source, expected_sha, case, event, root=None, filename=None):
    source=Path(source)
    if source.is_symlink() or not source.is_file():raise ValueError('전달할 파일을 확인하세요.')
    root=Path(root) if root is not None else delivery_root()
    if not root.parent.is_dir():raise RuntimeError('바탕화면 전달 폴더의 상위 경로를 찾을 수 없습니다.')
    root.mkdir(exist_ok=True)
    if not root.is_dir():raise RuntimeError('전달 경로가 폴더가 아닙니다.')
    group,video_filename=names(case,event);filename=filename or video_filename
    if Path(filename).name!=filename or not filename:raise ValueError('전달 파일명을 확인하세요.')
    folder=root/group
    if folder.is_symlink():raise RuntimeError('경기 전달 폴더가 연결 경로이므로 확인이 필요합니다.')
    folder.mkdir(exist_ok=True)
    if not folder.is_dir():raise RuntimeError('경기 전달 경로가 폴더가 아닙니다.')
    stem=Path(filename).stem;suffix=Path(filename).suffix;temp=None;method=None
    # Numbered revisions can remain after an older file is removed. Check all
    # matching names before choosing the first vacant name, so retries do not
    # create another copy just because there is a gap in the sequence.
    numbered=re.compile(r'^'+re.escape(unicodedata.normalize('NFC',stem))+r' \((?:[2-9]|[1-9][0-9]+)\)'+re.escape(suffix)+r'$')
    for existing in folder.iterdir():
        name=unicodedata.normalize('NFC',existing.name)
        if name!=unicodedata.normalize('NFC',filename) and not numbered.fullmatch(name):continue
        if not existing.is_symlink() and existing.is_file() and existing.stat().st_size==source.stat().st_size and digest(existing)==expected_sha:
            return {'state':'complete','path':str(existing),'reused':True}
    try:
        for n in range(1,10000):
            final=folder/(filename if n==1 else f'{stem} ({n}){suffix}')
            if final.exists() or final.is_symlink():
                if not final.is_symlink() and final.is_file() and final.stat().st_size==source.stat().st_size and digest(final)==expected_sha:
                    return {'state':'complete','path':str(final),'reused':True}
                continue
            if temp is None:
                temp=folder/('.courtside-'+uuid.uuid4().hex+'.tmp')
                method=clone_or_copy(source,temp,folder)
                if temp.stat().st_size!=source.stat().st_size or digest(temp)!=expected_sha:raise RuntimeError('전달용 파일 검증에 실패했습니다.')
            try:
                # Never overwrite a pre-existing file, including a concurrent export.
                os.link(temp,final)
                return {'state':'complete','path':str(final),'reused':False,'method':method}
            except FileExistsError:
                continue
            except OSError as exc:
                if exc.errno not in (errno.EPERM,errno.EXDEV,errno.EOPNOTSUPP,errno.ENOTSUP):raise
                if storage_policy.free_bytes(folder)<temp.stat().st_size+2*1024**3:
                    raise RuntimeError('전달용 파일을 복사할 저장 공간이 부족합니다.') from exc
                try:fd=os.open(final,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
                except FileExistsError:continue
                try:
                    with temp.open('rb') as src,os.fdopen(fd,'wb') as dst:
                        shutil.copyfileobj(src,dst,1024*1024);dst.flush();os.fsync(dst.fileno())
                    if digest(final)!=expected_sha:raise RuntimeError('전달용 파일 검증에 실패했습니다.')
                except Exception:
                    final.unlink(missing_ok=True);raise
                return {'state':'complete','path':str(final),'reused':False,'method':'copy'}
        raise RuntimeError('사용 가능한 전달 파일명을 찾지 못했습니다.')
    finally:
        if temp is not None:
            try:temp.unlink(missing_ok=True)
            except OSError:pass


def deliver(case_id,event_id,job_id,root=None):
    meta,source=review_videos.inspect(case_id,event_id,job_id)
    if root is None and os.environ.get('KBL_DELIVERY_MODE')=='web':
        # The verified, versioned source stays in the work store. A browser
        # download is a separate action; it does not write to the user's PC.
        return {'state':'ready-for-download','message':'영상 다운로드 준비됨'}
    case=case_store.load_case(case_id)
    event=next(e for e in case['events'] if e['id']==event_id)
    return place(source,meta['videoSha256'],case,event,root,video_filename(case,event,meta))
