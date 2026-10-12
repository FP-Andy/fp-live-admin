"""Existing selected-clip export, executed by the bounded render worker."""
import os
import tempfile
from pathlib import Path

from .db import SessionLocal
from .highlight_jobs import safe_clip_path, exports_dir, update_job
from .models import HighlightJob


def run_selected_export(job_id):
    with SessionLocal() as db:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        names = list((job.job_metadata or {}).get('export_selection') or [])
    clips, merged = [], None
    try:
        from moviepy import VideoFileClip, concatenate_videoclips
        paths = [safe_clip_path(job_id, name) for name in names]
        if not paths or any(not path.is_file() for path in paths):
            raise ValueError('선택한 클립 파일을 찾을 수 없습니다.')
        output = exports_dir() / f'{job_id}_export.mp4'
        with tempfile.TemporaryDirectory(prefix='selected-export-', dir=exports_dir()) as work:
            temporary = Path(work) / 'output.mp4'
            clips = [VideoFileClip(str(path)) for path in paths]
            merged = concatenate_videoclips(clips)
            merged.write_videofile(str(temporary), codec='libx264', audio_codec='aac',
                temp_audiofile=str(Path(work) / 'audio.m4a'), remove_temp=True, logger=None, threads=2)
            merged.close()
            merged = None
            os.replace(temporary, output)
        with SessionLocal() as db:
            update_job(db, job_id, status='done', export_path=str(output), error_message=None)
    except Exception as exc:
        with SessionLocal() as db:
            update_job(db, job_id, status='error', error_message=f'내보내기 실패: {exc}')
    finally:
        if merged is not None:
            merged.close()
        for clip in clips:
            clip.close()
