"""Conservative cleanup of abandoned, reproducible S3 transfer fragments.

The caller must hold the same exclusive relay lock as all downloads. Completed
MP4s and active/recent matches are never candidates.
"""
from datetime import date
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
import time

from .courtside_recording_source import MAX_PART_BYTES, _uuid, external_relay_base, recording_key

MIN_AGE = 7 * 24 * 60 * 60
PARTIAL = re.compile(r'^\.incoming-([a-f0-9]{64})\.json$')
INTAKE = re.compile(r'^[a-f0-9]{24}$')


def protected_matches(current, rows):
    """Protect the latest three and current game plus its two predecessors.

    Missing or ambiguous metadata disables cleanup rather than guessing order.
    """
    try:
        current = _uuid(current)
        if not isinstance(rows, list): return None
        games = {}
        for row in rows:
            if not isinstance(row, dict): return None
            if not row.get('fpcMatchId'): continue
            mid = _uuid(row['fpcMatchId'])
            number = str(row.get('gameNumber', '')).strip()
            if not number.isdigit(): return None
            key = (date.fromisoformat(row['date']), int(number))
            if mid in games and games[mid] != key: return None
            games[mid] = key
        if current not in games: return None
        all_keys = sorted(games.values(), reverse=True)
        latest = all_keys[min(3, len(all_keys)) - 1]
        prior = sorted((x for x in games.values() if x <= games[current]), reverse=True)
        cutoff = prior[min(3, len(prior)) - 1]
        return {mid for mid, key in games.items() if key >= latest or cutoff <= key <= games[current]} | {current}
    except (ValueError, TypeError, KeyError):
        return None


def clean_stale_partials(root, s3, bucket, current, rows, *, now=None, max_checks=2):
    """Remove a small number of old partials only after rechecking S3.

    Metadata is private and untrusted. Each directory and file is opened without
    following symlinks. A failed check preserves the fragment. The caller holds
    the exclusive relay lock throughout this operation.
    """
    protected = protected_matches(current, rows)
    if protected is None or not isinstance(bucket, str) or not bucket or max_checks < 1:
        return {'removed': 0, 'bytes': 0}
    root = Path(root).resolve(strict=True)
    external = external_relay_base(root)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        base_fd = os.open(external[0] if external else root, flags)
        if not external:
            try:
                for component in ('outputs','kbl-fpc-relay'):
                    child=os.open(component,flags,dir_fd=base_fd)
                    os.close(base_fd);base_fd=child
            except BaseException:
                os.close(base_fd);raise
    except OSError: return {'removed': 0, 'bytes': 0}
    cutoff = (time.time() if now is None else now) - MIN_AGE
    result = {'removed': 0, 'bytes': 0}
    checks = 0
    try:
        with os.scandir(base_fd) as matches:
            for match in matches:
                try:
                    if not match.is_dir(follow_symlinks=False) or _uuid(match.name) != match.name or match.name in protected: continue
                    match_fd = os.open(match.name, flags, dir_fd=base_fd)
                except (OSError, ValueError): continue
                try:
                    with os.scandir(match_fd) as intakes:
                        for intake in intakes:
                            if not INTAKE.fullmatch(intake.name) or not intake.is_dir(follow_symlinks=False): continue
                            try: intake_fd = os.open(intake.name, flags, dir_fd=match_fd)
                            except OSError: continue
                            try:
                                with os.scandir(intake_fd) as sessions:
                                    for session in sessions:
                                        try:
                                            if not session.is_dir(follow_symlinks=False) or _uuid(session.name) != session.name: continue
                                            session_fd = os.open(session.name, flags, dir_fd=intake_fd)
                                        except (OSError, ValueError): continue
                                        try:
                                            with os.scandir(session_fd) as entries:
                                                for entry in entries:
                                                    parsed = PARTIAL.fullmatch(entry.name)
                                                    if not parsed or not entry.is_file(follow_symlinks=False): continue
                                                    part = '.incoming-' + parsed[1] + '.part'
                                                    try:
                                                        marker_fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=session_fd)
                                                        with os.fdopen(marker_fd, 'rb') as marker:
                                                            ms = os.fstat(marker.fileno())
                                                            data = json.loads(marker.read(16385))
                                                        ps = os.stat(part, dir_fd=session_fd, follow_symlinks=False)
                                                        if not stat.S_ISREG(ms.st_mode) or not stat.S_ISREG(ps.st_mode) or max(ms.st_mtime, ps.st_mtime) > cutoff: continue
                                                        if not isinstance(data, dict) or set(data) != {'bucket', 'key', 'size', 'etag'} or data['bucket'] != bucket: continue
                                                        size, key, etag = data['size'], data['key'], data['etag']
                                                        if type(size) is not int or not 0 < ps.st_size <= size <= MAX_PART_BYTES or not isinstance(key, str) or not isinstance(etag, str) or not etag: continue
                                                        if recording_key(match.name, session.name, key.rsplit('/', 1)[-1]) != key: continue
                                                        if sha256((bucket+'\0'+key).encode()).hexdigest() != parsed[1]: continue
                                                        checks += 1
                                                        try: remote = s3.head_object(Bucket=bucket, Key=key)
                                                        except Exception: remote = {}
                                                        if remote.get('ContentLength') == size and remote.get('ETag') == etag:
                                                            after = os.stat(part, dir_fd=session_fd, follow_symlinks=False)
                                                            again = os.stat(entry.name, dir_fd=session_fd, follow_symlinks=False)
                                                            same = lambda a,b:(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns)
                                                            if same(ps,after) and same(ms,again):
                                                                os.unlink(part, dir_fd=session_fd)
                                                                os.unlink(entry.name, dir_fd=session_fd)
                                                                result['removed'] += 1; result['bytes'] += ps.st_size
                                                        if checks >= max_checks: return result
                                                    except (OSError, ValueError, TypeError, KeyError, UnicodeDecodeError): continue
                                        finally: os.close(session_fd)
                            finally: os.close(intake_fd)
                finally: os.close(match_fd)
    finally: os.close(base_fd)
    return result
