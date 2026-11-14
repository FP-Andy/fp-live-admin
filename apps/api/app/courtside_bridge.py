"""Match-scoped FPC bridge to the existing local Courtside workbench.

Disabled unless an operator explicitly configures a shared data root and a
loopback workbench. No browser-selected host, file path, bucket or match mapping
is trusted. This does not start a worker, GPU, or FPC recording.
"""
import hashlib,json,os,re,stat
from pathlib import Path,PurePosixPath
from urllib.parse import urlsplit
from uuid import UUID
from datetime import datetime
from zoneinfo import ZoneInfo
import httpx
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.responses import JSONResponse,Response,StreamingResponse
from sqlalchemy.orm import Session
from .auth import require_session_user
from .db import get_db
from .models import Match,User

router=APIRouter()
ID=re.compile(r'^[a-z0-9-]+$');JOB=re.compile(r'^[a-f0-9]{24}$')
URL_PREFIXES=('api/','case-assets/','case-reconstruction/','case-object-frame/','case-wide-assist/','case-overlays/','case-maps/','case-report/','case-review-package/','case-review-video/','case-pose-variant/','intake-assets/','pose-assets/','wide-source/','workflow.html','pose-review.html','reconstruction.html','report-review.html','match.html')

def config():
    root=os.environ.get('COURTSIDE_DATA_ROOT');url=os.environ.get('COURTSIDE_WORKBENCH_URL')
    if not root or not url:raise HTTPException(503,'코트사이드 저장소와 작업 서버가 연결되지 않았습니다.')
    parsed=urlsplit(url)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:
        raise HTTPException(503,'코트사이드 작업 서버는 로컬 연결만 허용합니다.')
    root=Path(root).resolve()
    if not root.is_dir():raise HTTPException(503,'코트사이드 저장소를 확인하세요.')
    return root,url.rstrip('/')

def client_options(root):
    """Use an explicitly configured shared Unix socket without trusting requests."""
    value=os.environ.get('COURTSIDE_WORKBENCH_SOCKET')
    if not value:return {}
    try:
        path=(root/value).resolve()
        if not path.is_relative_to(root) or not stat.S_ISSOCK(path.stat().st_mode):raise ValueError('invalid socket')
    except (OSError,ValueError):raise HTTPException(503,'코트사이드 작업 소켓을 확인하세요.') from None
    return {'transport':httpx.AsyncHTTPTransport(uds=str(path))}

def safe_read(root,relative):
    target=(root/relative).resolve()
    if not target.is_relative_to(root):
        # Only explicitly configured work-store directories may cross the
        # shared root. Never trust a path supplied by a browser or a symlink
        # that points elsewhere on the external volume.
        parts=PurePosixPath(relative).parts
        allowed=('kbl-cases','kbl-intake','kbl-wide-preparation','kbl-pose-frames','kbl-video-jobs','kbl-fpc-relay')
        try:
            if len(parts)<3 or parts[0]!='outputs' or parts[1] not in allowed or any(p in ('.','..') for p in parts):raise ValueError()
            cfg=json.loads((root/'runtime/kbl-storage.json').read_text())
            mount=Path(cfg['mount']);backing=Path(cfg['backing']);token=cfg['token']
            if cfg['schema']!='fpc-kbl-storage/v1' or not mount.is_absolute() or not backing.is_absolute() or not isinstance(token,str) or len(token)<24:raise ValueError()
            if not os.path.ismount(mount) or not os.path.ismount(backing) or (mount/'.fpc-kbl-work-storage').read_text().strip()!=token:raise ValueError()
            work=mount/'kbl-work';base=(work/parts[1]).resolve();link=root/'outputs'/parts[1]
            if work.is_symlink() or (work/parts[1]).is_symlink() or base!=mount.resolve()/'kbl-work'/parts[1]:raise ValueError()
            if not link.is_symlink() or link.resolve()!=base or not target.is_relative_to(base):raise ValueError()
        except (OSError,ValueError,KeyError,TypeError):raise HTTPException(404,'자료를 찾을 수 없습니다.') from None
    try:return json.loads(target.read_text())
    except (OSError,ValueError):raise HTTPException(404,'자료를 찾을 수 없습니다.') from None

def authorized_match(match_id,db,user,write=False):
    m=db.get(Match,match_id)
    if not m or m.sport!='BASKETBALL':raise HTTPException(404,'농구 경기를 찾을 수 없습니다.')
    if write and (m.archived or (user.role!='SUPERADMIN' and m.operator_id and m.operator_id!=user.id)):
        raise HTTPException(403,'이 경기의 작업 권한이 없습니다.')
    return m

