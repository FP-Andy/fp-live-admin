"""One local processing worker, scoped to the fixed nine-clip manifest."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
from spatial import valid_anchors

ROOT=Path(__file__).resolve().parents[2]
RUNS=ROOT/"outputs/kbl-grayzone-analysis/v3"
POOL=ThreadPoolExecutor(max_workers=1)
LOCK=threading.Lock()
CURRENT={}

def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(".tmp");tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.replace(path)
def active_run(key):
    path=RUNS/key/"active.json"
    if not path.exists():return None
    run=json.loads(path.read_text()).get("run","")
    if not run or any(c not in "0123456789abcdefinitial-" for c in run):return None
    folder=RUNS/key/run
    if not (folder/"tracks.json").exists():return None
    return folder
def profile_for(key,anchors):
    file=RUNS/key/"setup.json"
    if file.exists():return json.loads(file.read_text())
    initial=RUNS/key/"initial/profile.json"
    if initial.exists():return json.loads(initial.read_text())
    return {"anchors":anchors,"palettes":{"home":[],"away":[]},"ballKeyframes":[],"strictRoi":True,"source":"draft"}
def validate_profile(data):
    if not isinstance(data,dict) or not valid_anchors(data.get("anchors")):raise ValueError("코트 지점 9개를 확인하세요. 경계가 교차하거나 접히면 저장할 수 없습니다.")
    palettes=data.get("palettes",{})
    if set(palettes)!={"home","away"}:raise ValueError("홈·어웨이 색상을 확인하세요.")
    for samples in palettes.values():
        if not isinstance(samples,list) or len(samples)>8:raise ValueError("팀별 색상 샘플은 최대 8개입니다.")
        for rgb in samples:
            if not isinstance(rgb,list) or len(rgb)!=3 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=255 for v in rgb):raise ValueError("잘못된 색상입니다.")
    keys=data.get("ballKeyframes",[])
    if not isinstance(keys,list) or len(keys)>300:raise ValueError("공 키프레임은 최대 300개입니다.")
    clean=[]
    for k in keys:
        if not isinstance(k,dict) or not isinstance(k.get("t"),(int,float)) or not math.isfinite(k["t"]) or not 0<=k["t"]<=30.1:raise ValueError("공 키프레임 시간을 확인하세요.")
        if k.get("missing"):clean.append({"t":k["t"],"point":None,"missing":True});continue
        point=k.get("point",[])
        if not isinstance(point,list) or len(point)!=2 or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in point) or not 0<=point[0]<=1920 or not 0<=point[1]<=1080:raise ValueError("공 위치를 영상 안에 지정하세요.")
        height=k.get("height",1.2)
        if not isinstance(height,(float,int)) or not math.isfinite(height) or not .12<=height<=8:raise ValueError("공 높이 가정을 확인하세요.")
        clean.append({"t":k["t"],"point":point,"height":height,"source":"manual"})
    unique={round(k["t"]*30):k for k in clean}
    return {"anchors":data["anchors"],"palettes":palettes,"ballKeyframes":sorted(unique.values(),key=lambda k:k["t"]),"strictRoi":True,"source":"operator"}
def status(key):
    current=CURRENT.get(key)
    if not current:return {"state":"idle","progress":0}
    progress=current["folder"]/"progress.json"
    data=json.loads(progress.read_text()) if progress.exists() else {"state":"queued","progress":0,"stage":"대기 중"}
    return {**data,"run":current["run"]}
def submit(key,data):
    profile=validate_profile(data)
    run=hashlib.sha256(("motion-v3:"+json.dumps(profile,sort_keys=True)).encode()).hexdigest()[:16]
    folder=RUNS/key/run
    with LOCK:
        old=status(key)
        if old["state"] in ("running","queued"):
            if old["run"]==run:return old
            raise RuntimeError("이 클립의 분석이 진행 중입니다. 완료 후 다시 적용하세요.")
        write(RUNS/key/"setup.json",profile);write(folder/"profile.json",profile)
        CURRENT[key]={"folder":folder,"run":run}
        if (folder/"ball.json").exists() and (folder/"progress.json").exists() and json.loads((folder/"progress.json").read_text()).get("state")=="complete":
            write(RUNS/key/"active.json",{"run":run});return status(key)
        write(folder/"progress.json",{"state":"queued","stage":"대기 중","progress":0})
        POOL.submit(execute,key,run,folder)
    return status(key)
def execute(key,run,folder):
    try:
        env=dict(os.environ,PYTHONPATH=str(ROOT/"runtime/fpa-cv/packages"))
        with (folder/"worker.log").open("w") as log:
            subprocess.run([sys.executable,str(Path(__file__).with_name("process.py")),"--clip",key,
                "--output",str(folder),"--profile",str(folder/"profile.json")],cwd=ROOT,env=env,stdout=log,stderr=log,check=True)
        write(RUNS/key/"active.json",{"run":run})
    except Exception as e:write(folder/"progress.json",{"state":"failed","stage":"처리 실패. 원본 결과는 유지됩니다.","progress":0,"error":str(e)})
