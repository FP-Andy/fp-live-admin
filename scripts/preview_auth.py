"""Local SQLite host for the production auth router; never uses production data."""
from contextlib import asynccontextmanager
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
AUTH_DIR = ROOT / 'runtime/auth'
AUTH_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
os.umask(0o077)
os.environ['DATABASE_URL'] = 'sqlite:///' + str(AUTH_DIR / 'preview.sqlite3')
os.environ.setdefault('FPC_ADMIN_ACCOUNTS_FILE', str(AUTH_DIR / 'admin-accounts.json'))
sys.path.insert(0, str(ROOT / 'apps/api'))
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from app.auth import bootstrap_admin_accounts, require_session_user, router
from app.db import Base, SessionLocal, engine, get_db
from app.models import AdminAccount, AuditLog, AuthSession, CompetitionClass, LoginThrottle, Match, OperatorAccessPolicy, TeamLogo, User
from app.lineup_pdf import parse_lineup_pdf
from app.team_branding import create_team_logo_router, mark_manual_branding, reset_branding, resolve_branding, team_logo_urls
from sqlalchemy.orm import Session

LOGO_DIR = ROOT / 'runtime/broadcast/logos'

@compiles(JSONB, 'sqlite')
def jsonb_as_json(element, compiler, **kwargs):
    return 'JSON'

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (User, AdminAccount, OperatorAccessPolicy, AuthSession, LoginThrottle, AuditLog, CompetitionClass, TeamLogo)])
    with SessionLocal() as db:
        count = bootstrap_admin_accounts(db)
        for code in ('K3', 'DEMO'):
            if not db.get(CompetitionClass, code):
                db.add(CompetitionClass(code=code, name=code))
        db.commit()
    print(f'Local authentication ready: {count} allowlisted administrators.')
    yield

app = FastAPI(lifespan=lifespan)
app.include_router(router)
app.include_router(create_team_logo_router(LOGO_DIR))

@app.get('/api/broadcast/assets/logos/{filename}')
def preview_logo(filename: str):
    path = (LOGO_DIR / filename).resolve()
    if path.parent != LOGO_DIR.resolve() or not path.is_file():
        raise HTTPException(404, 'Logo not found')
    return FileResponse(path)

@app.post('/api/preview/lineup/pdf')
async def preview_pdf(file: UploadFile = File(...), first_team_side: str = Form('AUTO'), _user: User = Depends(require_session_user)):
    try:
        lineup = await run_in_threadpool(parse_lineup_pdf, await file.read(20 * 1024 * 1024 + 1), first_team_side=first_team_side)
        return {'ok': True, 'lineups': lineup}
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

@app.post('/api/preview/branding')
def preview_branding(body: dict = Body(...), db: Session = Depends(get_db), _user: User = Depends(require_session_user)):
    match = Match(name=body.get('name') or '', competition_class=body.get('competition_class') or 'DEMO', metadata_json=body.get('metadata') or {})
    previous = resolve_branding(match.metadata_json, team_logo_urls(match, db))
    changes = body.get('changes') or {}
    metadata = {**match.metadata_json, 'broadcast': mark_manual_branding({**previous, **changes}, changes)}
    if changes.get('branding_reset') is True:
        metadata = reset_branding(metadata)
    return resolve_branding(metadata, team_logo_urls(match, db))

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=4317, access_log=False)
