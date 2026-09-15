"""Reusable team crests and match-specific kit colours for FCM and Broadcast."""
import io
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from .auth import require_session_user
from .db import get_db
from .lineup_pdf import team_key
from .models import CompetitionClass, Match, TeamLogo, User

BRANDING_DEFAULTS = {'home_color': '#ff7900', 'away_color': '#3d22f3', 'home_logo_url': '', 'away_logo_url': ''}


def match_team_names(match: Match) -> dict:
    metadata = match.metadata_json or {}
    lineup = metadata.get('lineups') or {}
    names = lineup.get('team_names') or {}
    info = metadata.get('lineup_team_info') or {}
    title = re.sub(r'^\s*\[[^\]]+\]\s*', '', match.name or '')
    parts = re.split(r'\s+vs\.?\s+', title, maxsplit=1, flags=re.I)
    return {
        side: str(metadata.get(f'{side.lower()}_team') or names.get(side)
                  or (info.get(side) or {}).get('name') or (parts[i] if len(parts) == 2 else side)).strip()
        for i, side in enumerate(('HOME', 'AWAY'))
    }


def team_logo_urls(match: Match, db: Session | None = None) -> dict:
    db = db or object_session(match)
    if db is None:
        return {}
    keys = {side: team_key(name) for side, name in match_team_names(match).items()}
    rows = db.scalars(select(TeamLogo).where(
        TeamLogo.competition_class == str(match.competition_class or '').strip().upper(),
        TeamLogo.team_key.in_(keys.values()),
    )).all()
    urls = {row.team_key: f'/api/broadcast/assets/logos/{row.filename}' for row in rows}
    return {side: urls.get(key, '') for side, key in keys.items()}


def resolve_branding(metadata: dict, logos: dict | None = None) -> dict:
    """Explicit per-match edits win; automatically derived values stay live.

    Old saved states have no provenance. Keep their non-default colours and
    non-empty logos, while allowing the old default palette to adopt PDF kits.
    """
    stored = metadata.get('broadcast') or {}
    stored_sources = stored.get('branding_sources') or {}
    uniforms = (metadata.get('lineups') or {}).get('uniforms') or {}
    values, sources = {}, {}
    for key, fallback in BRANDING_DEFAULTS.items():
        side = key.split('_')[0].upper()
        is_color = key.endswith('_color')
        saved = stored.get(key)
        saved_valid = bool(re.fullmatch(r'#[0-9a-fA-F]{6}', str(saved or ''))) if is_color else bool(saved)
        source = stored_sources.get(key)
        manual = source == 'manual' or (source is None and saved_valid and str(saved).lower() != fallback.lower())
        automatic = (((uniforms.get(side) or {}).get('field') or {}).get('shirt') or {}).get('hex') if is_color else (logos or {}).get(side)
        if is_color and not re.fullmatch(r'#[0-9a-fA-F]{6}', str(automatic or '')):
            automatic = None
        if manual and saved_valid:
            values[key], sources[key] = saved, 'manual'
        elif automatic:
            values[key], sources[key] = automatic, 'pdf' if is_color else 'team_logo'
        else:
            values[key], sources[key] = fallback, 'default'
    return {**values, 'branding_sources': sources}


def mark_manual_branding(state: dict, changes: dict) -> dict:
    sources = dict(state.get('branding_sources') or {})
    for key in BRANDING_DEFAULTS:
        if changes.get(key):
            sources[key] = 'manual'
    return {**state, 'branding_sources': sources}


def reset_branding(metadata: dict) -> dict:
    state = dict(metadata.get('broadcast') or {})
    for key in BRANDING_DEFAULTS:
        state.pop(key, None)
    state.pop('branding_sources', None)
    return {**metadata, 'broadcast': state}


def logo_payload(row: TeamLogo) -> dict:
    return {'id': str(row.id), 'competition_class': row.competition_class, 'team_name': row.team_name,
            'logo_url': f'/api/broadcast/assets/logos/{row.filename}', 'updated_at': row.updated_at.isoformat()}


def create_team_logo_router(logo_dir: Path, on_changed: Callable[[list[uuid.UUID]], None] | None = None) -> APIRouter:
    router = APIRouter(prefix='/api/fcm/team-logos', tags=['FCM team logos'])

    def notify(db: Session, competition: str, key: str):
        if on_changed is None:
            return
        matches = db.scalars(select(Match).where(Match.competition_class == competition)).all()
        on_changed([match.id for match in matches if key in {team_key(name) for name in match_team_names(match).values()}])

    @router.get('')
    def list_logos(db: Session = Depends(get_db), _user: User = Depends(require_session_user)):
        return [logo_payload(row) for row in db.scalars(select(TeamLogo).order_by(TeamLogo.competition_class, TeamLogo.team_name))]

    @router.post('')
    async def upload_logo(competition_class: str = Form(...), team_name: str = Form(...), file: UploadFile = File(...),
                          db: Session = Depends(get_db), user: User = Depends(require_session_user)):
        competition = competition_class.strip().upper()
        name = re.sub(r'\s+', ' ', team_name).strip()
        key = team_key(name)
        if not key or len(name) > 160 or len(key) > 160:
            raise HTTPException(400, '팀명은 1~160자로 입력하세요.')
        if not db.get(CompetitionClass, competition):
            raise HTTPException(400, '등록된 대회를 선택하세요.')
        payload = await file.read(5 * 1024 * 1024 + 1)
        if not payload or len(payload) > 5 * 1024 * 1024:
            raise HTTPException(400, '로고는 5MB 이하의 PNG, JPG, WEBP 파일로 업로드하세요.')
        try:
            with Image.open(io.BytesIO(payload)) as source:
                if source.format not in {'PNG', 'JPEG', 'WEBP'} or source.width * source.height > 16_000_000:
                    raise ValueError('Unsupported image')
                source.load()
                image = source.convert('RGBA')
                image.thumbnail((2048, 2048))
                output = io.BytesIO()
                image.save(output, format='PNG')
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
            raise HTTPException(400, '읽을 수 없는 이미지입니다. 1,600만 화소 이하의 PNG, JPG, WEBP 파일을 선택하세요.') from error

        logo_dir.mkdir(parents=True, exist_ok=True)
        filename = f'team-{uuid.uuid4().hex}.png'
        path = logo_dir / filename
        path.write_bytes(output.getvalue())
        row = db.scalar(select(TeamLogo).where(TeamLogo.competition_class == competition, TeamLogo.team_key == key))
        if row is None:
            row = TeamLogo(competition_class=competition, team_key=key)
            db.add(row)
        row.team_name, row.filename, row.updated_by = name, filename, user.id
        row.updated_at = datetime.utcnow()
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            path.unlink(missing_ok=True)
            raise HTTPException(409, '동일한 팀 로고가 방금 변경되었습니다. 목록을 새로고침하고 다시 등록하세요.') from error
        db.refresh(row)
        notify(db, competition, key)
        return logo_payload(row)

    @router.delete('/{logo_id}')
    def delete_logo(logo_id: uuid.UUID, db: Session = Depends(get_db), _user: User = Depends(require_session_user)):
        row = db.get(TeamLogo, logo_id)
        if row is None:
            raise HTTPException(404, '등록된 로고를 찾지 못했습니다.')
        competition, key = row.competition_class, row.team_key
        db.delete(row)
        db.commit()
        # Existing archived images may still reference the immutable file.
        notify(db, competition, key)
        return {'ok': True}

    return router
