"""Step 0 crew metadata; a catalogue is not an automatic identity assignment."""
import copy,json,threading
from job_store import atomic,digest,now
CATALOGUE=[{'number':n,'name':s} for n,s in [(2,'장문호'),(3,'조철휘'),(5,'오경석'),(7,'이지연'),(8,'박경진'),(9,'김민혁'),(10,'이승환'),(11,'김도명'),(12,'강구동'),(13,'이태희'),(14,'신동한'),(15,'이승무'),(16,'맹진호'),(22,'장재원'),(23,'김태환'),(24,'김정수'),(25,'임진수'),(26,'가민혁'),(29,'이민영'),(30,'김수연'),(35,'임현수'),(37,'한정원'),(38,'장준혁'),(45,'신형')]]
LOCK=threading.RLock()

def clean(rows):
    if not isinstance(rows,list) or len(rows)>3:raise ValueError('배정 심판은 3명까지 선택하세요.')
    out=[];known={r['number']:r['name'] for r in CATALOGUE}
    for r in rows:
        if not isinstance(r,dict) or type(r.get('number')) is not int or r['number'] not in known:raise ValueError('명단에서 심판 번호를 선택하세요.')
        if r['number'] in [x['number'] for x in out]:raise ValueError('같은 심판을 중복 선택할 수 없습니다.')
        out.append({'number':r['number'],'name':known[r['number']]})
    return out

def apply(case,root):
    path=root/'referee-roster.json'
    if path.exists():case['referees']=json.loads(path.read_text())['referees']
    case['refereesVersion']=digest(case.get('referees',[]))

def context(scope,key):
    import review_intake,match_library,case_store
    if scope=='intake':
        data=review_intake.load(key);mid=data.get('libraryMatchId');cid=data.get('linkedCaseId')
        refs=data.get('referees')
        if refs is None:refs=match_library.get(mid).get('referees',[]) if mid else []
    elif scope=='matches':
        data=match_library.get(key);mid=key;cid=data.get('caseId');refs=data.get('referees',[])
    else:raise ValueError('심판 명단의 경기 범위를 확인하세요.')
    if cid:refs=case_store.load_case(cid).get('referees',refs)
    return data,mid,cid,copy.deepcopy(refs)

def view(scope,key):
    _,_,_,refs=context(scope,key)
    return {'referees':refs,'version':digest(refs),'catalogue':CATALOGUE}

def save(scope,key,payload):
    import review_intake,match_library,case_store
    # Same lock order as intake registration; no model or report regeneration.
    with review_intake.LOCK,LOCK,match_library.LOCK:
        data,mid,cid,old=context(scope,key)
        if payload.get('version')!=digest(old):raise RuntimeError('배정 심판이 변경됐습니다. 명단을 다시 불러오세요.')
        refs=clean(payload.get('referees'))
        if scope=='intake':
            data['referees']=refs;atomic(review_intake.folder(key)/'intake.json',data)
        if mid:
            library=match_library.read()
            for row in library['matches']:
                if row['id']==mid:row['referees']=refs
            match_library.write(library)
        if cid:
            root=case_store.CASES[cid];path=root/'referee-roster.json'
            if path.exists():atomic(root/'referee-roster-history'/f'{digest(old)[:16]}.json',json.loads(path.read_text()))
            atomic(path,{'referees':refs,'updatedAt':now(),'version':digest(refs)})
        return view(scope,key)
