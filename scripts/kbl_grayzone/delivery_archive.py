"""Stream one game's verified deliverables without storing a duplicate ZIP."""
import json
import shutil
import zipfile
from pathlib import Path

import case_store
import report_delivery
import report_versions
import review_videos
import video_delivery


def plan(case_id):
    case = case_store.load_case(case_id)
    events = case.get('events') or []
    if not events:
        raise ValueError('판독 장면이 없습니다.')
    try:
        pdf = report_versions.latest_file(case_id)
    except (ValueError, OSError, RuntimeError) as exc:
        raise RuntimeError('저장된 PDF를 확인해 주세요.') from exc
    group, _ = video_delivery.names(case, events[0])
    files = [(report_delivery.filename(case), pdf)]
    missing = []
    for event in events:
        eid = event['id']
        folder = review_videos.folder(case_id, eid)
        candidates = []
        if folder.is_dir():
            for meta in folder.glob('*.json'):
                if not review_videos.ID.fullmatch(meta.stem) or meta.is_symlink():
                    continue
                try:
                    data = json.loads(meta.read_text())
                    if data.get('poseMode', 'map') == 'refit' or data.get('playerOrientation', 'map') != 'map':
                        continue
                    candidates.append((meta.stat().st_mtime_ns, meta.stem))
                except (OSError, ValueError, TypeError):
                    continue
        selected = None
        for _, job in sorted(candidates, reverse=True):
            try:
                meta, video = review_videos.inspect(case_id, eid, job)
                selected = (video_delivery.video_filename(case, event, meta), video)
                break
            except (OSError, ValueError, KeyError, RuntimeError, StopIteration):
                continue
        if selected is None:
            missing.append(str(event.get('number', eid)))
        else:
            files.append(selected)
    if missing:
        raise RuntimeError('현재 장면과 일치하는 영상이 없습니다: ' + ', '.join(missing) + '번')
    if len({name for name, _ in files}) != len(files):
        raise ValueError('판독 장면 번호가 중복되어 파일명을 구분할 수 없습니다.')
    return {'folder': group, 'files': files, 'videoCount': len(events)}


def write(plan, stream):
    # PDF and MP4 are already compressed. ZIP_STORED keeps CPU and memory use low.
    # The unseekable HTTP stream uses ZIP data descriptors and supports ZIP64.
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for name, source in plan['files']:
            with Path(source).open('rb') as src, archive.open(plan['folder'] + '/' + name, 'w', force_zip64=True) as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
