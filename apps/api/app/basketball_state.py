"""Versioned basketball state patches with stable retries and row-lock ownership.

The caller must hold SELECT ... FOR UPDATE on Match through commit.
"""
import hashlib
import json
from datetime import datetime
from uuid import UUID
from fastapi import HTTPException


def apply_patch(match, body):
    metadata=dict(match.metadata_json or {})
    previous=metadata.get('basketball_fla') or {}
    revision=int(previous.get('revision') or 0)
    try:
        request_id=str(UUID(str(body['request_id'])))
        expected=body['revision']
        if isinstance(expected,bool) or not isinstance(expected,int) or expected<0:raise ValueError()
    except (KeyError,ValueError,TypeError):
        raise HTTPException(428,'A revision and request_id are required. Reload the updated console; preserve any pending input first.')
    changes={k:v for k,v in body.items() if k in ('events','lineups','timer')}
    if not changes:raise HTTPException(400,'No basketball state fields supplied')
    for key,value in changes.items():
        valid=isinstance(value,list) if key=='events' else isinstance(value,dict) or value is None
        if not valid:raise HTTPException(400,f'Invalid {key}')
    if 'events' in changes:
        ids=[str(e.get('id') or '') for e in changes['events'] if isinstance(e,dict)]
        if len(ids)!=len(changes['events']) or '' in ids or len(set(ids))!=len(ids):raise HTTPException(400,'Events require distinct nonempty IDs')
    digest=hashlib.sha256(json.dumps({'revision':expected,**changes},sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    receipts=dict(previous.get('receipts') or {})
    if request_id in receipts:
        receipt=receipts[request_id]
        if receipt['hash']!=digest:raise HTTPException(409,'Request ID belongs to different basketball content')
        return previous,previous,{'ok':True,'idempotent':True,'revision':receipt['revision'],'current_revision':revision}
    if revision!=expected:raise HTTPException(409,{'reason':'revision_conflict','revision':revision,'message':'다른 창에서 기록을 변경했습니다. 현재 입력을 보관하고 서버 기록과 비교하세요.'})
    revision+=1
    receipts[request_id]={'hash':digest,'revision':revision}
    # Older retries still fail their revision comparison; they never reapply.
    receipts=dict(sorted(receipts.items(),key=lambda item:item[1]["revision"])[-128:])
    updated={**previous,**changes,'revision':revision,'receipts':receipts,'updated_at':datetime.utcnow().isoformat()}
    match.metadata_json={**metadata,'basketball_fla':updated}
    return previous,updated,{'ok':True,'revision':revision,'current_revision':revision,'updated_at':updated['updated_at']}
