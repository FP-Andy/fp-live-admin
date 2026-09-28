"""Repair initial server artifacts only; never touches saved operator reviews."""
import argparse,json,pathlib
from fpa_cv_initial import initial_review
from fpa_cv_storage import storage
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jobs-dir',type=pathlib.Path,default=pathlib.Path('/workspace/runtime/fpa-cv/workbench/jobs'))
parser.add_argument('--apply',action='store_true',help='Write backed-up initial artifacts; default only reports changes')
args=parser.parse_args();root=args.jobs_dir;st=storage();apply=args.apply
active=[p for p in root.glob('*/job.json') if json.loads(p.read_text())['status'] in {'queued','starting','running','cancelling'}]
if active:raise RuntimeError('Analysis jobs are active; wait before repair/restart')
for path in root.glob('*/job.json'):
 job=json.loads(path.read_text())
 if job['status']!='completed' or job.get('kind')=='preparation' or job.get('initialMatched',13)>=13:continue
 out=path.parent/'output';oldpath=out/'initial-review.json';old=json.loads(oldpath.read_text())
 asset=job.get('s3Assets',{}).get('tracks.json')
 if (out/'tracks.json').exists():data=json.loads((out/'tracks.json').read_text())
 elif asset:
  response=st.client.get_object(Bucket=st.bucket,Key=asset)
  try:data=json.load(response['Body'])
  finally:response['Body'].close()
 else:raise RuntimeError('Tracks are unavailable')
 if data['datasetId']!=job['datasetId'] or old['datasetId']!=job['datasetId']:raise RuntimeError('Dataset mismatch')
 new=initial_review(data,job['options']['setup'])
 oldmap={s['personId']:s['trackId'] for s in old['segments']};newmap={s['personId']:s['trackId'] for s in new['segments']}
 if any(newmap.get(p)!=tid for p,tid in oldmap.items()):raise RuntimeError('An existing initial anchor would change')
 recovered=[p for p in old['initialization']['unmatched'] if p in newmap]
 if not recovered:continue
 new['initialization']['repairedPersonIds']=recovered
 new['initialization']['repairVersion']='initial-provenance-v1'
 print(json.dumps({'id':job['id'],'name':job['name'],'before':len(oldmap),'after':len(newmap),'repaired':recovered,'apply':apply},ensure_ascii=False),flush=True)
 if not apply:continue
 backup=out/'initial-review.before-provenance-v1.json'
 if not backup.exists():backup.write_bytes(oldpath.read_bytes())
 jobbackup=path.with_name('job.before-provenance-v1.json')
 if not jobbackup.exists():jobbackup.write_bytes(path.read_bytes())
 pending=out/'initial-review.repaired.json';pending.write_text(json.dumps(new,ensure_ascii=False))
 reviewkey=job.get('s3Assets',{}).get('initial-review.json')
 if reviewkey:
  st.upload(backup,reviewkey.replace('initial-review.json',backup.name),'application/json')
  st.upload(pending,reviewkey,'application/json')
 pending.replace(oldpath)
 job.update(initialMatched=len(newmap),initialUnmatched=new['initialization']['failures'],initialRepairVersion='initial-provenance-v1')
 pending=path.with_name('job.repaired.json');pending.write_text(json.dumps(job,ensure_ascii=False));pending.replace(path)
