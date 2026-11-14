"""A4 KBL report packaging for locally captured, versioned review pages."""
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import threading
from PIL import Image

LOCK = threading.Lock()


def validate_report(payload, scene_lookup, clips):
    if not isinstance(payload,dict):raise ValueError('리포트 객체가 필요합니다.')
    if payload.get('schema') != 'kbl-report/v1':raise ValueError('지원하지 않는 리포트 형식입니다.')
    scenes = payload.get('scenes', [])
    pages = payload.get('pages', [])
    if not isinstance(scenes,list) or not 1 <= len(scenes) <= 10:
        raise ValueError('판독 장면은 1개부터 10개까지 담을 수 있습니다.')
    if not isinstance(pages,list) or len(pages) != len(scenes)+1:
        raise ValueError('요약 1페이지와 장면별 페이지가 필요합니다.')
    matches=set()
    for s in scenes:
        if not isinstance(s,dict):raise ValueError('장면 형식이 올바르지 않습니다.')
        key=s.get('clipId');source=s.get('analysisSource')
        if key not in clips or source not in ('legacy','basketball','nas'):
            raise ValueError('경기 또는 분석 결과를 확인할 수 없습니다.')
        matches.add(clips[key]['match_id'])
        if isinstance(s.get('time'),bool) or not isinstance(s.get('time'),(int,float)) or not math.isfinite(s['time']) or not 0 <= s['time'] < clips[key]['file_duration_seconds']:
            raise ValueError('판독 시각이 영상 범위를 벗어났습니다.')
        latest=scene_lookup(key,source)
        if not s.get('datasetId') or s['datasetId'] != latest['datasetId'] or source != latest['analysisSource']:
            raise RuntimeError('추적 결과가 갱신됐습니다. 해당 장면을 다시 담아주세요.')
        if len(str(s.get('note',''))) > 700:raise ValueError('장면별 의견은 700자 이하로 작성하세요.')
        pose=s.get('poseEstimate')
        if pose and pose.get('jobId'):
            from pose_jobs import result
            saved=result(pose['jobId'])
            if any(saved.get(k)!=pose.get(k) for k in ('revision','meshSha256','frameIndex','manualJointCount','manualArmCount','pipelineVersion')) or any(saved.get(k)!=s.get(k) for k in ('clipId','datasetId','frameIndex')) or saved['anchors']!=s.get('calibration',{}).get('anchors'):
                raise RuntimeError('자세 개정 또는 프레임이 다릅니다. 해당 장면을 다시 담아주세요.')
    if len(matches)!=1:raise ValueError('한 리포트에는 같은 경기의 장면만 담아주세요.')
    for field,limit in (('title',80),('reviewer',60)):
        if not isinstance(payload.get(field,''),str) or len(payload.get(field,''))>limit:
            raise ValueError('제목 또는 작성자 길이를 확인하세요.')
    return scenes,pages


def create_report(payload, root, scene_lookup, clips):
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    if not LOCK.acquire(blocking=False):raise RuntimeError('다른 PDF를 생성 중입니다. 잠시 후 다시 시도하세요.')
    try:
        scenes,pages=validate_report(payload,scene_lookup,clips)
        buffer=io.BytesIO();pdf=Canvas(buffer,pagesize=A4,pageCompression=1)
        pdf.setTitle(payload.get('title') or 'KBL 판독 장면 리포트')
        pdf.setAuthor(payload.get('reviewer') or 'Fineplay')
        pdf.setSubject('KBL 위치 기반 시야 검토 초안 - 실제 시선 또는 판정 결론이 아님')
        for page in pages:
            if not isinstance(page,str) or not page.startswith('data:image/jpeg;base64,') or len(page)>6_000_000:
                raise ValueError('리포트 페이지 이미지를 확인하세요.')
            raw=base64.b64decode(page.split(',',1)[1],validate=True)
            try:image=Image.open(io.BytesIO(raw))
            except (OSError,Image.DecompressionBombError) as e:raise ValueError('페이지 이미지를 읽을 수 없습니다.') from e
            if image.format!='JPEG' or image.size!=(1240,1754):raise ValueError('A4 페이지 크기가 올바르지 않습니다.')
            try:image.load()
            except OSError as e:raise ValueError('페이지 이미지가 손상됐습니다.') from e
            pdf.drawImage(ImageReader(image),0,0,width=A4[0],height=A4[1])
            pdf.showPage()
        pdf.save()
        # Recheck all dataset versions after rendering, immediately before save.
        validate_report(payload,scene_lookup,clips)
        data=buffer.getvalue();report_id=hashlib.sha256(data).hexdigest()[:24]
        root=Path(root);root.mkdir(parents=True,exist_ok=True)
        metadata={k:v for k,v in payload.items() if k!='pages'}
        metadata.update(reportId=report_id,pageCount=len(pages),pdfSha256=hashlib.sha256(data).hexdigest(),
                        rendering='A4 150dpi raster pages with KBL fonts; source data retained in JSON',
                        status='review-draft',identityConfirmed=False)
        (root/f'{report_id}.pdf.tmp').write_bytes(data)
        (root/f'{report_id}.json.tmp').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
        (root/f'{report_id}.json.tmp').replace(root/f'{report_id}.json')
        (root/f'{report_id}.pdf.tmp').replace(root/f'{report_id}.pdf')
        return {'reportId':report_id,'pageCount':len(pages),'pdf':f'/reports/{report_id}.pdf','json':f'/reports/{report_id}.json'}
    finally:
        LOCK.release()
