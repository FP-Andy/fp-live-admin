"""Immutable PDF revisions, separate from the mutable working case."""
from pathlib import Path
import hashlib,json,shutil
import case_store
import storage_policy
from job_store import atomic,lease,now

ROOT=Path(__file__).resolve().parents[2]/'output/pdf'

def folder(key):
    if key not in case_store.CASES:raise ValueError('등록된 경기를 확인하세요.')
    return ROOT/'versions'/key

def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def index(key):
    path=folder(key)/'index.json'
    return json.loads(path.read_text()) if path.exists() else {'versions':[],'publishedVersion':None}

def legacy(key):
    pdf=ROOT/f'kbl-{key}-tracking-review.pdf'
    if not pdf.is_file():return None
    meta=json.loads(pdf.with_suffix('.json').read_text())
    actual=sha(pdf)
    if actual!=meta['pdfSha256']:raise RuntimeError('저장된 PDF가 변경됐습니다.')
    return {'id':actual[:24],'sha256':actual,'createdAt':meta.get('generatedAt'),'pageCount':meta['pageCount'],
        'kind':'preserved-existing','inputSignature':meta.get('reportInputSignature'),'file':pdf,'metadata':meta}

def store(key,pdf,metadata,kind='generated'):
    with lease(folder(key)/'index.lock') as acquired:
        if not acquired:raise RuntimeError('다른 PDF 개정을 저장 중입니다. 다시 시도하세요.')
        data=index(key);actual=sha(pdf);version=actual[:24];target=folder(key)/(version+'.pdf')
        if metadata.get('pdfSha256')!=actual:raise RuntimeError('PDF와 개정 메타데이터가 다릅니다.')
        if not target.exists():
            if storage_policy.free_bytes(ROOT)<pdf.stat().st_size+2*1024**3:raise RuntimeError('리포트를 저장할 여유 공간이 부족합니다.')
            temp=target.with_suffix('.copying');shutil.copyfile(pdf,temp);temp.replace(target)
            atomic(target.with_suffix('.json'),metadata)
        if not any(v['id']==version for v in data['versions']):
            data['versions'].append({'id':version,'sha256':actual,'createdAt':metadata.get('generatedAt') or now(),
                'pageCount':metadata['pageCount'],'kind':kind,'inputSignature':metadata.get('reportInputSignature')})
        data['latestVersion']=version;atomic(folder(key)/'index.json',data)
    return {'reportId':version,'pdf':f'/case-report/{key}/{version}.pdf','json':f'/case-report/{key}/{version}.json',
        'pageCount':metadata['pageCount'],'status':metadata['status'],'seconds':metadata.get('reportGenerationSeconds')}

def preserve_existing(key):
    old=legacy(key)
    if old and not any(v['id']==old['id'] for v in index(key)['versions']):store(key,old['file'],old['metadata'],'preserved-existing')

def listing(key):
    data=index(key);rows=list(data['versions']);old=legacy(key)
    if old and not any(r['id']==old['id'] for r in rows):rows.insert(0,{k:old[k] for k in ('id','sha256','createdAt','pageCount','kind','inputSignature')})
    return {'caseId':key,'versions':[{**r,'pdf':f'/case-report/{key}/{r["id"]}.pdf',
        'published':r['id']==data.get('publishedVersion')} for r in reversed(rows)],
        'publishedVersion':data.get('publishedVersion'),'publishedAt':data.get('publishedAt'),'firstPublishedAt':data.get('firstPublishedAt')}

def file(key,version,extension='pdf'):
    if extension not in ('pdf','json'):raise ValueError('PDF 개정 형식을 확인하세요.')
    row=next((r for r in index(key)['versions'] if r['id']==version),None)
    if row:
        pdf=folder(key)/(version+'.pdf')
        if sha(pdf)!=row['sha256']:raise RuntimeError('보관된 PDF가 변경됐습니다.')
        return pdf.with_suffix('.'+extension)
    old=legacy(key)
    if old and old['id']==version:return old['file'].with_suffix('.'+extension)
    raise ValueError('보관된 PDF 개정을 찾을 수 없습니다.')

def latest_file(key,extension='pdf'):
    data=index(key)
    if data.get('latestVersion'):return file(key,data['latestVersion'],extension)
    old=legacy(key)
    if old:return old['file'].with_suffix('.'+extension)
    raise ValueError('저장된 PDF가 없습니다.')

def publish(key,version):
    preserve_existing(key);file(key,version)
    with lease(folder(key)/'index.lock') as acquired:
        if not acquired:raise RuntimeError('납품본을 저장 중입니다. 다시 시도하세요.')
        data=index(key)
        if data.get('publishedVersion')!=version:
            data.update(publishedVersion=version,publishedAt=now())
            data.setdefault('firstPublishedAt',data['publishedAt'])
            data.setdefault('publicationHistory',[]).append({'version':version,'publishedAt':data['publishedAt']})
            atomic(folder(key)/'index.json',data)
    return listing(key)
