"""Local storage configuration; never silently fall back from external storage."""
import json,os,shutil
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
CONFIG=ROOT/'runtime/kbl-storage.json'
MANAGED=('kbl-cases','kbl-intake','kbl-wide-preparation','kbl-pose-frames','kbl-video-jobs','kbl-fpc-relay')
MARKER='.fpc-kbl-work-storage'

def config():
    if not CONFIG.exists():return None
    try:
        data=json.loads(CONFIG.read_text())
        if data.get('schema')!='fpc-kbl-storage/v1':raise ValueError()
        mount=Path(data['mount']);backing=Path(data['backing']);token=data['token']
        if not mount.is_absolute() or not backing.is_absolute() or not isinstance(token,str) or len(token)<24:raise ValueError()
        return {'mount':mount,'backing':backing,'token':token}
    except (OSError,ValueError,KeyError,TypeError):raise RuntimeError('작업 저장소 설정을 확인하세요.') from None

def external_root():
    cfg=config()
    if cfg is None:return None
    try:
        mount=cfg['mount']
        if not os.path.ismount(mount) or not os.path.ismount(cfg['backing']) or (mount/MARKER).read_text().strip()!=cfg['token']:
            raise OSError()
        work=mount/'kbl-work'
        if work.is_symlink() or work.resolve()!=mount.resolve()/'kbl-work':raise OSError()
        return work.resolve()
    except OSError:raise RuntimeError('외장 작업 저장소를 찾을 수 없습니다. 드라이브 연결과 자동 연결 상태를 확인하세요.') from None

def managed_path(path):
    path=Path(path)
    return any(path==ROOT/'outputs'/name or path.is_relative_to(ROOT/'outputs'/name) for name in MANAGED) or path==ROOT/'output/pdf' or path.is_relative_to(ROOT/'output/pdf')

def free_bytes(path):
    path=Path(path);cfg=config()
    if cfg and (managed_path(path) or path.resolve().is_relative_to(cfg['mount'].resolve())):
        external=external_root()
        for name in MANAGED:
            link=ROOT/'outputs'/name
            if not link.is_symlink() or link.resolve()!=external/name:
                raise RuntimeError('외장 작업 저장 경로가 변경됐습니다. 저장소 연결을 확인하세요.')
        pdf=ROOT/'output/pdf'
        if not pdf.is_symlink() or pdf.resolve()!=external/'kbl-pdf':raise RuntimeError('외장 리포트 저장 경로를 확인하세요.')
        return min(shutil.disk_usage(cfg['mount']).free,shutil.disk_usage(cfg['backing']).free)
    return shutil.disk_usage(path if path.exists() else ROOT).free

def allowed_wide_clip(path):
    path=Path(path).resolve()
    if path.is_relative_to(ROOT.resolve()):return True
    root=external_root()
    return bool(root and path.is_relative_to((root/'kbl-wide-preparation').resolve()))

def allowed_relay(path):
    path=Path(path).resolve()
    if path.is_relative_to(ROOT.resolve()):return True
    root=external_root()
    return bool(root and path.is_relative_to((root/'kbl-fpc-relay').resolve()))

def scratch_dir():
    root=external_root()
    if root is None:return None
    path=root/'scratch';path.mkdir(parents=True,exist_ok=True)
    return path