def library(root,match_id):
    data=safe_read(root,'outputs/kbl-library/matches.json')
    rows=data.get('matches') if isinstance(data,dict) else None
    if not isinstance(rows,list):raise HTTPException(503,'코트사이드 경기 연결 정보를 확인하세요.')
    result=[]
    for row in rows:
        if not isinstance(row,dict) or row.get('fpcMatchId')!=str(match_id) or not isinstance(row.get('id'),str) or not ID.fullmatch(row['id']):continue
        ids=row.get('caseIds',[])
        if not isinstance(ids,list) or any(not isinstance(x,str) or not ID.fullmatch(x) for x in ids):continue
        for case_id in dict.fromkeys([*ids,row.get('caseId')]):
            if isinstance(case_id,str) and ID.fullmatch(case_id):result.append({**row,'caseId':case_id})
    return result

def context(root,match_id,case_id):
    if not ID.fullmatch(case_id):raise HTTPException(404,'자료를 찾을 수 없습니다.')
    rows=[r for r in library(root,match_id) if r['caseId']==case_id]
    if len(rows)!=1:raise HTTPException(404,'경기에 연결된 판독 자료가 아닙니다.')
    case=safe_read(root,f'outputs/kbl-cases/{case_id}/case.json')
    if case.get('id')!=case_id or case.get('fpcMatchId') not in (None,str(match_id)):raise HTTPException(404,'경기 연결을 확인할 수 없습니다.')
    intake=case.get('intakeId')
    if not isinstance(intake,str) or not JOB.fullmatch(intake):raise HTTPException(404,'접수 자료 연결을 확인할 수 없습니다.')
    data=safe_read(root,f'outputs/kbl-intake/{intake}/intake.json')
    if data.get('linkedCaseId')!=case_id or data.get('libraryMatchId')!=rows[0]['id']:raise HTTPException(404,'접수 자료 연결이 일치하지 않습니다.')
    return {'case':case_id,'intake':intake,'library':rows[0]['id'],'match':str(match_id)}

def intake_context(root,match_id,intake_id):
    if not JOB.fullmatch(intake_id):raise HTTPException(404,'자료를 찾을 수 없습니다.')
    data=safe_read(root,f'outputs/kbl-intake/{intake_id}/intake.json')
    if not isinstance(data,dict) or data.get('id')!=intake_id:raise HTTPException(404,'접수 자료를 찾을 수 없습니다.')
    lib=data.get('libraryMatchId');catalogue=safe_read(root,'outputs/kbl-library/matches.json')
    rows=catalogue.get('matches',[]) if isinstance(catalogue,dict) else []
    matches=[r for r in rows if isinstance(r,dict) and r.get('id')==lib and r.get('fpcMatchId')==str(match_id)]
    if not isinstance(lib,str) or not ID.fullmatch(lib) or len(matches)!=1:raise HTTPException(404,'경기에 연결된 접수 자료가 아닙니다.')
    case=data.get('linkedCaseId')
    if case:
        if not isinstance(case,str) or not ID.fullmatch(case):raise HTTPException(404,'판독 자료 연결을 확인하세요.')
        record=safe_read(root,f'outputs/kbl-cases/{case}/case.json')
        if record.get('id')!=case or record.get('intakeId')!=intake_id or record.get('fpcMatchId')!=str(match_id):
            raise HTTPException(404,'판독 자료 연결을 확인하세요.')
    return {'case':case,'intake':intake_id,'library':lib,'match':str(match_id)}

def require_origin(request):
    try:
        origin=urlsplit(request.headers.get('origin',''))
        _=origin.port
    except ValueError:raise HTTPException(403,'요청 출처를 확인하세요.') from None
    try:
        public=os.environ.get('COURTSIDE_PUBLIC_ORIGIN')
        if public:
            expected=urlsplit(public)
            if (expected.scheme not in ('http','https') or not expected.hostname or expected.username or expected.password
                or expected.path not in ('','/') or expected.query or expected.fragment):raise ValueError('invalid public origin')
            _=expected.port  # reject malformed ports
            scheme,host=expected.scheme,expected.netloc
        else:
            scheme=request.headers.get('x-forwarded-proto',request.url.scheme).lower()
            host=request.headers.get('host')
    except ValueError:raise HTTPException(503,'코트사이드 공개 주소 설정을 확인하세요.') from None
    if (origin.scheme not in ('http','https') or origin.scheme!=scheme or origin.netloc!=host
        or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment):
        raise HTTPException(403,'요청 출처를 확인하세요.')

