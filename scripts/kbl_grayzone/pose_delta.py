"""Source-bound pose/mesh reuse. Metadata changes do not trigger model inference."""
import copy,hashlib,json,re,shutil
from pathlib import Path
from job_store import digest

def fit_key(frame):
    people=[]
    for p in frame['people']:
        raw=(frame.get('reusedPredictions') or {}).get(p['id']) or p.get('rawPrediction')
        if raw is None:return None
        people.append({**{k:p.get(k) for k in ('id','role','x','y','pixelBox','manualJoints','manualArms3D','manualBodyHeading','imageSource','sourceSha256','widePose','cameraOverride')},
                       'spatialEligible':p.get('spatialEligible',True),'raw':raw,
                       'manual':frame.get('preservedManual',{}).get(p['id'],{})})
        # Same manual edits may arrive on the person or in the initial-request envelope.
        manual=people[-1].pop('manual')
        for k in ('manualJoints','manualArms3D','manualBodyHeading'):
            people[-1][k]=manual.get(k,people[-1][k])
            if k!='manualBodyHeading' and not people[-1][k]:people[-1][k]={}
    return digest({'anchors':frame.get('anchors'),'camera':frame.get('cameraOverride'),
                   'people':sorted(people,key=lambda p:p['id'])})

def mesh_key(person):
    # Reprojection may differ at machine epsilon after JSON round trips. These
    # values are metres/radians/unit vectors; 1e-7 is below mesh export precision.
    def stable(value):
        if isinstance(value,float):return round(value,7) or 0.
        if isinstance(value,list):return [stable(v) for v in value]
        if isinstance(value,dict):return {k:stable(v) for k,v in value.items()}
        return value
    return digest(stable({k:person.get(k) for k in ('role','bodyHeading','autoAccepted','accepted',
        'directions','spineDirection','armQuality','manualArms3D','fallbackBones')}))

def prior_artifacts(frame,store,model_sha,pipeline_version):
    ref=frame.get('meshReuseSource') or {}
    if not re.fullmatch('[a-f0-9]{24}',ref.get('jobId','')):return None
    if ref.get('inputSha256')!=frame.get('inputSha256') or not frame.get('inputSha256'):return None
    path=Path(store)/ref['jobId']
    if not (path/'result.json').exists():path=Path(store).parent/'kbl-pose-cache'/ref['jobId']
    try:
        old=json.loads((path/'result.json').read_text());meshes=json.loads((path/'meshes.json').read_text())
        if old['frameIndex']!=frame['frameIndex'] or old['clipId']!=frame['clipId']:return None
        if old.get('modelSha256')!=model_sha or old.get('pipelineVersion')!=pipeline_version:return None
        if old.get('inputSha256',ref['inputSha256'])!=ref['inputSha256']:return None
        actual=hashlib.sha256(json.dumps(meshes['assets'],separators=(',',':')).encode()).hexdigest()
        if actual!=old['meshSha256'] or actual!=meshes['geometrySha256']:return None
        return path,old,meshes
    except (OSError,KeyError,ValueError):return None

def reuse_complete(frame,dest,store,model_sha,pipeline_version):
    previous=prior_artifacts(frame,store,model_sha,pipeline_version)
    if not previous:return None
    path,old,meshes=previous
    if not (path/'frame.jpg').exists():return None
    if fit_key(frame) is None or fit_key(frame)!=fit_key(old):return None
    by_id={p['id']:p for p in frame['people']};row=copy.deepcopy(old)
    row.update({k:copy.deepcopy(frame[k]) for k in ('jobId','parentId','revision','datasetId','inputSha256','meshReuseSource') if k in frame})
    for p in row['people']:p['team']=by_id[p['id']].get('team','unknown')
    for name in ('meshes.json','frame.jpg','fitted.json'):
        if (path/name).exists():shutil.copyfile(path/name,Path(dest)/name)
    row.update(executionMode='artifact-reuse',reusedPoseJobId=old['jobId'],reusedPredictionCount=len(row['people']),
               inferredPredictionCount=0,poseSeconds=[],loadSeconds=0,meshBuildSeconds=0,
               rebuiltMeshCount=0,reusedMeshCount=len(meshes['assets']))
    return row

def mesh_cache(frame,store,model_sha,pipeline_version):
    previous=prior_artifacts(frame,store,model_sha,pipeline_version)
    if not previous:return {}
    path,old,meshes=previous
    try:before=json.loads((path/'fitted.json').read_text())['frames'][0]
    except (OSError,KeyError,ValueError):return {}
    fitted={p['id']:p for p in before['people']};final={p['id']:p for p in old['people']};out={}
    for p in frame['people']:
        prior=final.get(p['id']);initial=fitted.get(p['id'])
        if not prior or not initial or not p.get('spatialEligible',True):continue
        if mesh_key(initial)!=mesh_key(p) or prior.get('meshKey') not in meshes['assets']:continue
        out[p['id']]={'person':prior,'mesh':meshes['assets'][prior['meshKey']]}
    return copy.deepcopy(out)
