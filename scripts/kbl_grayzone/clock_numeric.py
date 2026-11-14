"""Numeric scoreboard evidence. No pixel-similarity score can establish time.

Small lossless crops only; one native OCR process at a time. OCR disagreement
is retained rather than resolving it towards the requested clock value.
"""
import hashlib,json,os,re,shutil,subprocess,time
from contextlib import contextmanager
from pathlib import Path
import cv2,numpy as np
from job_store import atomic,lease

VERSION='numeric-clock-v6'
OCR=Path(__file__).resolve().parents[2]/'runtime/kbl-clock-ocr'

@contextmanager
def ocr_slot():
    deadline=time.monotonic()+60
    while True:
        with lease(OCR.parent/'kbl-clock-ocr.lock') as acquired:
            if acquired:
                yield
                return
        if time.monotonic()>deadline:raise RuntimeError('다른 시계 OCR 작업이 실행 중입니다. 저장된 결과부터 다시 이어갈 수 있습니다.')
        time.sleep(.1)

def tesseract_path():
    return shutil.which('tesseract') or next((p for p in ('/opt/homebrew/bin/tesseract','/usr/local/bin/tesseract') if Path(p).is_file()),None)

def parse_game(text):
    text=text.strip().replace('O','0').replace('o','0').replace(';',':').replace('：',':').replace(',','.')
    m=re.fullmatch(r'(\d{1,2})\s*:\s*([0-5]\d)(?:\.(\d))?',text)
    if m:
        value=int(m[1])*60+int(m[2])+int(m[3] or 0)/10
        return value if value<=600 else None
    # Below a minute a physical clock can display 28.3 without a leading 0:.
    if re.fullmatch(r'\d{1,2}\.\d',text) and float(text)<60:return float(text)
    return None

def parse_shot(text):
    text=text.strip().replace('O','0').replace(',','.')
    if not re.fullmatch(r'\d{1,2}(?:\.\d)?',text):return None
    value=float(text)
    return value if value<=24 else None

def regions(image):
    """Propose LED panels in both camera sides, including white game digits."""
    h,w=image.shape[:2];hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    masks=[cv2.inRange(hsv,np.array([38,55,35]),np.array([95,255,255])),
           cv2.inRange(hsv,np.array([0,0,165]),np.array([180,110,255]))]
    allowed=np.zeros((h,w),np.uint8);allowed[int(h*.18):int(h*.68),:int(w*.35)]=255;allowed[int(h*.18):int(h*.68),int(w*.65):]=255
    candidates=[]
    for mode,mask in enumerate(masks):
        # Join adjacent digits but keep the game and shot rows separate.
        grouped=cv2.dilate(mask&allowed,np.ones((1,max(2,round(w/320))),np.uint8))
        _,_,stats,_=cv2.connectedComponentsWithStats(grouped)
        for x,y,bw,bh,area in stats[1:]:
            if not(w*.009<=bw<=w*.065 and 3<=bh<=h*.025 and 1.5<=bw/bh<=7):continue
            pad=max(1,round(bh*.2));g=[max(0,int(x-pad)),max(0,int(y-pad)),min(w,int(x+bw+pad)),int(y+bh+pad)]
            s=[g[0],int(y+bh),g[2],min(h,int(y+bh*3.5))]
            below=hsv[s[1]:s[3],s[0]:s[2],2];panel=hsv[g[1]:s[3],g[0]:g[2],2]
            if not below.size or np.count_nonzero(below>165)<4:continue
            dark=float(np.mean(panel<100))
            if dark<.30:continue
            score=dark+(.2 if mode==0 else 0)-abs(y/h-.52)*.2
            candidates.append((score,g,s))
    chosen=[]
    for _,g,s in sorted(candidates,reverse=True):
        if any(abs(g[0]-a[0])<max(5,(g[2]-g[0])*.5) and abs(g[1]-a[1])<max(3,(g[3]-g[1])*.5) for a,_ in chosen):continue
        chosen.append((g,s))
        if len(chosen)==8:break
    return chosen