def match_teams(match):
    metadata=match.metadata_json if isinstance(getattr(match,'metadata_json',None),dict) else {}
    home,away=metadata.get('home_team'),metadata.get('away_team')
    if not home or not away:
        name=re.sub(r'^\[[^]]*\]\s*','',getattr(match,'name',''))
        pair=re.split(r'\s+vs\.?\s+',name,flags=re.I)
        if len(pair)!=2:raise HTTPException(409,'FPC 경기의 홈팀과 원정팀을 확인하세요.')
        home,away=pair
    if not all(isinstance(x,str) and 0<len(x.strip())<=80 for x in (home,away)):
        raise HTTPException(409,'FPC 경기의 홈팀과 원정팀을 확인하세요.')
    return home.strip(),away.strip()

def match_date(match):
    metadata=match.metadata_json if isinstance(getattr(match,'metadata_json',None),dict) else {}
    for field in ('match_date','game_date','scheduled_at','kickoff_at','date'):
        value=metadata.get(field)
        if isinstance(value,str):
            try:
                parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
                return (parsed.astimezone(ZoneInfo('Asia/Seoul')) if parsed.tzinfo else parsed).date().isoformat()
            except ValueError:continue
    return None

async def check_store(client,root,base):
    info=root.stat();expected=hashlib.sha256(f'{info.st_dev}:{info.st_ino}'.encode()).hexdigest()
    identity=await client.get(base+'/api/internal/store-identity',headers={'Host':urlsplit(base).netloc})
    value=identity.json()
    if identity.status_code!=200 or not isinstance(value,dict) or value.get('storeIdentity')!=expected:
        raise HTTPException(503,'판독 서버와 FPC의 저장소가 일치하지 않습니다.')

def in_scope(root,scope,path,method,user):
    """Default deny unknown endpoints and bind every data ID to this case."""
    if not path or '%' in path or '\\' in path or any(part in ('.','..','') for part in path.split('/')):return False
    if any(ord(ch)<32 for ch in path):return False
    parts=path.split('/');read=method in ('GET','HEAD')
    if read and (re.fullmatch(r'[a-zA-Z0-9_.-]+\.(html|mjs|css|js|svg)',path) or path=='assets/humans/mpfb-court-v1.json' or (parts[0] in ('assets','fonts','vendor') and PurePosixPath(path).suffix.lower() in ('.js','.mjs','.css','.svg','.png','.jpg','.woff','.woff2','.ttf','.otf'))):return True
    if path=='api/referees':return read
    if path=='api/gpu/status':return read and user.role=='SUPERADMIN'
    if path=='api/gpu/start':return False
    if parts[:2]==['api','cases'] and len(parts)>=3:return parts[2]==scope['case']
    if parts[:2]==['api','intake'] and len(parts)>=3:return parts[2]==scope['intake']
    if parts[:3]==['api','library','matches'] and len(parts)>=4:
        return parts[3]==scope['library'] and not (not read and 'fpc' in parts[4:])
    if parts[:2]==['api','matches'] and len(parts)>=4:return parts[2]==scope['library'] and parts[3]=='referees'
    if parts[0]=='case-report' and len(parts)==2:return read and parts[1] in (scope['case']+'.pdf',scope['case']+'.json')
    if parts[0] in ('case-assets','case-reconstruction','case-object-frame','case-wide-assist','case-overlays','case-maps','case-report','case-review-package','case-review-video','case-pose-variant') and len(parts)>=2:return read and parts[1]==scope['case']
    if parts[0]=='intake-assets' and len(parts)>=2:return read and parts[1]==scope['intake']
    if parts[0]=='wide-source' and len(parts)>=2:return read and parts[1]==scope['match']
    if parts[:2]==['api','report-jobs'] and len(parts)==3 and JOB.fullmatch(parts[2]):
        return read and safe_read(root,f'outputs/kbl-report-jobs/{parts[2]}/status.json').get('caseId')==scope['case']
    if (parts[:2]==['api','pose-jobs'] and len(parts)==3 or parts[0]=='pose-assets' and len(parts)==3) and JOB.fullmatch(parts[-1] if parts[0]=='api' else parts[1]):
        job=parts[-1] if parts[0]=='api' else parts[1]
        status=safe_read(root,f'outputs/kbl-pose-frames/{job}/status.json')
        return read and str(status.get('clipId','')).startswith(scope['case']+'-review-')
    return False

