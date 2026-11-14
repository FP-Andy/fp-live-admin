"""Server-side FPC recording reader. This module exposes no HTTP endpoint.

The caller MUST first authenticate the user, authorize the match and intake,
check the request origin, and use the server's configured bucket and client.
The worker receives byte chunks and integrity metadata, never AWS credentials,
user sessions, caller-provided URLs, or arbitrary storage keys.
"""
from hashlib import sha256
import logging
import re
import time
from uuid import UUID

PART_NAME = re.compile(r'take-[0-9]{5,}-part-[0-9]{6,}\.mp4\Z')
MAX_PART_BYTES = 2 * 1024 ** 3
CHUNK_BYTES = 512 * 1024
MAX_BYTES_PER_SECOND = 8 * 1024 ** 2

def external_relay_base(shared_root):
    """Return only the configured, mounted relay root; fail closed otherwise."""
    import json,os
    from pathlib import Path
    root=Path(shared_root).resolve();config=root/'runtime/kbl-storage.json'
    if not config.exists():return None
    try:
        data=json.loads(config.read_text());mount=Path(data['mount']);backing=Path(data['backing']);token=data['token']
        if data['schema']!='fpc-kbl-storage/v1' or not mount.is_absolute() or not backing.is_absolute() or not isinstance(token,str) or len(token)<24:raise ValueError()
        if not os.path.ismount(mount) or not os.path.ismount(backing) or (mount/'.fpc-kbl-work-storage').read_text().strip()!=token:raise ValueError()
        work=mount/'kbl-work';base=(work/'kbl-fpc-relay').resolve();link=root/'outputs/kbl-fpc-relay'
        if work.is_symlink() or (work/'kbl-fpc-relay').is_symlink() or base!=mount.resolve()/'kbl-work/kbl-fpc-relay':raise ValueError()
        if not link.is_symlink() or link.resolve()!=base or not base.is_dir():raise ValueError()
        return base,backing
    except (OSError,ValueError,KeyError,TypeError):raise ValueError('외장 녹화 저장소를 확인하세요.') from None


def _uuid(value):
    try:
        parsed = UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise ValueError('녹화 식별자를 확인하세요.') from None
    return str(parsed)


def recording_key(match_id, session_id, filename):
    mid, sid = _uuid(match_id), _uuid(session_id)
    if not isinstance(filename, str) or len(filename) > 80 or not PART_NAME.fullmatch(filename):
        raise ValueError('녹화 구간 이름을 확인하세요.')
    return f'prelaunch/recordings/{mid}/{sid}/{filename}'


def relay_part(s3, bucket, match_id, session_id, filename, sink, before_copy=None, *, head=None, offset=0, digest=None):
    """Copy one immutable recorder segment to a caller-owned bounded sink.

    `s3` and `bucket` come only from the existing FPC API configuration. `sink`
    is internal, and MUST commit atomically only after this function succeeds;
    on error it MUST keep any partial output private and bind it to this ETag.
    No paths or credentials are accepted from a browser.
    """
    if not isinstance(bucket, str) or not bucket:
        raise ValueError('녹화 저장소를 확인하세요.')
    key = recording_key(match_id, session_id, filename)
    head = head if head is not None else s3.head_object(Bucket=bucket, Key=key)
    size, etag = head.get('ContentLength'), head.get('ETag')
    if type(size) is not int or not 0 < size <= MAX_PART_BYTES or not isinstance(etag, str) or not etag:
        raise ValueError('녹화 구간 크기 또는 버전을 확인하세요.')
    if type(offset) is not int or not 0 <= offset <= size or (offset and digest is None):
        raise ValueError('이어받을 녹화 구간을 확인하세요.')
    if before_copy is not None:
        before_copy(size-offset)
    digest = digest if digest is not None else sha256()
    if offset == size:
        return {'matchId': _uuid(match_id), 'sessionId': _uuid(session_id),
                'partName': filename, 'bytes': size, 'sha256': digest.hexdigest(), 'etag': etag}
    request={'Bucket':bucket,'Key':key,'IfMatch':etag}
    if offset:request['Range']=f'bytes={offset}-'
    response = s3.get_object(**request)
    body = response.get('Body')
    if body is None:
        raise ValueError('녹화 구간을 읽지 못했습니다.')
    received = offset; started = time.monotonic(); complete = False
    try:
        if (response.get('ContentLength') != size-offset or response.get('ETag') != etag or
            (offset and response.get('ContentRange') != f'bytes {offset}-{size-1}/{size}')):
            raise ValueError('녹화 구간이 조회 중 변경됐습니다.')
        while True:
            chunk = body.read(CHUNK_BYTES)
            if not chunk:
                break
            if not isinstance(chunk, bytes) or received + len(chunk) > size:
                raise ValueError('녹화 구간 전송 크기가 일치하지 않습니다.')
            sink(chunk)
            digest.update(chunk); received += len(chunk)
            # Bound transfer pressure on the shared FPC host and network.
            delay = (received-offset) / MAX_BYTES_PER_SECOND - (time.monotonic() - started)
            if delay > 0: time.sleep(delay)
        if received != size:
            raise ValueError('녹화 구간 전송이 중단됐습니다.')
        complete = True
    finally:
        body.close()
        # Record transfer health without recording match IDs, S3 keys, ETags,
        # signed URLs or exception text in shared application logs.
        # Uvicorn's default error logger emits INFO; an unconfigured module
        # logger would inherit WARNING and silently discard these metrics.
        logging.getLogger('uvicorn.error').info(
            'courtside_s3_transfer complete=%s resumed_bytes=%d transferred_bytes=%d elapsed_seconds=%.3f',
            complete, offset, received-offset, time.monotonic()-started)
    return {'matchId': _uuid(match_id), 'sessionId': _uuid(session_id),
            'partName': filename, 'bytes': size, 'sha256': digest.hexdigest(), 'etag': etag}


