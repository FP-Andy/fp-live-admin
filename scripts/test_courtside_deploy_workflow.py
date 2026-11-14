"""Exercise both deployment branches in an isolated synthetic repository."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[1]

class DeploymentWorkflowTests(unittest.TestCase):
 def test_fpc_only_and_enabled_worker_preflight(self):
  for enabled,fail_t4,fail_s3 in ((False,False,False),(True,False,False),(True,True,False),(True,False,True)):
   with self.subTest(enabled=enabled,fail_t4=fail_t4,fail_s3=fail_s3),tempfile.TemporaryDirectory() as temp:
    root=Path(temp);repo=root/'app';repo.mkdir();private=root/'private';private.mkdir();backup=root/'backup';bin_dir=root/'bin';bin_dir.mkdir()
    subprocess.run(['git','init','-q','-b','main',str(repo)],check=True)
    files={
     '.gitignore':'runtime/\ninfra/app/.env\n',
     'infra/app/docker-compose.yml':'services: {}\n',
     'infra/app/nginx/templates/default.conf.template':'synthetic nginx\n',
     'infra/app/Dockerfile.courtside-worker':'FROM scratch\n',
     'infra/app/courtside-linux-amd64-py311.lock':'# synthetic\n',
     'infra/app/courtside.production.disabled.yml':'services: {}\n',
     'infra/app/courtside.production.enabled.yml':'services: {}\n',
     'scripts/kbl_grayzone/example.py':'print("synthetic")\n',
     'scripts/fpa_cv_bytetrack.py':'# synthetic\n',
     'scripts/fpa_cv_uniforms.py':'# synthetic\n',
     'apps/web/public/kbl-grayzone/example.mjs':'// synthetic\n',
     'assets/courtside-report/font.dat':'synthetic font\n',
    }
    for name,text in files.items():
     p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
    for name in ('deploy_snapshot.py','courtside_export_release.py'):
     (repo/'scripts'/name).write_bytes((ROOT/'scripts'/name).read_bytes())
    subprocess.run(['git','-C',str(repo),'add','-A'],check=True)
    subprocess.run(['git','-C',str(repo),'-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','fixture'],check=True)
    sha=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
    remote=root/'origin.git';subprocess.run(['git','clone','-q','--bare',str(repo),str(remote)],check=True)
    subprocess.run(['git','-C',str(repo),'remote','add','origin',str(remote)],check=True)
    (repo/'infra/app/.env').write_text('SYNTHETIC=1\n')
    if enabled:
     envfile=private/'deploy.env';envfile.write_text('SYNTHETIC=1\n');envfile.chmod(0o600)
    log=root/'docker.jsonl'
    docker=bin_dir/'docker';docker.write_text('''#!/usr/bin/env python3
import json,os,sys
with open(os.environ['DOCKER_TEST_LOG'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
if len(sys.argv)>1 and sys.argv[1]=='inspect':print('healthy')
if os.environ.get('DOCKER_FAIL_T4')=='1' and any('nvidia-smi -L' in x for x in sys.argv):sys.exit(1)
if os.environ.get('DOCKER_FAIL_S3')=='1' and 'run' in sys.argv and '--entrypoint' in sys.argv:
 calls=[json.loads(line) for line in open(os.environ['DOCKER_TEST_LOG'])]
 if sum('run' in x and '--entrypoint' in x for x in calls)>=2:sys.exit(1)
''');docker.chmod(0o755)
    for name,body in [('findmnt','echo nfs4'),('curl','echo ok'),('sleep','exit 0'),('flock','exit 0')]:
     p=bin_dir/name;p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o755)
    workflow=yaml.safe_load((ROOT/'.github/workflows/deploy-production.yml').read_text())['jobs']['deploy']['steps'][0]['run']
    workflow=workflow.replace('/home/ubuntu/fp-live-admin',str(repo)).replace('/home/ubuntu/deploy-backups',str(backup))
    workflow=workflow.replace('/home/ubuntu/.config/courtside',str(private)).replace('/home/ubuntu/.fpc-docker-maintenance.lock',str(root/'maintenance.lock'))
    workflow=workflow.replace('${{ github.sha }}',sha)
    env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],'DOCKER_TEST_LOG':str(log),'DOCKER_FAIL_T4':'1' if fail_t4 else '0','DOCKER_FAIL_S3':'1' if fail_s3 else '0'}
    result=subprocess.run(['bash','-s'],input=workflow,text=True,capture_output=True,env=env,timeout=60)
    if fail_t4 or fail_s3:self.assertNotEqual(result.returncode,0)
    else:self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
    calls=[json.loads(line) for line in log.read_text().splitlines()]
    flat=[' '.join(call) for call in calls]
    if fail_s3:
     self.assertFalse(any('up -d potoken api web' in v or 'up -d --no-deps courtside-eic courtside-v2' in v for v in flat))
    elif fail_t4:
     self.assertFalse(any('up -d potoken api web' in v for v in flat))
     self.assertTrue(any('stop courtside-v2 courtside-eic' in v for v in flat))
    elif enabled:
     worker=next(i for i,v in enumerate(flat) if 'up -d --no-deps courtside-eic courtside-v2' in v)
     preflight=next(i for i,v in enumerate(flat) if 'cloud_preflight.py --require-full' in v)
     t4=next(i for i,v in enumerate(flat) if 'nvidia-smi -L' in v)
     public=next(i for i,v in enumerate(flat) if 'up -d potoken api web' in v)
     self.assertLess(worker,preflight);self.assertLess(preflight,t4);self.assertLess(t4,public)
     self.assertTrue(any('courtside.production.enabled.yml' in v for v in flat))
     build=next(call for call in calls if call and call[0]=='build' and 'Dockerfile.courtside-worker' in ' '.join(call))
     context=Path(build[-1]);self.assertEqual(context.parent,(repo/'runtime/courtside-releases').resolve())
     self.assertEqual(Path(build[build.index('-f')+1]),context/'infra/app/Dockerfile.courtside-worker')
     self.assertTrue((context/'infra/app/courtside-linux-amd64-py311.lock').is_file())
     self.assertFalse((context/'infra/app/.env').exists())
    else:
     self.assertFalse(any('courtside.production.enabled.yml' in v for v in flat))
     self.assertFalse(any('courtside-v2' in v for v in flat))

if __name__=='__main__':unittest.main()
