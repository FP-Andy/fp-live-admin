"""Start the worker with a fresh in-memory-filesystem SSH key and pinned host."""
import os
from pathlib import Path
import subprocess
import sys

DIRECTORY=Path('/tmp/courtside-t4')
KEY=DIRECTORY/'id_ed25519'
CONFIG=DIRECTORY/'ssh_config'
KNOWN='/run/courtside-credentials/t4-known-hosts'
PROXY='/usr/local/bin/python /workspace/scripts/kbl_grayzone/gpu_eic_transport.py proxy --socket /workspace/run/t4.sock --public-key /tmp/courtside-t4/id_ed25519.pub'

def main():
    DIRECTORY.mkdir(mode=0o700,parents=False,exist_ok=False)
    subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(KEY)],check=True,timeout=15)
    if not Path(KNOWN).is_file():raise RuntimeError('T4 host key is not configured')
    CONFIG.write_text('''Host courtside-t4
  HostName 127.0.0.1
  HostKeyAlias courtside-t4
  User ubuntu
  Port 22
  StrictHostKeyChecking yes
  UserKnownHostsFile /run/courtside-credentials/t4-known-hosts
  GlobalKnownHostsFile /dev/null
  IdentityFile /tmp/courtside-t4/id_ed25519
  IdentitiesOnly yes
  ForwardAgent no
  ProxyCommand '''+PROXY+'\n')
    CONFIG.chmod(0o600)
    if os.environ.get('COURTSIDE_GPU_STAGING_MODE')=='1':
        subprocess.run([sys.executable,'scripts/kbl_grayzone/cloud_preflight.py','--require-staging-gpu'],check=True,timeout=30)
    os.execv(sys.executable,[sys.executable,'scripts/kbl_grayzone/serve_socket.py','--socket','run/courtside.sock'])

if __name__=='__main__':main()
