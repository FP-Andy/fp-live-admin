"""Independent RTMP archive worker. No FLA state, API lifecycle or renderer dependencies.

Closed MP4 segments are durable before deletion; full MP4 is streamed to S3 with
bounded multipart buffers. A process restart resumes capture and pending uploads.
"""
from __future__ import annotations
import csv
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def capture_command(source, folder, segment_seconds=30):
    return ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-stats_period', '1',
            '-rw_timeout', '5000000', '-analyzeduration', '1000000', '-probesize', '1000000',
            '-fflags', '+genpts', '-i', source,
            '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
            '-f', 'segment', '-segment_time', str(segment_seconds),
            '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart',
            '-reset_timestamps', '1', '-segment_list', str(folder / 'closed.csv'),
            '-segment_list_type', 'csv', str(folder / 'part-%06d.mp4')]


def stop_process(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


class ArchiveStore:
    def __init__(self):
        import boto3
        from botocore.config import Config
        self.bucket = os.environ.get('HIGHLIGHT_S3_BUCKET', '')
        self.client = boto3.client('s3', region_name=os.environ.get('HIGHLIGHT_S3_REGION') or None,
                                   config=Config(connect_timeout=5, read_timeout=30, retries={'max_attempts': 2}))

    def probe(self):
        if not self.bucket:
            raise RuntimeError('archive storage not configured')
        key = 'prelaunch/recordings/health/' + uuid.uuid4().hex
        self.client.put_object(Bucket=self.bucket, Key=key, Body=b'FPC recording storage check')
        self.client.head_object(Bucket=self.bucket, Key=key)
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def upload(self, path, key):
        from boto3.s3.transfer import TransferConfig
        size = path.stat().st_size
        self.client.upload_file(str(path), self.bucket, key, ExtraArgs={'ContentType': 'video/mp4'},
                                Config=TransferConfig(max_concurrency=1, use_threads=False))
        actual = self.client.head_object(Bucket=self.bucket, Key=key)['ContentLength']
        if actual != size:
            raise RuntimeError('uploaded size mismatch')
        return size

    def url(self, key, download=False):
        params = {'Bucket': self.bucket, 'Key': key}
        if download:
            params['ResponseContentDisposition'] = 'attachment; filename="' + key.rsplit('/', 1)[-1] + '"'
        return self.client.generate_presigned_url('get_object', Params=params, ExpiresIn=21600)

    def combine(self, keys, key, folder):
        """No full-length local file and no re-encoding; retain parts on any error."""
        playlist = folder / 'assemble.txt'
        playlist.write_text(''.join("file '" + self.url(k).replace("'", "'\\''") + "'\n" for k in keys))
        proc = None
        upload_id = self.client.create_multipart_upload(Bucket=self.bucket, Key=key, ContentType='video/mp4')['UploadId']
        try:
            proc = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-rw_timeout', '30000000',
                '-f', 'concat', '-safe', '0', '-i', str(playlist), '-map', '0:v:0', '-map', '0:a:0?',
                '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            parts, size = [], 0
            while True:
                block = proc.stdout.read(8 * 1024 * 1024)
                if not block:
                    break
                if len(parts) >= 9999:
                    raise RuntimeError('archive exceeds multipart limit')
                response = self.client.upload_part(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                                   PartNumber=len(parts) + 1, Body=block)
                parts.append({'PartNumber': len(parts) + 1, 'ETag': response['ETag']})
                size += len(block)
            if proc.wait(timeout=30) != 0 or not parts:
                raise RuntimeError('MP4 assembly failed; original parts retained')
            self.client.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                                   MultipartUpload={'Parts': parts})
            if self.client.head_object(Bucket=self.bucket, Key=key)['ContentLength'] != size:
                raise RuntimeError('full archive size mismatch')
            return size
        except BaseException:
            stop_process(proc)
            self.client.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
            raise
        finally:
            if proc and proc.stdout:
                proc.stdout.close()
            playlist.unlink(missing_ok=True)


