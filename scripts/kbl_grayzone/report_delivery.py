"""Deliver verified PDF revisions alongside each game's videos."""
import case_store
import os
import report_versions
import video_delivery

def filename(case):
    _,name=video_delivery.names(case,{'number':1})
    return name.removesuffix('경기 판독 영상 01.mp4')+'경기 판독 리포트.pdf'

def deliver(case_id,version,root=None):
    source=report_versions.file(case_id,version)
    if root is None and os.environ.get('KBL_DELIVERY_MODE')=='web':
        return {'state':'ready-for-download','message':'PDF 다운로드 준비됨'}
    case=case_store.load_case(case_id)
    return video_delivery.place(source,report_versions.sha(source),case,{'number':1},root,filename(case))

def result(case_id,version):
    try:return deliver(case_id,version)
    except Exception as exc:
        from diagnostics import safe
        detail=safe(exc)[:250] if isinstance(exc,(ValueError,RuntimeError,OSError)) else '전달 폴더를 확인해 주세요.'
        return {'state':'failed','message':detail}