def copy_part_to_shared_store(s3, bucket, shared_root, match_id, intake_id, session_id, filename, *, on_space_pressure=None):
    """Prepare one immutable segment in the private store, without clobbering.

    The caller must authorize the specific match and intake before calling.
    This does not register a verified pair or prepared wide source.
    """
    import os
    import json
    import secrets
    import stat
    from pathlib import Path

    mid, sid = _uuid(match_id), _uuid(session_id)
    if not isinstance(bucket,str) or not bucket:raise ValueError('녹화 저장소를 확인하세요.')
    if not isinstance(intake_id, str) or not re.fullmatch(r'[a-f0-9]{24}', intake_id):
        raise ValueError('접수 식별자를 확인하세요.')
    recording_key(mid, sid, filename)
    root = Path(shared_root).resolve(strict=True)
    logical_parts = ['outputs', 'kbl-fpc-relay', mid, intake_id, sid]
    external=external_relay_base(root)
    parts = [mid,intake_id,sid] if external else logical_parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(external[0] if external else root, flags)
    temporary = None
    committed = False
    try:
        for component in parts:
            try: os.mkdir(component, 0o700, dir_fd=directory)
            except FileExistsError: pass
            try: next_directory = os.open(component, flags, dir_fd=directory)
            except OSError: raise ValueError('공유 저장소 경로를 확인하세요.') from None
            os.close(directory); directory = next_directory
        key=recording_key(mid,sid,filename)
        head=s3.head_object(Bucket=bucket,Key=key)
        size,etag=head.get('ContentLength'),head.get('ETag')
        if type(size) is not int or not 0<size<=MAX_PART_BYTES or not isinstance(etag,str) or not etag:
            raise ValueError('녹화 구간 크기 또는 버전을 확인하세요.')
        identity={'bucket':bucket,'key':key,'size':size,'etag':etag}
        name=sha256((bucket+'\0'+key).encode()).hexdigest()
        temporary='.incoming-'+name+'.part'; marker='.incoming-'+name+'.json'
        try:
            marker_fd=os.open(marker,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
            with os.fdopen(marker_fd,'rb') as saved:
                if not stat.S_ISREG(os.fstat(saved.fileno()).st_mode):raise ValueError('이어받기 정보를 확인하세요.')
                previous=json.loads(saved.read(16385))
        except FileNotFoundError:previous=None
        except (ValueError,UnicodeDecodeError):previous=None
        if previous!=identity:
            for stale in (temporary,marker):
                try:os.unlink(stale,dir_fd=directory)
                except FileNotFoundError:pass
            marker_tmp='.incoming-'+secrets.token_hex(16)+'.json.tmp'
            try:
                fd=os.open(marker_tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
                with os.fdopen(fd,'w') as out:
                    json.dump(identity,out);out.flush();os.fsync(out.fileno())
                os.replace(marker_tmp,marker,src_dir_fd=directory,dst_dir_fd=directory)
            finally:
                try:os.unlink(marker_tmp,dir_fd=directory)
                except FileNotFoundError:pass
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'r+b') as target:
            info=os.fstat(target.fileno())
            if not stat.S_ISREG(info.st_mode):raise ValueError('이어받을 파일을 확인하세요.')
            if info.st_size>size:target.truncate(0);info=os.fstat(target.fileno())
            offset=info.st_size;digest=sha256()
            for block in iter(lambda:target.read(CHUNK_BYTES),b''):digest.update(block)
            def check_space(size):
                def available():
                    fs = os.fstatvfs(target.fileno())
                    free=fs.f_bavail * fs.f_frsize
                    if external:
                        backing=os.statvfs(external[1]);free=min(free,backing.f_bavail*backing.f_frsize)
                    return free
                free=available()
                if free < size + 2 * 1024 ** 3 and on_space_pressure is not None:
                    on_space_pressure()
                    free=available()
                if free < size + 2 * 1024 ** 3:
                    raise ValueError('녹화 구간과 여유 공간이 부족합니다.')
            try:meta = relay_part(s3, bucket, mid, sid, filename, target.write, check_space,head=head,offset=offset,digest=digest)
            finally:target.flush(); os.fsync(target.fileno())
        final = filename[:-4] + '-' + meta['sha256'] + '.mp4'
        try:
            os.link(temporary, final, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        except FileExistsError:
            try: existing_fd = os.open(final, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            except OSError: raise ValueError('기존 보관 구간을 확인하세요.') from None
            with os.fdopen(existing_fd, 'rb') as existing:
                info = os.fstat(existing.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != meta['bytes']:
                    raise ValueError('기존 보관 구간을 확인하세요.') from None
                check = sha256()
                for block in iter(lambda: existing.read(CHUNK_BYTES), b''):
                    check.update(block)
            if check.hexdigest() != meta['sha256']:
                raise ValueError('기존 보관 구간의 해시가 일치하지 않습니다.') from None
        committed=True
        return {**meta, 'intakeId': intake_id, 'relativePath': '/'.join([*logical_parts, final])}
    finally:
        if temporary and committed:
            for name in (temporary,marker):
                try: os.unlink(name, dir_fd=directory)
                except FileNotFoundError: pass
        os.close(directory)
