"""Explicit operator batch: export current sources, then save via normal validation.

Runs inside app-api, with a dedicated runtime directory argument. No credentials
are emitted, no source video or track object is changed, and review versions are
checked again before storing a result. The caller must authorize the batch.
"""
import asyncio
import hashlib
import json
import sys
from pathlib import Path
sys.path.insert(0, '/app')
from starlette.requests import Request
from app.db import SessionLocal
from app.models import FpaCvResource, Match, User
from app.fpa_cv_storage import storage
from app.futsal_fla_video import FIXTURES, match_id
from app.futsal_analysis_snapshots import create_snapshot

operation, folder, *args = sys.argv[1:]
root = Path(folder); root.mkdir(parents=True, exist_ok=True)
store = storage()
if operation == 'manifest':
    rows = []
    with SessionLocal() as db:
        jobs = db.query(FpaCvResource).filter_by(kind='job').all()
        for fixture in FIXTURES:
            match = db.get(Match, match_id(fixture['key']))
            upload = (match.metadata_json or {}).get('fla_video', {}).get('upload_id') if match else None
            eligible = [j for j in jobs if upload and j.payload.get('uploadId') == upload and not j.payload.get('deletedAt') and j.payload.get('kind') != 'preparation' and j.payload.get('status') == 'completed']
            eligible.sort(key=lambda j: (j.review_version or 0, str(j.payload.get('finishedAt', ''))), reverse=True)
            job = eligible[0] if eligible else None
            rows.append({'key':fixture['key'], 'title':fixture['home']+'–'+fixture['away'], 'matchId':str(match.id) if match else None, 'jobId':job.id if job else None, 'reason':None if job else '연결 영상 또는 완료 분석 없음'})
    (root/'manifest.json').write_text(json.dumps(rows, ensure_ascii=False))
    print(json.dumps(rows, ensure_ascii=False))
elif operation == 'export':
    job_id = args[0]
    with SessionLocal() as db:
        row = db.query(FpaCvResource).filter_by(id=job_id,kind='job').one()
        if row.payload.get('status') != 'completed': raise ValueError('Not completed')
        assets = row.payload['s3Assets']
        initial = json.loads(store.client.get_object(Bucket=store.bucket,Key=assets['initial-review.json'])['Body'].read())
        track = store.client.get_object(Bucket=store.bucket,Key=assets['tracks.json'])
        metadata = {'jobId':job_id,'reviewVersion':row.review_version,'savedReview':row.review,'initial':initial,'trackETag':track['ETag']}
        with (root/(job_id+'-input.json')).open('wb') as out:
            out.write(json.dumps(metadata,ensure_ascii=False).encode()[:-1]+b',"tracks":')
            for chunk in track['Body'].iter_chunks(chunk_size=1024*1024): out.write(chunk)
            out.write(b'}')
    print(json.dumps({'jobId':job_id,'exported':True}))
elif operation == 'save':
    job_id = args[0]
    output = json.loads((root/(job_id+'-output.json')).read_text())
    if output['jobId'] != job_id: raise ValueError('Wrong analysis')
    request_id = hashlib.md5((root.name+':'+job_id).encode()).hexdigest()
    with SessionLocal() as db:
        previous = db.get(FpaCvResource,request_id)
        if previous:
            result = {'jobId':job_id,'id':previous.id,'version':previous.payload['version'],'alreadySaved':True}
            (root/(job_id+'-saved.json')).write_text(json.dumps(result))
            print(json.dumps(result));sys.exit(0)
        job = db.query(FpaCvResource).filter_by(id=job_id,kind='job').with_for_update().one()
        if job.review_version != output['reviewVersion']: raise ValueError('Review changed during computation; re-export required')
        head = store.head(job.payload['s3Assets']['tracks.json'])
        if head['ETag'] != output['trackETag']: raise ValueError('Tracks changed during computation')
        # Batch approval authorizes applying the current saved review; never
        # replace it with older applied inputs or another match's lineup.
        if job.review != output['review']:
            job.review = output['review'];job.review_version += 1;db.flush()
        body = json.dumps({'jobId':job_id,'requestId':request_id,'confirmed':True,'reviewVersion':job.review_version,'heatmap':output['heatmap']},ensure_ascii=False).encode()
        async def receive(): return {'type':'http.request','body':body,'more_body':False}
        req=Request({'type':'http','method':'POST','path':'/api/futsal/analysis-snapshots','headers':[]},receive)
        saved=asyncio.run(create_snapshot(req,db.get(User,job.owner_id),db))
        result={k:saved.get(k) for k in ('id','jobId','version','meanCoverage','meanEstimatedCoverage','resultVersion','matchId')}
        (root/(job_id+'-saved.json')).write_text(json.dumps(result))
        print(json.dumps(result))
else:
    raise ValueError('Unknown operation')
