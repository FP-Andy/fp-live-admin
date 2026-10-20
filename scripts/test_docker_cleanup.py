"""Synthetic Docker inventories only; no Docker daemon or media is touched."""
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from docker_cleanup import Docker, busy_reason, clean, family, plan

NOW = datetime.now(timezone.utc)


def image(name, days, *tags, labels=None):
    return {'Id': name, 'Created': (NOW - timedelta(days=days)).isoformat(),
            'RepoTags': list(tags), 'Config': {'Labels': labels or {}}}


def container(img, *, running=True):
    return {'Id': 'container-' + img['Id'], 'Name': '/app-' + img['Id'],
            'Image': img['Id'], 'State': {'Running': running, 'StartedAt': 'unchanged'},
            'RestartCount': 0}


def fixture():
    values = [image('live', 2, 'app-api:latest', 'app-scene-render:latest'),
              image('previous-1', 5, 'app-api:before-scene-queue'),
              image('previous-2', 9, 'app-api:reviewed'),
              image('old', 15, 'app-api:old', 'fpc-older-api:latest'),
              image('candidate', .1, 'fpc-future-api:latest')]
    return values, [container(values[0])]


class FakeDocker:
    def __init__(self):
        self.images, self.containers = fixture()
        self.removed = []
        self.prunes = 0
        self.reads = 0
        self.change_on_read = None

    def inventory(self):
        self.reads += 1
        if self.change_on_read:
            self.change_on_read(self)
        return copy.deepcopy(self.images), copy.deepcopy(self.containers)

    def remove(self, tags):
        self.removed.append(tags)
        self.images = [i for i in self.images if set(i['RepoTags']) != set(tags)]
        return 'removed'

    def prune_cache(self):
        self.prunes += 1
        return 'unused cache only'


class RetentionTests(unittest.TestCase):
    def test_two_previous_versions_and_new_candidate_survive(self):
        images, containers = fixture()
        result = plan(images, containers, now=NOW)
        self.assertEqual([i['id'] for i in result['remove']], ['old'])
        self.assertTrue({'live', 'previous-1', 'previous-2', 'candidate'} <= result['protected'].keys())

    def test_rollback_is_per_service_and_includes_old_recording_versions(self):
        images, containers = fixture()
        for service in ['web', 'highlight-render', 'recording']:
            live = image(service, 2, f'app-{service}:latest')
            images += [live, image(service+'-prev1', 30, f'app-{service}:before-one'),
                       image(service+'-prev2', 60, f'app-{service}:before-two'),
                       image(service+'-old', 90, f'fpc-obsolete-{service}:latest')]
            containers.append(container(live))
        result = plan(images, containers, now=NOW)
        self.assertEqual({i['id'] for i in result['remove']},
                         {'old', 'web-old', 'highlight-render-old', 'recording-old'})
        self.assertEqual(family('fpc-recording-rollback:20260926'), 'recording')

    def test_running_and_stopped_container_references_always_survive(self):
        images, containers = fixture()
        containers.append(container(images[3], running=False))
        self.assertEqual(plan(images, containers, now=NOW)['remove'], [])
        containers[-1]['State']['Running'] = True
        self.assertEqual(plan(images, containers, now=NOW)['remove'], [])

    def test_unknown_aliases_explicit_pins_untagged_and_latest_are_preserved(self):
        images, containers = fixture()
        images += [image('db', 90, 'postgres:16-alpine'), image('cert', 90, 'certbot/certbot:latest'),
                   image('mixed', 90, 'app-api:old-copy', 'someone/backup:latest'),
                   image('untagged', 90), image('pin', 90, 'app-api:keep-special'),
                   image('label-pin', 90, 'app-api:manual-pin', labels={'fpc.cleanup.keep': 'true'}),
                   image('unknown-app', 90, 'app-not-ours:latest'),
                   image('latest-not-running', 90, 'app-web:latest')]
        result = plan(images, containers, now=NOW)
        self.assertEqual([i['id'] for i in result['remove']], ['old'])

    def test_no_running_baseline_or_incomplete_inventory_fails_closed(self):
        images, containers = fixture()
        containers[0]['State']['Running'] = False
        self.assertEqual(plan(images, containers, now=NOW)['remove'], [])
        with self.assertRaises(RuntimeError):
            plan(images[1:], containers, now=NOW)
        with self.assertRaises(ValueError):
            plan(images, containers, now=NOW, keep_previous=1)

    def test_dry_run_has_no_mutations_and_apply_only_removes_selected_tags(self):
        docker = FakeDocker()
        audit = {}
        clean(docker, audit, busy=lambda: None)
        self.assertEqual(audit['status'], 'dry-run')
        self.assertEqual((docker.removed, docker.prunes), ([], 0))
        clean(docker, audit, apply=True, busy=lambda: None)
        self.assertEqual(docker.removed, [['app-api:old', 'fpc-older-api:latest']])
        self.assertEqual(docker.prunes, 1)
        self.assertTrue(audit['services_unchanged'])

    def test_busy_build_skips_all_actions(self):
        docker, audit = FakeDocker(), {}
        clean(docker, audit, apply=True, busy=lambda: 'deployment active')
        self.assertEqual(audit['status'], 'skipped')
        self.assertEqual((docker.reads, docker.removed, docker.prunes), (0, [], 0))

    def test_retag_or_new_container_between_plan_and_remove_aborts(self):
        for change in ['tag', 'container']:
            with self.subTest(change=change):
                docker = FakeDocker()
                def mutate(value):
                    if value.reads == 2:
                        if change == 'tag':
                            value.images[3]['RepoTags'].append('app-api:keep-new-pin')
                        else:
                            value.containers.append(container(value.images[3]))
                docker.change_on_read = mutate
                with self.assertRaises(RuntimeError):
                    clean(docker, {}, apply=True, busy=lambda: None)
                self.assertEqual((docker.removed, docker.prunes), ([], 0))

    def test_failed_removal_does_not_continue_to_cache_prune(self):
        docker = FakeDocker()
        with patch.object(docker, 'remove', side_effect=RuntimeError('conflict')):
            with self.assertRaises(RuntimeError):
                clean(docker, {}, apply=True, busy=lambda: None)
        self.assertEqual(docker.prunes, 0)

    def test_cache_command_never_prunes_images_containers_or_volumes(self):
        docker = Docker()
        with patch.object(docker, 'run', side_effect=['--reserved-space', 'done']) as run:
            docker.prune_cache()
        self.assertEqual(run.call_args.args,
                         ('builder', 'prune', '--force', '--all', '--filter', 'until=24h', '--reserved-space', '2GB'))

    def test_process_guard_detects_builds_but_ignores_live_ffmpeg(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for pid, argv, comm in [('1', ['ffmpeg', '-i', 'fixture'], 'ffmpeg'),
                                    ('2', ['docker', 'compose', 'build', 'api'], 'docker')]:
                p = root / pid; p.mkdir()
                (p/'cmdline').write_bytes(b'\0'.join(v.encode() for v in argv))
                (p/'comm').write_text(comm)
            self.assertIsNotNone(busy_reason(root))
            (root/'2'/'cmdline').write_bytes(b'docker\0stats')
            self.assertIsNone(busy_reason(root))

    def test_deployment_lock_skips_without_contacting_docker(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp)/'lock'
            with lock.open('w') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                p = subprocess.run(['python3', str(Path(__file__).with_name('docker_cleanup.py')),
                                    '--apply', '--lock-file', str(lock), '--state-dir', temp],
                                   text=True, capture_output=True, timeout=5)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn('lock busy', p.stdout)


if __name__ == '__main__':
    unittest.main()