class Recorder:
    def __init__(self, root, store, pull_base, public_base, segment_seconds=30):
        self.root, self.store = Path(root), store
        self.root.mkdir(parents=True, exist_ok=True)
        self.pull_base, self.public_base = pull_base.rstrip('/'), public_base.rstrip('/')
        self.segment_seconds = segment_seconds
        self.lock = threading.RLock()
        self.workers = {}
        self.processes = {}
        self.closing = threading.Event()
        self.assembly_lock = threading.Lock()
        self.upload_retry_at = {}

    def path(self, sid):
        return self.root / str(uuid.UUID(sid))

    def load(self, sid):
        return json.loads((self.path(sid) / 'state.json').read_text())

    def update(self, sid, **values):
        with self.lock:
            state = self.load(sid)
            state.update(values)
            state['updated_at'] = now()
            self.write(state)
            return state

    def write(self, state):
        folder = self.path(state['id'])
        folder.mkdir(parents=True, exist_ok=True)
        temp = folder / 'state.tmp'
        with temp.open('w') as f:
            json.dump(state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        temp.replace(folder / 'state.json')

    def states(self, match_id=None):
        with self.lock:
            result = [json.loads(p.read_text()) for p in self.root.glob('*/state.json')]
            return sorted((s for s in result if match_id is None or s['match_id'] == match_id),
                          key=lambda s: s['created_at'], reverse=True)

    def launch(self, sid):
        with self.lock:
            if sid in self.workers and self.workers[sid].is_alive():
                return
            thread = threading.Thread(target=self.run, args=(sid,), daemon=True, name='recording-' + sid)
            self.workers[sid] = thread
            thread.start()

    def start(self, match_id):
        with self.lock:
            history = self.states(match_id)
            existing = next((s for s in history if s['desired']), None)
            if existing:
                self.launch(existing['id'])
                return existing
            if sum(s['desired'] for s in self.states()) >= 3:
                raise ValueError('동시 녹화는 최대 3경기입니다.')
            if shutil.disk_usage(self.root).free < 1024 ** 3:
                raise ValueError('녹화 임시 저장 공간이 부족합니다.')
            self.store.probe()
            sid = str(uuid.uuid4())
            # Re-arming the same match must not invalidate an OBS key already shared.
            key = history[0]['stream_key'] if history else 'basketball-' + secrets.token_hex(24)
            state = dict(id=sid, match_id=match_id, stream_key=key,
                         desired=True, status='waiting', created_at=now(), updated_at=now(),
                         stopped_at=None, parts=[], full_key=None, full_bytes=0, preview_at=None,
                         error=None, attempts=0, interruptions=0)
            self.write(state)
            self.launch(sid)
            return state

    def stop(self, sid):
        state = self.update(sid, desired=False, status='saving', stopped_at=now())
        # Worker owns process termination, avoiding simultaneous signal/wait races.
        return state

    def recover(self):
        for state in self.states():
            if state['desired'] or state['status'] in ('saving', 'assembling'):
                self.launch(state['id'])

    def retry(self, sid):
        state = self.load(sid)
        if state['desired']:
            raise ValueError('녹화를 종료한 뒤 저장을 재시도하세요.')
        self.update(sid, status='saving', error=None)
        self.launch(sid)

    def closed_parts(self, sid):
        found = []
        for listing in sorted(self.path(sid).glob('take-*/closed.csv')):
            for row in csv.reader(listing.read_text().splitlines()):
                if len(row) != 3:
                    continue
                name = Path(row[0]).name
                if not name.startswith('part-') or not name.endswith('.mp4'):
                    continue
                try:
                    duration = float(row[2]) - float(row[1])
                except ValueError:
                    continue
                if duration > 0:
                    found.append((listing.parent / name, duration))
        return found

    def upload_closed(self, sid):
        state = self.load(sid)
        known = {p['name'] for p in state['parts']}
        for path, duration in self.closed_parts(sid):
            name = path.parent.name + '-' + path.name
            if name in known:
                path.unlink(missing_ok=True)
                continue
            if not path.exists():
                raise RuntimeError('closed segment missing locally and remotely')
            key = f"prelaunch/recordings/{state['match_id']}/{sid}/{name}"
            size = self.store.upload(path, key)
            # Thumbnail failures never prevent archival. Generate only from a closed file.
            preview = self.path(sid) / 'preview.tmp.jpg'
            try:
                result = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                    '-sseof', '-1', '-i', str(path), '-frames:v', '1', '-vf', 'scale=640:-2', '-threads', '1', str(preview)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if result.returncode == 0 and preview.exists():
                    preview.replace(self.path(sid) / 'preview.jpg')
                    self.update(sid, preview_at=now())
            except (OSError, subprocess.TimeoutExpired):
                pass
            with self.lock:
                current = self.load(sid)
                current['parts'].append(dict(name=name, key=key, bytes=size, duration=duration, saved_at=now()))
                current['error'] = None
                current['updated_at'] = now()
                self.write(current)
            path.unlink()  # Only after remote size verification AND durable manifest.
            known.add(name)

    def upload_during_capture(self, sid):
        if time.monotonic() < self.upload_retry_at.get(sid, 0):
            return
        try:
            self.upload_closed(sid)
            self.upload_retry_at.pop(sid, None)
        except Exception:
            # Network/storage outages must not discard the incoming stream.
            # Keep closed files locally and retry until the disk reserve is reached.
            self.upload_retry_at[sid] = time.monotonic() + 15
            self.update(sid, error='저장소 연결을 재시도하고 있습니다. 수신 영상은 임시 보관 중입니다.')

    def run(self, sid):
        proc = None
        try:
            while self.load(sid)['desired'] and not self.closing.is_set():
                self.upload_during_capture(sid)
                if shutil.disk_usage(self.root).free < 1024 ** 3:
                    raise RuntimeError('임시 저장 공간 부족으로 녹화를 중지했습니다. 저장된 구간은 보존됩니다.')
                state = self.load(sid)
                if time.time() - datetime.fromisoformat(state['created_at']).timestamp() > 12 * 3600:
                    self.update(sid, desired=False, status='saving', stopped_at=now())
                    break
                attempt = state['attempts'] + 1
                folder = self.path(sid) / f'take-{attempt:05d}'
                folder.mkdir()
                self.update(sid, attempts=attempt, status='waiting')
                proc = subprocess.Popen(capture_command(self.pull_base + '/' + state['stream_key'], folder, self.segment_seconds),
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.processes[sid] = proc
                progress = {'frame': 0, 'last': time.monotonic(), 'reset': False}
                def read_progress(pipe):
                    for line in iter(pipe.readline, b''):
                        if line.startswith(b'frame='):
                            frame = int(line.split(b'=')[1])
                            if frame > progress['frame']:
                                progress['frame'], progress['last'] = frame, time.monotonic()
                def read_errors(pipe):
                    for line in iter(pipe.readline, b''):
                        if b'non-monoton' in line.lower() or b'non monotonically increasing' in line.lower():
                            progress['reset'] = True
                readers = [threading.Thread(target=read_progress, args=(proc.stdout,), daemon=True),
                           threading.Thread(target=read_errors, args=(proc.stderr,), daemon=True)]
                for reader in readers:
                    reader.start()
                received = False
                while proc.poll() is None and self.load(sid)['desired'] and not self.closing.wait(2):
                    if progress['frame'] > 0:
                        received = True
                        self.update(sid, status='recording' if time.monotonic() - progress['last'] < 4 else 'waiting')
                    self.upload_during_capture(sid)
                    if shutil.disk_usage(self.root).free < 768 * 1024 ** 2:
                        raise RuntimeError('임시 저장 공간 부족으로 녹화를 중지했습니다. 저장된 구간은 보존됩니다.')
                    if time.time() - datetime.fromisoformat(state['created_at']).timestamp() > 12 * 3600:
                        self.update(sid, desired=False, status='saving', stopped_at=now())
                        break
                    if progress['reset'] or time.monotonic() - progress['last'] > (4 if received else 45):
                        break
                stop_process(proc)
                for reader in readers:
                    reader.join(timeout=2)
                proc.stdout.close()
                proc.stderr.close()
                proc = None
                self.processes.pop(sid, None)
                self.upload_during_capture(sid)
                if received and self.load(sid)['desired']:
                    self.update(sid, interruptions=self.load(sid)['interruptions'] + 1)
                if self.closing.wait(3):
                    return
            if self.closing.is_set():
                return
            self.upload_closed(sid)
            state = self.load(sid)
            if not state['parts']:
                self.update(sid, status='empty', desired=False, error=None)
                return
            self.update(sid, status='assembling', desired=False)
            with self.assembly_lock:
                key = f"prelaunch/recordings/{state['match_id']}/{sid}/basketball-{state['match_id']}-{sid}.mp4"
                size = self.store.combine([p['key'] for p in state['parts']], key, self.path(sid))
            self.update(sid, status='ready', full_key=key, full_bytes=size, error=None)
        except Exception as exc:
            stop_process(proc)
            # Do not expose input URLs, AWS details or ffmpeg output to clients.
            message = str(exc) if isinstance(exc, RuntimeError) and str(exc).startswith('임시 저장') else '저장 작업에 문제가 발생했습니다. 원본 구간을 보존했으며 저장 재시도가 가능합니다.'
            self.update(sid, desired=False, status='error', error=message, stopped_at=now())
        finally:
            stop_process(proc)
            self.processes.pop(sid, None)

    def close(self):
        self.closing.set()
        for proc in list(self.processes.values()):
            stop_process(proc)
        for thread in list(self.workers.values()):
            thread.join(timeout=25)
