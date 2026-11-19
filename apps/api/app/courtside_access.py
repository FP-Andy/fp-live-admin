"""FPC-authenticated match authorization for the Courtside entry point.

This router deliberately grants no access to the local workbench or its files.
Editing review materials remains available after a match is archived.
"""
import hashlib,json,re,time
from datetime import datetime,timedelta
from uuid import UUID
from fastapi import APIRouter,Depends,HTTPException,Response,Request
from sqlalchemy import select,delete
from sqlalchemy.orm import Session
from .auth import require_session_user
from .db import get_db
from .models import AdminAccount,CourtsideEditor,CourtsidePresence,Match,User

router=APIRouter()

def can_edit_courtside(match: Match,user: User,db:Session) -> bool:
    """Keep match ownership checks while allowing post-game review work."""
    return user.role=='SUPERADMIN' or not match.operator_id or match.operator_id==user.id or bool(db.get(CourtsideEditor,(match.id,user.id)))

def editor_ids(db,match_id):
    return sorted(db.scalars(select(CourtsideEditor.user_id).where(CourtsideEditor.match_id==match_id)).all())

def active_admins(db):
    return db.scalars(select(User).join(AdminAccount,AdminAccount.user_id==User.id)
        .where(AdminAccount.active.is_(True),User.role=='SUPERADMIN').order_by(User.name,User.id)).all()

def can_manage_editors(match,user):
    return user.role=='SUPERADMIN' or bool(match.operator_id and match.operator_id==user.id)

def editors_version(match,ids):
    return hashlib.sha256(json.dumps({'owner':match.operator_id,'editors':sorted(ids)},sort_keys=True,separators=(',',':')).encode()).hexdigest()

def record_presence(db,match_id,user,payload):
    """Show recent activity only; never trust a client-supplied identity."""
    records=payload.get('records') if isinstance(payload,dict) else None
    if not isinstance(records,list) or not records:return
    row=max((r for r in records if isinstance(r,dict) and type(r.get('endedAtMs')) in (int,float)),key=lambda r:r['endedAtMs'],default=None)
    if not row or row.get('attention')!='active' or not time.time()*1000-120000<=row['endedAtMs']<=time.time()*1000+5000:return
    if row.get('stage') not in ('frame','objects','joints','spatial','report'):return
    event=row.get('eventId')
    if event is not None and (not isinstance(event,str) or not re.fullmatch(r'review-\d+',event) or len(event)>24):return
    now=datetime.utcnow()
    db.merge(CourtsidePresence(match_id=match_id,user_id=user.id,stage=row['stage'],event_id=event,updated_at=now))
    db.execute(delete(CourtsidePresence).where(CourtsidePresence.updated_at<now-timedelta(days=1)))
    db.commit()

@router.get('/api/courtside/matches/{match_id}/access')
def match_access(match_id: UUID,response: Response,db: Session=Depends(get_db),user: User=Depends(require_session_user)):
    match=db.get(Match,match_id)
    if not match or match.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    can_edit=can_edit_courtside(match,user,db)
    response.headers['Cache-Control']='private, no-store'
    return {'matchId':str(match_id),'canRead':True,'canEdit':can_edit,'canManageEditors':can_manage_editors(match,user),'workbenchReady':False}

@router.get('/api/courtside/matches/{match_id}/presence')
def presence(match_id:UUID,response:Response,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    match=db.get(Match,match_id)
    if not match or match.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    cutoff=datetime.utcnow()-timedelta(minutes=2)
    rows=db.execute(select(CourtsidePresence,User.name).join(User,User.id==CourtsidePresence.user_id).where(CourtsidePresence.match_id==match_id,CourtsidePresence.updated_at>=cutoff).order_by(CourtsidePresence.updated_at.desc())).all()
    response.headers['Cache-Control']='private, no-store'
    return {'people':[{'name':name,'stage':p.stage,'eventId':p.event_id,'updatedAt':p.updated_at.isoformat()+'Z'} for p,name in rows]}

@router.get('/api/courtside/matches/{match_id}/editors')
def editors(match_id:UUID,response:Response,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    match=db.get(Match,match_id)
    if not match or match.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    if not can_manage_editors(match,user):raise HTTPException(403,'작업자 관리 권한이 없습니다.')
    users=active_admins(db)
    response.headers['Cache-Control']='private, no-store'
    ids=editor_ids(db,match_id)
    eligible={u.id for u in users}
    return {'version':editors_version(match,ids),'editorIds':[ident for ident in ids if ident in eligible],'users':[{'id':u.id,'name':u.name} for u in users]}

@router.post('/api/courtside/matches/{match_id}/editors')
def save_editors(match_id:UUID,request:Request,body:dict,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    # Use the same public-origin policy as the scoped workbench writes.
    from .courtside_bridge import require_origin
    require_origin(request)
    if set(body)!={'version','editorIds'} or not isinstance(body['version'],str) or not isinstance(body['editorIds'],list):raise HTTPException(400,'작업자 명단을 확인하세요.')
    ids=body['editorIds']
    if len(ids)>50 or any(not isinstance(x,str) or not 0<len(x)<=100 for x in ids) or len(set(ids))!=len(ids):raise HTTPException(400,'작업자 명단을 확인하세요.')
    match=db.scalar(select(Match).where(Match.id==match_id).with_for_update())
    if not match or match.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    if not can_manage_editors(match,user):raise HTTPException(403,'작업자 관리 권한이 없습니다.')
    current=editor_ids(db,match_id)
    if body['version']!=editors_version(match,current):raise HTTPException(409,'작업자 명단이 변경됐습니다. 다시 불러오세요.')
    eligible={u.id for u in active_admins(db)}
    if not set(ids)<=eligible:raise HTTPException(400,'활성 관리자만 지정할 수 있습니다.')
    # Existing non-admin assignments predate this picker; changing the visible
    # admins must not silently revoke those match-scoped permissions.
    db.execute(delete(CourtsideEditor).where(CourtsideEditor.match_id==match_id,CourtsideEditor.user_id.in_(eligible)))
    db.add_all([CourtsideEditor(match_id=match_id,user_id=ident) for ident in ids]);db.commit()
    combined=sorted((set(current)-eligible)|set(ids))
    return {'saved':True,'version':editors_version(match,combined),'editorIds':sorted(ids)}
