#!/usr/bin/env bash
# Install the server timer without recreating application containers or Docker.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer with sudo.' >&2; exit 1; fi
id ubuntu >/dev/null
getent group docker >/dev/null
install -d -m 0755 /usr/local/lib/fpc
install -m 0644 "$ROOT/scripts/docker_cleanup.py" /usr/local/lib/fpc/docker_cleanup.py
install -m 0644 "$ROOT/infra/app/systemd/fpc-docker-cleanup.service" /etc/systemd/system/
install -m 0644 "$ROOT/infra/app/systemd/fpc-docker-cleanup.timer" /etc/systemd/system/
# Do not replace this inode: a deployment might already hold its lock.
runuser -u ubuntu -- python3 -c 'import os; fd=os.open("/home/ubuntu/.fpc-docker-maintenance.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600); os.close(fd)'
install -d -o ubuntu -g ubuntu -m 0700 /var/lib/fpc-docker-cleanup
systemd-analyze verify /etc/systemd/system/fpc-docker-cleanup.service /etc/systemd/system/fpc-docker-cleanup.timer
systemctl daemon-reload
systemctl enable --now fpc-docker-cleanup.timer
systemctl list-timers --all --no-pager fpc-docker-cleanup.timer
