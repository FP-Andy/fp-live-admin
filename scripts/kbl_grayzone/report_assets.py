"""Find operator-provided report typography outside the web public directory."""
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]

def report_assets_dir():
    configured=os.environ.get('COURTSIDE_REPORT_ASSETS')
    if configured:
        path=Path(configured)
        if not path.is_absolute():raise ValueError('리포트 글꼴 경로는 절대 경로여야 합니다.')
        return path
    return ROOT/'apps/web/public/kbl-grayzone/assets/report-fonts'
