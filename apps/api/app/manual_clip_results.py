"""Publish completed manual football clips into the existing clip/dual workspace.

No synthetic live Match or FinePlay request is created. Published clips belong to
their manual job. Registration can be retried after interruption; existing clip
IDs and their analyst edits are never replaced by registration.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import subprocess
import tempfile
import threading

from sqlalchemy import text
from .db import SessionLocal, engine
from .highlight_storage import default_storage, output_prefix
from .models import HighlightClip, HighlightJob

logger = logging.getLogger(__name__)
_local_locks: dict[str, threading.Lock] = {}
_local_locks_guard = threading.Lock()


@contextmanager
def publication_lock(job_id: str):
    """A connection-scoped lock releases on process loss, allowing explicit retry."""
    if engine.dialect.name == 'postgresql':
        key = int.from_bytes(hashlib.sha256(('manual-clips:' + job_id).encode()).digest()[:8], 'big', signed=True)
        with engine.connect() as conn:
            acquired = bool(conn.execute(text('SELECT pg_try_advisory_lock(:key)'), {'key': key}).scalar())
            conn.commit()
            try:
                yield acquired
            finally:
                if acquired:
                    try:
                        conn.execute(text('SELECT pg_advisory_unlock(:key)'), {'key': key})
                        conn.commit()
                    except Exception:
                        conn.invalidate()
                        raise
    else:
        # Local SQLite fixtures; production uses the database lock above.
        with _local_locks_guard:
            lock = _local_locks.setdefault(job_id, threading.Lock())
        acquired = lock.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                lock.release()


def manual_clip_id(job_id: str, name: str) -> str:
    if not re.fullmatch(r'clip_\d+\.mp4', name):
        raise ValueError('수동 클립 파일명이 올바르지 않습니다.')
    return f'manual-{job_id}-{Path(name).stem}'


def registration_state(job: HighlightJob) -> dict:
    value = (job.job_metadata or {}).get('clip_results')
    return dict(value) if isinstance(value, dict) else {}


def require_publishable(job: HighlightJob | None) -> None:
    if job is None or job.mode != 'manual':
        raise ValueError('수동 작업을 찾을 수 없습니다.')
    if str((job.job_metadata or {}).get('sport') or 'FOOTBALL').upper() != 'FOOTBALL':
        raise ValueError('FPA dual 연결은 축구 수동 클립에서 지원합니다.')
    if job.status != 'done':
        raise ValueError('하이라이트 제작이 완료된 뒤 클립결과에 연결할 수 있습니다.')
    if not (job.job_metadata or {}).get('clip_info'):
        raise ValueError('등록할 개별 클립이 없습니다.')


def _state(db, job: HighlightJob, **changes) -> None:
    job.job_metadata = {**(job.job_metadata or {}), 'clip_results': {
        **registration_state(job), **changes, 'updated_at': datetime.utcnow().isoformat(),
    }}
    db.commit()


def queue_publication(db, job: HighlightJob) -> dict:
    # A retry and clip deletion can arrive together. Read metadata under the
    # same row lock as progress/tombstones, rather than overwriting a stale copy.
    job = db.query(HighlightJob).filter_by(id=job.id).populate_existing().with_for_update().one_or_none()
    require_publishable(job)
    current = registration_state(job)
    if current.get('status') not in {'running', 'ready'}:
        _state(db, job, status='queued', error=None)
    return registration_state(job)


def _update_state(job_id: str, **changes) -> bool:
    with SessionLocal() as db:
        job = db.query(HighlightJob).filter_by(id=job_id).with_for_update().one_or_none()
        if job is None:
            return False
        _state(db, job, **changes)
        return True


def render_manual_clip(source: Path, target: Path, requested_start: float, duration: float) -> float:
    """Remove browser keyframe padding; dual time zero is the requested clip start."""
    def probe(path):
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=start_time,duration',
                                 '-of', 'json', str(path)], check=True, capture_output=True, text=True, timeout=60)
        return json.loads(result.stdout).get('format') or {}
    start = float(probe(source).get('start_time') or 0)
    offset = max(0.0, requested_start - start)
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error', '-threads', '1', '-ss', f'{offset:.6f}',
        '-i', str(source), '-t', f'{duration:.6f}', '-map', '0:v:0', '-map', '0:a?',
        '-vf', 'setpts=PTS-STARTPTS', '-af', 'asetpts=PTS-STARTPTS',
        '-c:v', 'libx264', '-threads', '1', '-preset', 'fast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', str(target),
    ], check=True, capture_output=True, text=True, timeout=1800)
    actual = float(probe(target).get('duration') or 0)
    if not math.isfinite(actual) or actual <= 0 or abs(actual - duration) > .25:
        raise ValueError('클립 길이가 요청 구간과 다릅니다. 원본 클립을 확인하세요.')
    return actual


def publish_manual_clip_results(job_id: str) -> None:
    """Background registration only; never sends a FinePlay/broadcast callback."""
    with publication_lock(job_id) as acquired:
        if not acquired:
            return
        try:
            with SessionLocal() as db:
                job = db.get(HighlightJob, job_id)
                require_publishable(job)
                metadata = dict(job.job_metadata or {})
                infos = list(metadata['clip_info'])
                directory = Path(job.clips_dir or '')
                if not job.clips_dir or not directory.is_dir():
                    raise ValueError('개별 클립 파일을 찾을 수 없습니다.')
                removed = set(registration_state(job).get('removed_clips') or [])
                infos = [info for info in infos if str(info.get('name') or '') not in removed]
                infos.sort(key=lambda info: (info.get('order') is None, info.get('order') or 0, float(info.get('requested_start') or 0)))
            storage = default_storage()
            if not storage.configured:
                raise ValueError('클립결과에 연결할 영상 저장소가 설정되지 않았습니다. 합본은 그대로 다운로드할 수 있습니다.')
            _update_state(job_id, status='running', error=None, completed=0, total=len(infos))
            seen = set()
            for index, info in enumerate(infos):
                name = str(info.get('name') or '')
                clip_id = manual_clip_id(job_id, name)
                if name in seen:
                    raise ValueError('중복된 수동 클립 파일이 있습니다.')
                seen.add(name)
                with SessionLocal() as db:
                    # Do not replace existing video, title, team, actions or fpa_scenes.
                    existing = db.get(HighlightClip, clip_id)
                    if existing is not None:
                        if existing.job_id != job_id:
                            raise ValueError('다른 작업에 연결된 클립입니다.')
                        _update_state(job_id, completed=index + 1)
                        continue
                source = directory / name
                start, end = float(info['requested_start']), float(info['requested_end'])
                if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                    raise ValueError('클립 구간이 올바르지 않습니다.')
                if not source.is_file():
                    raise ValueError(f'{name} 파일이 없습니다. 기존 등록된 분석은 유지됩니다.')
                key = f'{output_prefix().rstrip("/")}/manual/{job_id}/{name}'
                with tempfile.TemporaryDirectory(prefix='manual-clip-') as work:
                    rendered = Path(work) / name
                    duration = render_manual_clip(source, rendered, start, end - start)
                    storage.upload(rendered, key, 'video/mp4')
                # Commit each result independently. Retry skips committed clips, including edits.
                with SessionLocal() as db:
                    job = db.query(HighlightJob).filter_by(id=job_id).with_for_update().one_or_none()
                    if job is None:
                        return
                    if name in set(registration_state(job).get('removed_clips') or []):
                        continue
                    if db.get(HighlightClip, clip_id) is None:
                        kind = str(info.get('kind') or '')
                        team = 'home' if kind in {'home', 'home_goal'} else 'away' if kind in {'away', 'away_goal'} else None
                        db.add(HighlightClip(id=clip_id, job_id=job_id, order_index=index,
                            source_video_id=name, start_sec=start, end_sec=end,
                            duration_seconds=duration, team_side=team, horizontal_s3_key=key))
                    _state(db, job, completed=index + 1)
            with SessionLocal() as db:
                count = db.query(HighlightClip).filter_by(job_id=job_id).count()
            _update_state(job_id, status='ready', completed=count, error=None)
        except Exception as exc:
            logger.exception('Manual clip registration failed for %s', job_id)
            # The finished montage remains done/downloadable when registration fails.
            _update_state(job_id, status='error', error=str(exc)[:500])
