#!/usr/bin/env bash
# Synthetic deployment-shape smoke: matching shared store and private UDS.
set -euo pipefail
image="${1:?worker image required}"
work="$(mktemp -d)"
worker="courtside-socket-qa-$(python3 -c 'import secrets;print(secrets.token_hex(6))')"
cleanup() {
  docker rm -f "$worker" >/dev/null 2>&1 || true
  sudo rm -rf -- "$work"
}
trap cleanup EXIT
store="$work/store"
mkdir -p "$store/scripts/kbl_grayzone" "$store/apps/web/public/kbl-grayzone" "$store/run"
touch "$store/scripts/fpa_cv_bytetrack.py" "$store/scripts/fpa_cv_uniforms.py"
sudo chown -R 1000:1000 "$work"
chmod 700 "$work" "$store"
docker run -d --name "$worker" --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  -v "$store:/workspace" \
  -v "$PWD/scripts/kbl_grayzone:/workspace/scripts/kbl_grayzone:ro" \
  -v "$PWD/scripts/fpa_cv_bytetrack.py:/workspace/scripts/fpa_cv_bytetrack.py:ro" \
  -v "$PWD/scripts/fpa_cv_uniforms.py:/workspace/scripts/fpa_cv_uniforms.py:ro" \
  -v "$PWD/apps/web/public/kbl-grayzone:/workspace/apps/web/public/kbl-grayzone:ro" \
  -v "$PWD/assets/courtside-report:/opt/courtside-report:ro" \
  -w /workspace --entrypoint /usr/local/bin/python "$image" \
  scripts/kbl_grayzone/serve_socket.py --socket run/courtside.sock >/dev/null
ready=false
for _ in $(seq 1 40); do
  if docker exec "$worker" test -S /workspace/run/courtside.sock; then ready=true; break; fi
  sleep .25
done
if [ "$ready" != true ]; then docker logs "$worker"; exit 1; fi
docker run --rm --network none --user 1000:1000 -v "$store:/shared" --entrypoint python "$image" -c '
import hashlib,json,os,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect("/shared/run/courtside.sock")
s.sendall(b"GET /api/internal/store-identity HTTP/1.0\r\nHost: 127.0.0.1:4350\r\n\r\n")
chunks=[]
while True:
 b=s.recv(8192)
 if not b:break
 chunks.append(b)
head,body=b"".join(chunks).split(b"\r\n\r\n",1)
assert b" 200 " in head
stat=os.stat("/shared");expected=hashlib.sha256(f"{stat.st_dev}:{stat.st_ino}".encode()).hexdigest()
assert json.loads(body)["storeIdentity"]==expected
print("isolated worker and shared store socket verified")
'