def rewrite_url(value,prefix):
    return prefix+value if isinstance(value,str) and value.startswith('/') and value[1:].startswith(URL_PREFIXES) else value
def rewrite_json(value,prefix):
    if isinstance(value,dict):
        url_keys={'url','src','href','pdf','json','media','poster','download','image','fileUrl'}
        return {k:rewrite_url(v,prefix) if isinstance(v,str) and (k in url_keys or k.endswith('Url')) else rewrite_json(v,prefix) for k,v in value.items()}
    if isinstance(value,list):return [rewrite_json(v,prefix) for v in value]
    return value
def rewrite_text(text,prefix):
    choices='|'.join(re.escape(x) for x in URL_PREFIXES)
    return re.sub(r'([\"\'`])/(?=(?:'+choices+r'))',lambda m:m.group(1)+prefix+'/',text)

@router.get('/api/courtside/matches/{match_id}/cases')
def cases(match_id:UUID,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    authorized_match(match_id,db,user);root,_=config();out=[]
    for row in library(root,match_id):
        try:context(root,match_id,row['caseId'])
        except HTTPException:continue
        out.append({'id':row['caseId'],'home':row.get('home',''),'away':row.get('away',''),'date':row.get('date','')})
    return JSONResponse({'cases':out},headers={'Cache-Control':'private, no-store'})

@router.post('/api/courtside/matches/{match_id}/intakes')
async def create_intake(match_id:UUID,request:Request,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    match=authorized_match(match_id,db,user,True);require_origin(request);root,base=config();home,away=match_teams(match)
    if request.headers.get('content-type','').split(';')[0]!='application/json':raise HTTPException(415,'JSON 요청을 확인하세요.')
    raw=bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw)>512000:raise HTTPException(413,'접수 요청이 너무 큽니다.')
    try:data=json.loads(raw)
    except (ValueError,UnicodeDecodeError):raise HTTPException(400,'접수 요청을 확인하세요.') from None
    if not isinstance(data,dict) or set(data)-{'csvText','media','candidateMode','referees','confirmUnverifiedDate'}:
        raise HTTPException(400,'접수 요청을 확인하세요.')
    date=match_date(match)
    if date is None and data.get('confirmUnverifiedDate') is not True:
        raise HTTPException(409,'FPC 경기일을 확인할 수 없습니다. CSV 경기일을 직접 확인해 주세요.')
    body={k:v for k,v in data.items() if k!='confirmUnverifiedDate'}
    body.update(fpcMatchId=str(match_id),home=home,away=away,expectedDate=date)
    async with httpx.AsyncClient(timeout=httpx.Timeout(120,connect=5),follow_redirects=False,trust_env=False,**client_options(root)) as client:
        try:
            await check_store(client,root,base)
            result=await client.post(base+'/api/internal/fpc-intakes',json=body,headers={'Host':urlsplit(base).netloc,'Origin':base})
            if result.is_redirect:raise HTTPException(502,'예상하지 못한 작업 서버 응답입니다.')
            data=result.json()
        except (httpx.HTTPError,OSError,ValueError):raise HTTPException(503,'코트사이드 작업 서버에 연결할 수 없습니다.') from None
    if result.status_code!=200:
        return JSONResponse({'detail':data.get('error','접수 자료를 확인하세요.') if isinstance(data,dict) else '접수 자료를 확인하세요.'},status_code=result.status_code)
    intake_id=data.get('id') if isinstance(data,dict) else None
    if not isinstance(intake_id,str) or not JOB.fullmatch(intake_id):raise HTTPException(502,'접수 결과를 확인할 수 없습니다.')
    intake_context(root,match_id,intake_id)
    return JSONResponse({'id':intake_id,'url':f'/api/courtside/matches/{match_id}/intakes/{intake_id}/bridge/workflow.html?intake={intake_id}'},headers={'Cache-Control':'private, no-store'})

@router.get('/api/courtside/matches/{match_id}/intakes')
def intakes(match_id:UUID,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    authorized_match(match_id,db,user);root,_=config();out=[]
    for path in (root/'outputs/kbl-intake').glob('*/intake.json'):
        intake_id=path.parent.name
        if not JOB.fullmatch(intake_id):continue
        try:
            intake_context(root,match_id,intake_id)
            data=safe_read(root,f'outputs/kbl-intake/{intake_id}/intake.json')
        except HTTPException:continue
        out.append({'id':intake_id,'status':data.get('status','unknown'),'receivedAt':data.get('receivedAt'),'caseId':data.get('linkedCaseId')})
    return JSONResponse({'intakes':out},headers={'Cache-Control':'private, no-store'})

@router.api_route('/api/courtside/matches/{match_id}/cases/{case_id}/bridge/{path:path}',methods=['GET','HEAD','POST'])
async def bridge(match_id:UUID,case_id:str,path:str,request:Request,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    write=request.method=='POST';authorized_match(match_id,db,user,write);root,base=config();scope=context(root,match_id,case_id)
    prefix=f'/api/courtside/matches/{match_id}/cases/{case_id}/bridge'
    return await proxy(request,root,base,scope,path,prefix,user)

@router.api_route('/api/courtside/matches/{match_id}/intakes/{intake_id}/bridge/{path:path}',methods=['GET','HEAD','POST'])
async def intake_bridge(match_id:UUID,intake_id:str,path:str,request:Request,db:Session=Depends(get_db),user:User=Depends(require_session_user)):
    write=request.method=='POST';authorized_match(match_id,db,user,write);root,base=config();scope=intake_context(root,match_id,intake_id)
    prefix=f'/api/courtside/matches/{match_id}/intakes/{intake_id}/bridge'
    return await proxy(request,root,base,scope,path,prefix,user)

async def proxy(request,root,base,scope,path,prefix,user):
    write=request.method=='POST'
    if write:require_origin(request)
    if not in_scope(root,scope,path,request.method,user):raise HTTPException(404,'자료를 찾을 수 없습니다.')
    # Both the intake handoff and exact pose submission can invoke the T4.
    # Manual pose review is a separate endpoint and remains available.
    gpu_job=(path==f"api/intake/{scope['intake']}/handoff" or
        bool(scope.get('case') and re.fullmatch(r'api/cases/'+re.escape(scope['case'])+r'/events/review-\d+/pose',path)))
    if write and gpu_job and os.environ.get('COURTSIDE_ALLOW_GPU_ACTIONS')!='1':
        raise HTTPException(503,'객체·관절 처리는 비용과 T4 연결 확인 후 사용할 수 있습니다.')
    query=request.url.query;url=base+'/'+path+('?' + query if query else '')
    headers={'Host':urlsplit(base).netloc}
    for key in ('range','content-type','content-length'):
        if key in request.headers:headers[key]=request.headers[key]
    if write:headers['Origin']=base
    client=httpx.AsyncClient(timeout=httpx.Timeout(120.0,connect=5.0),follow_redirects=False,trust_env=False,**client_options(root))
    try:
        await check_store(client,root,base)
        outgoing=client.build_request(request.method,url,headers=headers,content=request.stream() if write else None)
        response=await client.send(outgoing,stream=True)
    except HTTPException:
        await client.aclose();raise
    except (httpx.HTTPError,ValueError,OSError):
        await client.aclose();raise HTTPException(503,'코트사이드 작업 서버에 연결할 수 없습니다.') from None
    if response.is_redirect:
        await response.aclose();await client.aclose();raise HTTPException(502,'예상하지 못한 작업 서버 응답입니다.')
    ctype=response.headers.get('content-type','')
    copy_headers={k:v for k,v in response.headers.items() if k.lower() in ('content-range','accept-ranges','content-disposition','content-length')}
    copy_headers.update({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})
    if request.method!='HEAD' and ('json' in ctype or any(t in ctype for t in ('text/html','text/javascript','application/javascript','text/css'))):
        try:
            chunks=[];size=0
            async for chunk in response.aiter_bytes():
                size+=len(chunk)
                if size>16*1024*1024:raise ValueError('response too large')
                chunks.append(chunk)
            raw=b''.join(chunks)
            body=json.dumps(rewrite_json(json.loads(raw),prefix),ensure_ascii=False,separators=(',',':')).encode() if 'json' in ctype else rewrite_text(raw.decode('utf-8'),prefix).encode()
        except (ValueError,UnicodeDecodeError):
            await response.aclose();await client.aclose();raise HTTPException(502,'작업 서버 응답을 확인할 수 없습니다.') from None
        await response.aclose();await client.aclose();copy_headers.pop('content-length',None);copy_headers.pop('Content-Length',None)
        return Response(body,status_code=response.status_code,media_type=ctype.split(';')[0] or None,headers=copy_headers)
    async def stream():
        try:
            async for chunk in response.aiter_raw():yield chunk
        finally:await response.aclose();await client.aclose()
    return StreamingResponse(stream(),status_code=response.status_code,media_type=ctype.split(';')[0] or None,headers=copy_headers)

# Deliberately opt-in: API uses only its *existing* S3 configuration. This
# endpoint prepares one selected part but does not mark it as a synced frame.
def _recording_relay_guard(root):
    """A process-independent transfer limit inside the private shared root."""
    import fcntl
    from .courtside_recording_source import external_relay_base
    external=external_relay_base(root)
    fd=os.open(external[0] if external else root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in (() if external else ('outputs','kbl-fpc-relay')):
            try:os.mkdir(part,0o700,dir_fd=fd)
            except FileExistsError:pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        guard=os.open('.transfer.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(guard).st_mode):raise OSError('invalid lock')
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BaseException:
            os.close(guard);raise
        return guard
    finally:os.close(fd)

def _recording_s3_client():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', region_name=os.environ.get('HIGHLIGHT_S3_REGION') or None,
                        config=Config(connect_timeout=5, read_timeout=30, retries={'max_attempts': 2}))

@router.post('/api/courtside/matches/{match_id}/intakes/{intake_id}/recording-sessions/{session_id}/parts/{filename}/prepare')
async def prepare_recording_part(match_id:UUID, intake_id:str, session_id:UUID, filename:str,
                                 request:Request, db:Session=Depends(get_db), user:User=Depends(require_session_user)):
    authorized_match(match_id,db,user,True); require_origin(request)
    if os.environ.get('COURTSIDE_ALLOW_RECORDING_RELAY') != '1':
        raise HTTPException(503,'FPC 녹화 원본 연결이 아직 설정되지 않았습니다.')
    root,base=config(); intake_context(root,match_id,intake_id)
    async for chunk in request.stream():
        if chunk: raise HTTPException(400,'요청 본문을 전달할 수 없습니다.')
    async with httpx.AsyncClient(timeout=httpx.Timeout(120,connect=5),follow_redirects=False,trust_env=False,**client_options(root)) as client:
        try: await check_store(client,root,base)
        except (httpx.HTTPError,OSError,ValueError):
            raise HTTPException(503,'판독 저장소를 확인할 수 없습니다.') from None
    bucket=os.environ.get('HIGHLIGHT_S3_BUCKET')
    if not bucket: raise HTTPException(503,'FPC 녹화 저장소를 확인하세요.')
    from .courtside_recording_source import copy_part_to_shared_store,recording_key
    try: recording_key(match_id,session_id,filename)
    except ValueError as e: raise HTTPException(400,str(e)) from None
    try: guard=_recording_relay_guard(root)
    except BlockingIOError:raise HTTPException(429,'다른 광각 원본을 준비하고 있습니다. 완료 후 다시 시도하세요.') from None
    except (OSError,ValueError):raise HTTPException(503,'광각 원본 저장소를 확인하세요.') from None
    try:
        from starlette.concurrency import run_in_threadpool
        try:
            def copy_selected():
                s3=_recording_s3_client()
                def cleanup():
                    # Guard is held for both cleanup and transfer. Only old,
                    # incomplete fragments with verified original S3 objects
                    # are eligible; uncertain game metadata disables cleanup.
                    from .courtside_relay_retention import clean_stale_partials
                    try:
                        catalogue=safe_read(root,'outputs/kbl-library/matches.json')
                        rows=catalogue.get('matches') if isinstance(catalogue,dict) else None
                        result=clean_stale_partials(root,s3,bucket,str(match_id),rows)
                        if result['removed']:
                            import logging
                            logging.getLogger('uvicorn.error').info('courtside relay cleanup removed=%s bytes=%s',result['removed'],result['bytes'])
                    except (HTTPException,OSError,ValueError,TypeError):
                        pass  # Fail closed; capacity is rechecked by the caller.
                return copy_part_to_shared_store(s3,bucket,root,match_id,intake_id,session_id,filename,on_space_pressure=cleanup)
            result=await run_in_threadpool(copy_selected)
        except ValueError as e: raise HTTPException(400,str(e)) from None
        except Exception: raise HTTPException(503,'녹화 원본 연결이 중단됐습니다. 다시 시도하면 같은 원본의 저장된 부분부터 이어받습니다.') from None
    finally: os.close(guard)
    return JSONResponse({'status':'stored-unpaired','sessionId':result['sessionId'],'partName':result['partName'],
                         'bytes':result['bytes'],'sha256':result['sha256']},headers={'Cache-Control':'private, no-store'})