def crops(image,box):
    h,w=image.shape[:2];x,y,X,Y=map(round,box);crop=image[max(0,y):min(h,Y),max(0,x):min(w,X)]
    if not crop.size:return []
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY);gray=cv2.normalize(gray,None,0,255,cv2.NORM_MINMAX)
    scale=min(16,320/max(1,gray.shape[1]));a=cv2.resize(gray,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
    # Four independent renderings; do not treat upscaling as extra source detail.
    variants=[a,255-a,(a>175).astype(np.uint8)*255,255-(a>125).astype(np.uint8)*255]
    return [cv2.copyMakeBorder(v,32,32,32,32,cv2.BORDER_CONSTANT,value=0 if i in (0,2) else 255) for i,v in enumerate(variants)]

def consensus(rows,parser):
    votes={};raw=[]
    for variant,row in enumerate(rows):
        texts=[(row.get('text',''),1.)]
        # A second OCR engine is independent evidence, not an OCR alternative
        # selected because it agrees with the other camera's requested time.
        texts += [(row['numericText'],1.)] if row.get('numericText') else []
        for obs in row.get('observations',[]):
            texts += [(c['text'],.4/(rank+1)) for rank,c in enumerate(obs.get('candidates',[])) if c.get('confidence',0)>=.25]
        per_variant={}
        for text,weight in texts:
            value=parser(text)
            if value is None:continue
            per_variant[value]=max(weight,per_variant.get(value,0))
            raw.append({'text':text,'value':value,'variant':variant})
        for value,weight in per_variant.items():votes[value]=votes.get(value,0)+weight
    ranked=sorted(votes.items(),key=lambda p:(-p[1],p[0]))
    value=None
    if ranked and ranked[0][1]>=1.8 and (len(ranked)==1 or ranked[0][1]-ranked[1][1]>=1.0):value=ranked[0][0]
    return {'value':value,'votes':[{'value':v,'score':round(s,3)} for v,s in ranked],'raw':raw}

def read_images(images,folder,regions_by_image=None):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    tess=tesseract_path()
    if not OCR.is_file():raise RuntimeError('시계 OCR 실행 파일이 준비되지 않았습니다.')
    groups=[];pending={}
    for i,im in enumerate(images):
        pairs=regions_by_image[i] if regions_by_image is not None else regions(im)
        for g,s in pairs:
            fields=[]
            for box in (g,s):
                paths=[]
                for crop in crops(im,box):
                    key=hashlib.sha256(VERSION.encode()+crop.tobytes()).hexdigest();path=folder/(key+'.png');paths.append(path)
                    if not path.with_suffix('.json').is_file():
                        if not path.is_file():cv2.imwrite(str(path),crop)
                        pending[str(path)]=path
                fields.append(paths)
            groups.append((i,g,s,fields))
    if pending:
        # Unique files permit concurrent callers without overwriting input lists.
        token=hashlib.sha256('\n'.join(pending).encode()).hexdigest()[:16]
        inp=folder/(token+'-inputs.json');out=folder/(token+'-text.json');atomic(inp,list(pending))
        with ocr_slot():
            subprocess.run([str(OCR),str(inp),str(out)],check=True,timeout=90,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            rows=json.loads(out.read_text())
            if any(r.get('error') for r in rows):raise RuntimeError('시계 OCR 실행에 실패했습니다. macOS 영상 인식 권한을 확인하세요.')
            if tess:
                listing=folder/(token+'-images.txt');listing.write_text('\n'.join(pending)+'\n')
                proc=subprocess.run([tess,str(listing),'stdout','--psm','7','-c','tessedit_char_whitelist=0123456789:.'],
                    env={**os.environ,'OMP_THREAD_LIMIT':'1','OMP_NUM_THREADS':'1'},capture_output=True,text=True,check=True,timeout=90)
                pages=proc.stdout.split('\f')
                if len(pages) not in (len(rows),len(rows)+1):raise RuntimeError('숫자 OCR 결과와 입력 이미지 수가 다릅니다.')
                for row,text in zip(rows,pages):row['numericText']=text.strip()
            for row in rows:atomic(Path(row['file']).with_suffix('.json'),{k:v for k,v in row.items() if k!='file'})
    result=[[] for _ in images]
    for i,g,s,fields in groups:
        reads=[consensus([json.loads(p.with_suffix('.json').read_text()) for p in paths],parser) for paths,parser in zip(fields,(parse_game,parse_shot))]
        result[i].append({'game':reads[0]['value'],'shot':reads[1]['value'],'regions':[g,s],'evidence':reads})
    output=[]
    for options in result:
        valid=[o for o in options if o['game'] is not None and o['shot'] is not None]
        states={(o['game'],o['shot']) for o in valid}
        if len(states)>1:row={'status':'conflicting-clocks'}
        elif len(states)==1:
            best=valid[0];row={'status':'read',**best,'agreement':len(valid)}
        else:row={'status':'unreadable'}
        output.append({**row,'readings':options,'method':VERSION})
    return output

def broadcast_regions(image):
    # Enlarged physical-clock insets vary between broadcasters. Each complete
    # crop is read independently; disagreements are retained, never forced to
    # the CSV time. Geometry/text auto boxes can truncate a 1 or decimal digit.
    h,w=image.shape[:2]
    return [[(w*.912,h*.031,w*.978,h*.075),(w*.903,h*.077,w*.978,h*.153)],
            [(w*.902,h*.047,w*.965,h*.090),(w*.893,h*.091,w*.965,h*.166)],
            [(w*.886,h*.047,w*.946,h*.090),(w*.880,h*.091,w*.948,h*.166)]]

def transitions(samples,field,max_gap=.4):
    """Clock edges are time intervals, not exact timestamps. Resets are excluded."""
    good=sorted((s for s in samples if s.get('status')=='read' and s.get(field) is not None),key=lambda s:s['time'])
    out=[]
    for a,b in zip(good,good[1:]):
        dt=b['time']-a['time'];delta=a[field]-b[field]
        if not 0<dt<=max_gap or not .05<=delta<=1.1:continue
        # Missing OCR samples must not turn a multi-second skip into an edge.
        other='shot' if field=='game' else 'game'
        if abs(a[other]-b[other])>1.1:continue
        out.append({'key':(field,a[field],b[field]),'lo':a['time'],'hi':b['time']})
    return out

def align_sequences(primary,secondary,selected_time,max_uncertainty=.2):
    """Match clock transitions, permitting constant-speed replay. Reject plateaus.

Returns a bounded time estimate only if BOTH clocks have matching transitions,
three or more independent edges span >=1s, and alternative timelines do not fit.
Single-second digit agreement alone is never allowed to fuse people or poses.
"""
    p=transitions(primary,'game')+transitions(primary,'shot');s=transitions(secondary,'game')+transitions(secondary,'shot')
    pairs=[(a,b) for a in p for b in s if a['key']==b['key']]
    if len(pairs)<3:return {'state':'needs-review','reason':'insufficient-clock-transitions','frameAccurateSyncVerified':False}
    hypotheses=[]
    for i,(a,b) in enumerate(pairs):
        for c,d in pairs[i+1:]:
            x=(a['lo']+a['hi'])/2;xx=(c['lo']+c['hi'])/2;y=(b['lo']+b['hi'])/2;yy=(d['lo']+d['hi'])/2
            if abs(xx-x)<1:continue
            rate=(yy-y)/(xx-x)
            if not .15<=rate<=4:continue
            offset=y-rate*x;matched=[]
            for pa,sa in pairs:
                residual=abs((sa['lo']+sa['hi'])/2-(rate*(pa['lo']+pa['hi'])/2+offset))
                bound=(sa['hi']-sa['lo']+rate*(pa['hi']-pa['lo']))/2
                if residual<=bound+.025:matched.append((pa,sa,residual,bound))
            keys={tuple(a['key']) for a,_,_,_ in matched}
            if len(keys)<3 or {a['key'][0] for a,_,_,_ in matched}!={'game','shot'}:continue
            # A repeated clock state in another quarter cannot double the support.
            if len(keys)!=len(matched):continue
            xs=[(a['lo']+a['hi'])/2 for a,_,_,_ in matched]
            if max(xs)-min(xs)<1 or not min(xs)-.3<=selected_time<=max(xs)+.3:continue
            lo=max(sa['lo']-rate*pa['hi'] for pa,sa,_,_ in matched)
            hi=min(sa['hi']-rate*pa['lo'] for pa,sa,_,_ in matched)
            if lo>hi:continue
            center=rate*selected_time+(lo+hi)/2
            # Check all readable paired states too, including stops/reset cuts.
            agree=0;tested=0
            for pr in primary:
                if pr.get('status')!='read':continue
                t=rate*pr['time']+(lo+hi)/2
                nearby=[r for r in secondary if r.get('status')=='read' and abs(r['time']-t)<=.25]
                if not nearby:continue
                tested+=1
                if any(abs(r['game']-pr['game'])<=.15 and abs(r['shot']-pr['shot'])<=.15 for r in nearby):agree+=1
            if tested<5 or agree/tested<.8:continue
            uncertainty=max((hi-lo)/2,max(v[3] for v in matched))
            hypotheses.append({'time':center,'uncertaintySeconds':uncertainty,'rate':rate,'offset':(lo+hi)/2,'edges':len(keys),'agreement':agree/tested})
    if not hypotheses:return {'state':'needs-review','reason':'clock-sequences-disagree','frameAccurateSyncVerified':False}
    best=max(hypotheses,key=lambda h:(h['edges'],h['agreement'],-h['uncertaintySeconds']))
    if any(abs(h['time']-best['time'])>.5 and h['edges']>=best['edges']-1 for h in hypotheses):return {'state':'needs-review','reason':'multiple-clock-sequences','frameAccurateSyncVerified':False}
    if best['uncertaintySeconds']>max_uncertainty:return {'state':'needs-review','reason':'clock-time-too-broad',**best,'frameAccurateSyncVerified':False}
    return {'state':'matched','method':'numeric-game-and-shot-clock-transitions',**best,'frameAccurateSyncVerified':False}
