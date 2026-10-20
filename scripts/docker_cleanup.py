"""Bounded FPC image/cache retention; never prune containers, volumes or media.

Default is a dry run. Keep every container image (including stopped containers),
canonical :latest tags, explicitly pinned keep-* tags / fpc.cleanup.keep=true,
and two previous images per running service family. Unknown repositories and
untagged images are untouched. The deployment workflow shares the same flock.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

CANONICAL = {
    'app-api': 'api', 'app-scene-render': 'api', 'app-web': 'web',
    'app-highlight-render': 'highlight-render', 'app-recording': 'recording',
}
LEGACY = {'fpc-api-rollback': 'api', 'fpc-web-rollback': 'web',
          'fpc-recording-rollback': 'recording'}
DEFAULT_LOCK = '/home/ubuntu/.fpc-docker-maintenance.lock'


def family(tag):
    repo = tag.rsplit(':', 1)[0]
    if repo in CANONICAL or repo in LEGACY:
        return {**CANONICAL, **LEGACY}[repo]
    match = re.fullmatch(r'(?:fpc|fpa)-[a-zA-Z0-9_.-]+-(highlight-render|recording|api|web)', repo)
    return match.group(1) if match else None


def created(image):
    value = datetime.fromisoformat(image['Created'].replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Image creation date must include a timezone')
    return value


def plan(images, containers, *, now, min_age_hours=24, keep_previous=2):
    if min_age_hours < 24 or keep_previous < 2:
        raise ValueError('At least 24 hours and two rollback versions are required')
    by_id = {i['Id']: i for i in images}
    used = {c['Image'] for c in containers}
    if not used.issubset(by_id):
        raise RuntimeError('Container image inventory changed; try again later')
    groups = {i['Id']: {family(tag) for tag in i.get('RepoTags') or []} - {None}
              for i in images}
    anchors = defaultdict(list)
    for container in containers:
        if container['State']['Running']:
            for group in groups[container['Image']]:
                anchors[group].append(created(by_id[container['Image']]))
    rollback = set()
    for group, dates in anchors.items():
        previous = sorted((i for i in images if group in groups[i['Id']]
                           and i['Id'] not in used and created(i) < max(dates)),
                          key=lambda i: (created(i), i['Id']), reverse=True)
        rollback.update(i['Id'] for i in previous[:keep_previous])
    protected, remove = {}, []
    for image in images:
        image_id, tags = image['Id'], sorted(image.get('RepoTags') or [])
        reasons = []
        if image_id in used:
            reasons.append('referenced by a container')
        if not tags or any(family(tag) is None for tag in tags):
            reasons.append('untagged or outside managed repositories')
        if any(tag.rsplit(':', 1)[0] in CANONICAL and tag.endswith(':latest') for tag in tags):
            reasons.append('current deployment tag')
        if (str((image.get('Config', {}).get('Labels') or {}).get('fpc.cleanup.keep', '')).lower() == 'true'
                or any(tag.rsplit(':', 1)[-1].startswith('keep-') for tag in tags)):
            reasons.append('explicitly pinned')
        if image_id in rollback:
            reasons.append('recent rollback version')
        if any(group not in anchors for group in groups[image_id]):
            reasons.append('no running baseline for service family')
        if created(image) > now - timedelta(hours=min_age_hours):
            reasons.append('younger than retention age')
        if reasons:
            protected[image_id] = {'tags': tags, 'reasons': reasons}
        else:
            remove.append({'id': image_id, 'tags': tags})
    return {'remove': remove, 'protected': protected}


class Docker:
    def run(self, *args, timeout=60):
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError('Docker command failed: ' + result.stderr.strip()[-1200:])
        return result.stdout

    def inventory(self):
        container_ids = self.run('ps', '--all', '--quiet', '--no-trunc').split()
        containers = json.loads(self.run('inspect', *container_ids)) if container_ids else []
        image_ids = sorted(set(self.run('image', 'ls', '--all', '--quiet', '--no-trunc').split()))
        images = json.loads(self.run('image', 'inspect', *image_ids)) if image_ids else []
        return images, containers

    def remove(self, tags):
        # No --force: Docker refuses removal if a new container references it.
        return self.run('image', 'rm', *tags, timeout=120)

    def prune_cache(self):
        # Never query buildx history: that endpoint previously crashed this host.
        help_text = self.run('builder', 'prune', '--help')
        reserve = '--reserved-space' if '--reserved-space' in help_text else '--keep-storage'
        return self.run('builder', 'prune', '--force', '--all', '--filter',
                        'until=24h', reserve, '2GB', timeout=600)


def busy_reason(proc=Path('/proc')):
    """Supplement the shared deployment lock for manual builds/old workflows."""
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            argv = [v.decode(errors='replace') for v in (path / 'cmdline').read_bytes().split(b'\0') if v]
            comm = (path / 'comm').read_text().strip()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if comm in ('docker-buildx', 'buildctl', 'Runner.Worker', 'docker-compose'):
            return 'build or deployment process active'
        if argv and Path(argv[0]).name == 'docker' and any(v in argv[1:] for v in ('build', 'buildx', 'compose', 'pull', 'load', 'tag')):
            return 'Docker build or deployment command active'
    return None


def snapshot(containers):
    return {c['Id']: {'name': c['Name'], 'image': c['Image'],
                     'started': c['State']['StartedAt'], 'running': c['State']['Running'],
                     'restarts': c['RestartCount']} for c in containers}


def clean(docker, audit, *, apply=False, busy=busy_reason, checkpoint=lambda: None):
    reason = busy()
    if reason:
        audit.update(status='skipped', reason=reason)
        return
    images, containers = docker.inventory()
    before = snapshot(containers)
    audit['containers_before'] = before
    audit['plan'] = plan(images, containers, now=datetime.now(timezone.utc))
    audit['operations'] = []
    checkpoint()
    if not apply:
        audit['status'] = 'dry-run'
        return
    for target in audit['plan']['remove']:
        reason = busy()
        if reason:
            audit.update(status='skipped', reason=reason)
            return
        fresh_images, fresh_containers = docker.inventory()
        if snapshot(fresh_containers) != before:
            raise RuntimeError('Container state changed; cleanup stopped')
        fresh = plan(fresh_images, fresh_containers, now=datetime.now(timezone.utc))
        if target not in fresh['remove']:
            raise RuntimeError('Candidate image or its tags changed; cleanup stopped')
        output = docker.remove(target['tags'])
        audit['operations'].append({'action': 'remove_image', **target, 'output': output.strip()})
        checkpoint()
    reason = busy()
    if reason:
        audit.update(status='skipped', reason=reason)
        return
    audit['operations'].append({'action': 'prune_unused_build_cache', 'output': docker.prune_cache().strip()})
    checkpoint()
    images, containers = docker.inventory()
    audit['containers_after'] = snapshot(containers)
    if audit['containers_after'] != before:
        raise RuntimeError('Container state changed during cleanup')
    remaining = {i['Id']: set(i.get('RepoTags') or []) for i in images}
    for image_id, protected in audit['plan']['protected'].items():
        if image_id not in remaining or not set(protected['tags']).issubset(remaining[image_id]):
            raise RuntimeError('Protected image changed during cleanup')
    audit.update(status='completed', services_unchanged=True, protected_images_verified=True)


def disk():
    value = shutil.disk_usage('/')
    return {'total': value.total, 'used': value.used, 'free': value.free,
            'used_percent': round(value.used / value.total * 100, 1)}


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/fpc-docker-cleanup'))
    parser.add_argument('--lock-file', type=Path, default=Path(DEFAULT_LOCK))
    args = parser.parse_args()
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True)
    # This path is installed once and also used by the production workflow.
    with os.fdopen(os.open(args.lock_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'skipped', 'reason': 'deployment/maintenance lock busy'}))
            return 0
        audit = {'started_at': datetime.now(timezone.utc).isoformat(), 'apply': args.apply,
                 'disk_before': disk(), 'status': 'running'}
        latest = args.state_dir / 'latest.json'
        code = 0
        try:
            clean(Docker(), audit, apply=args.apply, checkpoint=lambda: write_json(latest, audit))
        except Exception as exc:
            audit.update(status='failed', error=str(exc))
            code = 1
        audit['disk_after'] = disk()
        audit['reclaimed_bytes'] = audit['disk_after']['free'] - audit['disk_before']['free']
        audit['finished_at'] = datetime.now(timezone.utc).isoformat()
        write_json(latest, audit)
        if audit['status'] == 'completed':
            write_json(args.state_dir / 'last-success.json', audit)
        print(json.dumps({k: v for k, v in audit.items() if k not in
                          ('plan', 'operations', 'containers_before', 'containers_after')}))
        return code


if __name__ == '__main__':
    sys.exit(main())
