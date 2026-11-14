"""Read-only capability checks for a private Courtside worker.

The checks report configuration and local executables only; they do not contact
S3/T4, start jobs, read game material, or claim an end-to-end test succeeded.
"""
import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def executable(value):
    path=shutil.which(value) if value else None
    return bool(path and Path(path).is_file() and os.access(path,os.X_OK))


def render_cache_ready():
    """Check private executable cache without writing or running code."""
    value=os.environ.get('KBL_RENDER_CACHE_DIR');noexec=getattr(os,'ST_NOEXEC',None)
    if not value or noexec is None:return False
    path=Path(value)
    try:
        info=path.lstat()
        return bool(path.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode & 0o077 and not os.statvfs(path).f_flag & noexec)
    except OSError:return False


def ssh_configuration(config):
    """Parse configured SSH client settings without connecting or printing secrets."""
    try:
        if not isinstance(config,dict) or config.get('autoStart') is not False:return False
        host=config['host'];ssh_config=config['sshConfig']
        if not isinstance(host,str) or not host or host.startswith('-') or not isinstance(ssh_config,str):return False
        if not Path(ssh_config).is_file() or not executable('ssh'):return False
        # ssh -G may evaluate Match exec or included configuration. Refuse
        # dynamic directives so this probe cannot execute operator commands.
        text=Path(ssh_config).read_text()
        if len(text)>65536:return False
        eic=config.get('transport')=='fixed-eic-broker'
        if eic and (host!='courtside-t4' or ssh_config!='/tmp/courtside-t4/ssh_config'):return False
        blocked={'match','include','localcommand','knownhostscommand','canonicalizehostname','pkcs11provider'}
        proxy_count=0
        for line in text.splitlines():
            key=re.split(r'[=\s]',line.strip(),maxsplit=1)[0].lower() if line.strip() and not line.lstrip().startswith('#') else ''
            if key in blocked:return False
            if key=='proxycommand':
                if not eic:return False
                from gpu_eic_bootstrap import PROXY
                if line.strip()!='ProxyCommand '+PROXY:return False
                proxy_count+=1
        if eic and proxy_count!=1:return False
        result=subprocess.run(['ssh','-F',ssh_config,'-G',host],capture_output=True,text=True,timeout=10,check=True)
        values={}
        for line in result.stdout.splitlines():
            key,_,value=line.partition(' ')
            values.setdefault(key,[]).append(value.strip())
        known=values.get('userknownhostsfile',[])
        if eic:
            from gpu_eic_bootstrap import PROXY
            if (values.get('proxycommand')!=[PROXY] or values.get('hostname')!=['127.0.0.1']
                or values.get('hostkeyalias')!=['courtside-t4'] or values.get('user')!=['ubuntu']
                or values.get('identityfile')!=['/tmp/courtside-t4/id_ed25519']
                or known!=['/run/courtside-credentials/t4-known-hosts']):return False
        return values.get('stricthostkeychecking')==['true'] and bool(values.get('identityfile')) and bool(known) and not any('/dev/null' in value for value in known)
    except (OSError,ValueError,KeyError,subprocess.SubprocessError):return False


def staging_gpu_isolation(root=ROOT):
    """Require a separate staging workspace and an explicit shared T4 lock."""
    from pathlib import PurePosixPath
    try:
        config=json.loads((Path(root)/'runtime/kbl-cv/gpu.json').read_text())
        if not isinstance(config,dict):return False
        workspace=os.environ['COURTSIDE_STAGING_GPU_WORKSPACE']
        lock=os.environ['COURTSIDE_STAGING_GPU_SHARED_LOCK']
        work=PurePosixPath(workspace);guard=PurePosixPath(lock)
        return bool(work.is_absolute() and '..' not in work.parts and re.fullmatch(r'courtside-stage-[a-f0-9]{24}',work.name)
                    and guard.is_absolute() and '..' not in guard.parts and guard.name=='worker.lock'
                    and guard.parent!=work and config.get('workspace')==workspace and config.get('workerLock')==lock)
    except (OSError,ValueError,TypeError,KeyError):return False


def checks(root=ROOT):
    root=Path(root)
    libraries={}
    for name in ('cv2','numpy','scipy','PIL','reportlab'):
        try:importlib.import_module(name);libraries[name]=True
        except (ImportError,OSError):libraries[name]=False
    gpu_path=root/'runtime/kbl-cv/gpu.json'
    try:
        gpu=json.loads(gpu_path.read_text())
        required=('host','sshConfig','image','workspace','instanceId','region')
        gpu_fields=isinstance(gpu,dict) and all(isinstance(gpu.get(k),str) and gpu[k] for k in required)
    except (OSError,ValueError,TypeError):gpu={};gpu_fields=False
    blender=os.environ.get('KBL_BLENDER') or str(root/'runtime/kbl-mpfb/Blender.app/Contents/MacOS/Blender')
    try:free=shutil.disk_usage(root).free
    except OSError:free=0
    return {
        'pythonLibraries':all(libraries.values()),
        'ffmpeg':executable(os.environ.get('KBL_FFMPEG') or 'ffmpeg'),
        'ffprobe':executable('ffprobe'),
        'depthCompiler':executable('c++'),
        'renderCache':render_cache_ready(),
        'blender':executable(blender),
        'mpfbAddon':(root/'runtime/kbl-mpfb/mpfb2-master/src/mpfb/__init__.py').is_file(),
        'gpuConfig':bool(gpu_fields and os.environ.get('KBL_GPU_DISABLED')!='1'),
        'gpuSshPolicy':bool(gpu_fields and ssh_configuration(gpu)),
        'gpuAutoStartDisabled':bool(gpu_fields and gpu.get('autoStart') is False),
        'renderEnabled':os.environ.get('KBL_VIDEO_RENDER_ENABLED','0')=='1',
        'webDelivery':os.environ.get('KBL_DELIVERY_MODE')=='web',
        'twoGiBFree':free>=2*1024**3,
    }


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--require-full',action='store_true',help='Exit nonzero unless all local configuration checks pass.')
    parser.add_argument('--require-staging-gpu',action='store_true',help='Require isolated staging and safe GPU settings before enabling staging GPU requests.')
    args=parser.parse_args()
    result=checks()
    isolation=staging_gpu_isolation()
    print(json.dumps({'schema':'courtside-worker-preflight/v1','checks':result,'stagingGpuIsolation':isolation,
                      'note':'Local checks only; S3, T4, render, and download require separate end-to-end verification.'},ensure_ascii=False))
    gpu_keys=('pythonLibraries','gpuConfig','gpuSshPolicy','gpuAutoStartDisabled','twoGiBFree')
    if args.require_full and not all(result.values()):return 1
    if args.require_staging_gpu and (not isolation or not all(result[k] for k in gpu_keys)):return 1
    return 0


if __name__=='__main__':sys.exit(main())
