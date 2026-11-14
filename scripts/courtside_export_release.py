"""Export only reviewed Courtside files from an exact Git commit.

The export is independent of the mutable production checkout. Symlinks and
unexpected archive members are rejected; each extracted file is checked
against its Git blob before the new release directory becomes visible.
"""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid

PATHS=('scripts/kbl_grayzone','scripts/fpa_cv_bytetrack.py','scripts/fpa_cv_uniforms.py',
       'apps/web/public/kbl-grayzone','assets/courtside-report')

def export(repo,commit,parent):
    repo=Path(repo).resolve(strict=True);parent=Path(parent).resolve(strict=True)
    if not re.fullmatch(r'[a-f0-9]{40}',commit):raise ValueError('invalid commit')
    subprocess.run(['git','-C',str(repo),'cat-file','-e',commit+'^{commit}'],check=True,stdout=subprocess.DEVNULL)
    entries=subprocess.run(['git','-C',str(repo),'ls-tree','-rz',commit,'--',*PATHS],check=True,capture_output=True).stdout
    files={}
    for entry in filter(None,entries.split(b'\0')):
        header,path=entry.split(b'\t',1);mode,kind,oid=header.decode('ascii').split();name=path.decode('utf-8')
        if kind!='blob' or mode not in ('100644','100755') or not re.fullmatch('[a-f0-9]{40}',oid):raise ValueError('unsupported release entry')
        if name in files:raise ValueError('duplicate release entry')
        files[name]=(mode,oid)
    if not files or any(not any(n==p or n.startswith(p+'/') for n in files) for p in PATHS):raise ValueError('release source incomplete')
    stage=Path(tempfile.mkdtemp(prefix='.courtside-release-',dir=parent));process=None
    try:
        process=subprocess.Popen(['git','-C',str(repo),'archive','--format=tar',commit,'--',*PATHS],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        seen=set()
        with tarfile.open(fileobj=process.stdout,mode='r|') as archive:
            for member in archive:
                name=member.name.rstrip('/');path=PurePosixPath(name)
                if path.is_absolute() or '..' in path.parts or not name or member.issym() or member.islnk():raise ValueError('unsafe release archive')
                if member.isdir():
                    if not any(item.startswith(name+'/') for item in files):raise ValueError('unexpected release directory')
                elif not member.isfile() or name not in files or name in seen:raise ValueError('unexpected release file')
                else:seen.add(name)
                archive.extract(member,path=stage,filter='data')
        if process.wait()!=0 or seen!=set(files):raise ValueError('incomplete release archive')
        for name,(mode,oid) in files.items():
            path=stage/name
            if path.is_symlink() or not path.is_file():raise ValueError('invalid release file')
            data=path.read_bytes();digest=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
            if digest!=oid or bool(path.stat().st_mode & 0o111)!=(mode=='100755'):raise ValueError('release file verification failed')
        (stage/'.courtside-release').write_text(commit+'\n')
        final=parent/(commit+'-'+uuid.uuid4().hex[:16]);os.rename(stage,final)
        return final
    finally:
        if process and process.poll() is None:
            process.kill();process.wait()
        if process and process.stdout:process.stdout.close()
        if stage.exists():shutil.rmtree(stage)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('repo');parser.add_argument('commit');parser.add_argument('parent')
    args=parser.parse_args();print(export(args.repo,args.commit,args.parent))

if __name__=='__main__':main()
