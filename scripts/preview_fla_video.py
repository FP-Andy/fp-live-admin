"""Loopback-only FLA preview. Real new endpoints + SQLite, no production writes.

Usage: python scripts/preview_fla_video.py --video /absolute/original.mp4
Creates local copies of the 39 fixtures. Storage stays under runtime/fla-video.
"""
import argparse
import ast
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'runtime/fla-video'
RUNTIME.mkdir(parents=True,exist_ok=True)
os.environ['DATABASE_URL']='sqlite:///'+str(RUNTIME/'preview.db')
os.environ['FPA_CV_ALLOWED_ORIGINS']='http://127.0.0.1:4340,http://localhost:4340'
sys.path.insert(0,str(ROOT/'apps/api'))
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
@compiles(JSONB,'sqlite')
def jsonb_sqlite(_type,compiler,**kw):return 'JSON'

from fastapi import FastAPI,HTTPException,Request
from fastapi.responses import RedirectResponse,StreamingResponse
from app.db import Base,engine,SessionLocal
from app.models import User,Match,Event,State,PossessionSegment,DominanceBin,FpaCvResource,MatchMarker
from app.auth import require_session_user
from app.futsal_fla_video import create_router,FIXTURES,match_id


def build_preview(video_path):
    # Run exactly the canonical production aggregate without unrelated workers.
    source=ast.parse((ROOT/'apps/api/app/main.py').read_text())
    functions=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in {'_build_split_halves_dominance','_compute_dominance_value'}]
    context={name:globals()[name] for name in ('Match','Event','State','PossessionSegment','MatchMarker','HTTPException')}
    from sqlalchemy.orm import Session
    from uuid import UUID
    from app.services import DOM_POSSESSION_WEIGHT,DOM_XG_WEIGHT,DOM_ATTACK_WEIGHT,DOM_XG_SCALE
    context.update(Session=Session,UUID=UUID,_clamp=lambda v,lo,hi:max(lo,min(hi,v)),DOM_POSSESSION_WEIGHT=DOM_POSSESSION_WEIGHT,
                   DOM_XG_WEIGHT=DOM_XG_WEIGHT,DOM_ATTACK_WEIGHT=DOM_ATTACK_WEIGHT,DOM_XG_SCALE=DOM_XG_SCALE,DOM_GOAL_XG_MULTIPLIER=2.5,
                   _latest_state=lambda id,db:db.query(State).filter_by(match_id=id).order_by(State.created_at.desc()).first())
    exec(compile(ast.Module(body=functions,type_ignores=[]),'<FLA production aggregate>','exec'),context)
    tables=[m.__table__ for m in (User,Match,Event,State,PossessionSegment,DominanceBin,FpaCvResource,MatchMarker)]
    Base.metadata.create_all(engine,tables=tables)
    user=User(id='fla-local-review',name='로컬 검토',role='SUPERADMIN')
    upload_id='0'*31+'1'
    with SessionLocal() as db:
        db.merge(user)
        db.merge(FpaCvResource(id=upload_id,kind='upload',owner_id=user.id,payload={'id':upload_id,'name':'[로컬 원본] '+video_path.name,'status':'uploaded','size':video_path.stat().st_size,'storage':'local-preview'}))
        for f in FIXTURES:
            if not db.get(Match,match_id(f['key'])):
                db.add(Match(id=match_id(f['key']),name=f"[{f['stage']} {f['round']}경기] {f['home']} vs {f['away']}",sport='FUTSAL',competition_class='FUTSAL-QUEENCUP',round_number=f['round'],
                             first_half_minutes=15,second_half_minutes=0,metadata_json={'period_mode':'SINGLE','stream_mode':'MANUAL','design_preview':True,'home_team':f['home'],'away_team':f['away'],'fla_fixture':f}))
        db.commit()
    app=FastAPI()
    app.dependency_overrides[require_session_user]=lambda:user

    @app.get('/api/local-preview')
    def entry():
        response=RedirectResponse('/admin/futsal/fla/video')
        response.set_cookie('live_admin_session','fla-local-preview',httponly=True,samesite='lax')
        return response

    @app.get('/api/session/me')
    def me():return {'id':user.id,'name':user.name,'role':user.role}

    @app.get('/api/futsal/fla-video/uploads/{uid}/source')
    def source(uid:str,request:Request):
        if uid!=upload_id:raise HTTPException(404)
        size=video_path.stat().st_size;start=0;end=size-1;status=200
        value=request.headers.get('range','')
        if value.startswith('bytes='):
            try:
                left,right=value[6:].split('-',1)
                if not left:start=max(0,size-int(right))
                else:start=int(left);end=min(size-1,int(right)) if right else size-1
                if not 0<=start<=end<size:raise ValueError()
                status=206
            except ValueError:raise HTTPException(416,headers={'Content-Range':f'bytes */{size}'})
        def stream():
            with video_path.open('rb') as f:
                f.seek(start);remaining=end-start+1
                while remaining:
                    chunk=f.read(min(1024*1024,remaining))
                    if not chunk:break
                    yield chunk;remaining-=len(chunk)
        headers={'Accept-Ranges':'bytes','Content-Length':str(end-start+1),'Cache-Control':'private, no-store'}
        if status==206:headers['Content-Range']=f'bytes {start}-{end}/{size}'
        return StreamingResponse(stream(),media_type='video/mp4',status_code=status,headers=headers)

    app.include_router(create_router(context['_build_split_halves_dominance']))
    return app


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--video',type=Path,required=True);parser.add_argument('--port',type=int,default=4341);args=parser.parse_args()
    if not args.video.is_file():parser.error('원본 영상 파일을 확인하세요.')
    import uvicorn
    uvicorn.run(build_preview(args.video.resolve()),host='127.0.0.1',port=args.port)
