"""FPC-authenticated match authorization for the Courtside entry point.

This router deliberately grants no access to the local workbench or its files.
It mirrors the existing recording service's basketball read and edit rules.
"""
from uuid import UUID
from fastapi import APIRouter,Depends,HTTPException,Response
from sqlalchemy.orm import Session
from .auth import require_session_user
from .db import get_db
from .models import Match,User

router=APIRouter()

@router.get('/api/courtside/matches/{match_id}/access')
def match_access(match_id: UUID,response: Response,db: Session=Depends(get_db),user: User=Depends(require_session_user)):
    match=db.get(Match,match_id)
    if not match or match.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    can_edit=(not match.archived and (user.role=='SUPERADMIN' or not match.operator_id or match.operator_id==user.id))
    response.headers['Cache-Control']='private, no-store'
    return {'matchId':str(match_id),'canRead':True,'canEdit':can_edit,'workbenchReady':False}
