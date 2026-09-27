#!/usr/bin/env python3
"""Loopback video tracking queue and FPA workbench. No remote video transfer."""
from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys
import signal
import threading
from urllib.parse import urlparse, parse_qs

WEB = Path(__file__).resolve().parents[1] / "apps/web/public/fpa-cv"
FPA_LOCK = threading.Lock()


def fpa_workbench():
    os.environ.setdefault('MPLCONFIGDIR', str(Path(os.getenv('TMPDIR','/tmp')) / 'fpa-cv-matplotlib'))
    sys.path.insert(0, str(WEB.parents[2] / 'api'))
    from app import fpa_workbench as service
    return service


def byte_range(value: str | None, size: int) -> tuple[int, int] | None:
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()) or size <= 0:
        raise ValueError("Invalid range")
    left, right = match.groups()
    start = int(left) if left else max(0, size - int(right))
    end = min(size - 1, int(right)) if left and right else size - 1
    if start > end or start >= size:
        raise ValueError("Range outside file")
    return start, end


def handler_for(run: Path | None, jobs=None, worker_token=None):
    routes = {"/": (WEB / "index.html", "text/html; charset=utf-8"),
              "/index.html": (WEB / "index.html", "text/html; charset=utf-8"),
              "/app.mjs": (WEB / "app.mjs", "text/javascript; charset=utf-8"),
              "/core.mjs": (WEB / "core.mjs", "text/javascript; charset=utf-8"),
              "/colors.mjs": (WEB / "colors.mjs", "text/javascript; charset=utf-8"),
              "/identity.mjs": (WEB / "identity.mjs", "text/javascript; charset=utf-8"),
              "/boundary.mjs": (WEB / "boundary.mjs", "text/javascript; charset=utf-8"),
              "/integrity.mjs": (WEB / "integrity.mjs", "text/javascript; charset=utf-8"),
              "/continuity.mjs": (WEB / "continuity.mjs", "text/javascript; charset=utf-8"),
              "/setup-ui.mjs": (WEB / "setup-ui.mjs", "text/javascript; charset=utf-8"),
              "/fpa-events.mjs": (WEB / "fpa-events.mjs", "text/javascript; charset=utf-8"),
              "/style.css": (WEB / "style.css", "text/css; charset=utf-8"),
              "/scene/futsal-pitch.svg": (WEB.parent / "scene/futsal-pitch.svg", "image/svg+xml"),
              "/fonts/paperlogy/Paperlogy-4Regular.woff2": (WEB.parent / "fonts/paperlogy/Paperlogy-4Regular.woff2", "font/woff2")}

    if run:
        for name,mime in [('tracks.json','application/json'),('initial-review.json','application/json'),('preview.mp4','video/mp4')]:
            routes['/'+name]=(run/name,mime)
    for name, mime in [('recovery-protocol.mjs','text/javascript'),('recovery-cache.mjs','text/javascript'),('recovery-worker.mjs','text/javascript'),('recovery-client.mjs','text/javascript'),('preflight.mjs','text/javascript'),('tracking.mjs','text/javascript'),('shell.mjs','text/javascript'),('tracking.css','text/css'),('guide.html','text/html'),('guide.css','text/css'),('brand.css','text/css'),('fpc-ui.mjs','text/javascript'),('fpc-editor.html','text/html'),
                       ('fpc-editor.bundle.js','text/javascript'),('fpc-editor.bundle.css','text/css')]:
        routes['/'+name]=(WEB/name,mime+'; charset=utf-8')
    for name in ['upload-library.mjs','heatmaps.mjs','heatmap-ui.mjs','checkpoint-recovery.mjs','checkpoint-plan.mjs','checkpoint-ui.mjs','review-batch.mjs','lineup.mjs','console-embed.mjs','server-review.mjs']:
        routes['/'+name]=(WEB/name,'text/javascript; charset=utf-8')
    for asset in (WEB.parent/'fonts/paperlogy').glob('*.woff2'):
        routes['/fonts/paperlogy/'+asset.name]=(asset,'font/woff2')

    def existing_job():
        if not run or not (run/'tracks.json').is_file():
            return None
        data=json.loads((run/'tracks.json').read_text())
        result={'tracks':'/tracks.json','preview':'/preview.mp4'}
        if (run/'initial-review.json').is_file():result['initialReview']='/initial-review.json'
        return {'id':'existing','status':'completed','stage':'기존 결과','name':data['video']['name'],
                'video':data['video'],'datasetId':data['datasetId'],'model':'YOLO26s','deviceLabel':'기존 분석',
                'trackCount':len(data['tracks']),'samples':len(data['frames']), 'progress':100,
                'createdAt':(run/'tracks.json').stat().st_mtime,'result':result}
    legacy=existing_job()

    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.serve(head=True)

        def do_GET(self):
            self.serve()

        def send_json(self, value, status=200):
            content=json.dumps(value,ensure_ascii=False).encode()
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(content)));self.send_header('Cache-Control','no-store');self.end_headers()
            if self.command!='HEAD':self.wfile.write(content)

        def tracking_post(self,route):
            from fpa_cv_jobs import JobError
            if not jobs:
                self.send_json({'detail':'트래킹 서버가 준비되지 않았습니다.'},503);return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if route=='/api/tracking/uploads':
                    name=parse_qs(urlparse(self.path).query).get('name',[''])[0]
                    self.connection.settimeout(120)
                    self.send_json(jobs.receive_upload(self.rfile,size,name),201);return
                if not 0<=size<=65536:raise JobError('분석 설정 요청이 너무 큽니다.',413)
                value=json.loads(self.rfile.read(size) or b'{}')
                if route=='/api/tracking/batch/start':
                    self.send_json(jobs.start_batch(value.get('ids')),202);return
                if route=='/api/tracking/uploads/register':
                    self.send_json(jobs.register_upload(value),201);return
                upload_match=re.fullmatch(r'/api/tracking/uploads/([0-9a-f]{32})/remove',route)
                if upload_match:
                    self.send_json(jobs.remove_upload(upload_match[1]));return
                if route in {'/api/tracking/jobs','/api/tracking/preparations'}:
                    if not isinstance(value,dict):raise JobError('분석 설정을 확인하세요.')
                    create=jobs.create_preparation if route.endswith('/preparations') else jobs.create
                    self.send_json(create(value.get('uploadId'),value),202);return
                if route in {'/api/tracking/jobs/existing/delete','/api/tracking/jobs/existing/restore'} and legacy:
                    self.send_json(jobs.legacy_state(legacy,route.endswith('/delete')));return
                match=re.fullmatch(r'/api/tracking/jobs/([0-9a-f]{32})/(cancel|retry|delete|restore|purge|start)',route)
                if not match:raise JobError('요청을 찾지 못했습니다.',404)
                self.send_json(getattr(jobs,match[2])(match[1]),202 if match[2] in {'cancel','retry'} else 200)
            except JobError as error:self.send_json({'detail':str(error)},error.status)
            except (ValueError,TypeError):self.send_json({'detail':'요청 형식을 확인하세요.'},400)
            except (OSError,TimeoutError):self.send_json({'detail':'영상 전송 또는 저장이 중단되었습니다.'},500)

        def do_POST(self):
            host=self.headers.get('Host','')
            if worker_token and not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+worker_token):
                self.send_json({'detail':'인증이 필요합니다.'},401);return
            if not worker_token and (host.split(':')[0] not in {'127.0.0.1','localhost'} or self.headers.get('Origin') not in (None,f'http://{host}')):
                self.send_error(403);return
            route=urlparse(self.path).path
            if route.startswith('/api/tracking/'):
                self.tracking_post(route);return
            allowed={'normalize','describe','match','edit','import','export'}
            aliases={'/api/fpa/logs/generate':'generate-editor','/api/fpa/analyze/export':'export','/api/xgot/estimate':'xgot'}
            operation=aliases.get(route,route.removeprefix('/api/fpa/workbench/'))
            if route not in aliases and (not route.startswith('/api/fpa/workbench/') or operation not in allowed):
                self.send_error(404);return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=16*1024*1024:
                    self.send_json({'detail':'요청은 최대 16MB입니다.'},413);return
                raw=self.rfile.read(size)
                with FPA_LOCK:
                    service=fpa_workbench()
                    if operation=='generate-editor':result=service.generate_editor_log(json.loads(raw))
                    elif operation=='xgot':result=service.estimate_editor_xgot(json.loads(raw))
                    elif operation=='import':result=service.import_workbook(raw)
                    elif operation=='export':result=service.export_workbook(json.loads(raw))
                    else:result=service.dispatch(operation,json.loads(raw))
                if isinstance(result,bytes):
                    self.send_response(200);self.send_header('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Length',str(len(result)));self.end_headers();self.wfile.write(result)
                else:self.send_json(result)
            except (ValueError,KeyError,TypeError) as error:
                self.send_json({'detail':str(error)},400)
            except Exception as error:
                self.send_json({'detail':f'FPA 처리 실패: {error}'},500)

        def serve(self, head=False):
            # Reject DNS rebinding; do not expose arbitrary paths or directory listings.
            host = self.headers.get("Host", "").split(":")[0]
            if worker_token and not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+worker_token):
                self.send_json({'detail':'인증이 필요합니다.'},401);return
            if not worker_token and host not in {"127.0.0.1", "localhost"}:
                self.send_error(403)
                return
            if urlparse(self.path).path=='/api/fpa/workbench/capabilities':
                self.send_json({'mode':'local','canSaveMatch':False});return
            route=urlparse(self.path).path
            item = routes.get(route)
            if route.startswith('/api/tracking/'):
                from fpa_cv_jobs import JobError
                try:
                    if not jobs:raise JobError('트래킹 서버가 준비되지 않았습니다.',503)
                    if route=='/api/tracking/capabilities':self.send_json(jobs.capabilities());return
                    if route=='/api/tracking/jobs':
                        listing={'jobs':jobs.listing(),'deleted':jobs.listing(deleted=True)}
                        if legacy:
                            item=jobs.legacy_state(legacy)
                            listing['deleted' if item.get('deletedAt') else 'jobs'].append(item)
                        self.send_json(listing);return
                    if route=='/api/tracking/jobs/existing' and legacy:self.send_json(jobs.legacy_state(legacy));return
                    match=re.fullmatch(r'/api/tracking/jobs/([0-9a-f]{32})(?:/(tracks.json|preview.mp4|source|detections.json|frame.png|initial-review.json))?',route)
                    if not match:raise JobError('분석 작업을 찾지 못했습니다.',404)
                    if not match[2]:self.send_json(jobs.get(match[1]));return
                    item=jobs.asset(match[1],match[2])
                except JobError as error:self.send_json({'detail':str(error)},error.status);return

            if not item or not item[0].is_file():
                self.send_error(404)
                return
            path, mime = item
            size = path.stat().st_size
            try:
                selected = byte_range(self.headers.get("Range"), size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end = selected if selected else (0, size-1)
            self.send_response(206 if selected else 200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(end-start+1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if selected:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head:
                return
            try:
                with path.open("rb") as file:
                    file.seek(start)
                    remaining = end-start+1
                    while remaining > 0:
                        chunk = file.read(min(1024*1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


if __name__ == "__main__":
    from fpa_cv_jobs import TrackingJobs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, nargs='?', help="Optional existing tracking result")
    parser.add_argument("--port", type=int, default=4326)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--token-file', type=Path, help='Private worker credential; required beyond loopback')
    parser.add_argument("--jobs-dir", type=Path, default=WEB.parents[3]/'runtime/fpa-cv/workbench')
    parser.add_argument("--python", default=sys.executable, help="Python with the existing CV dependencies")
    args = parser.parse_args()
    token=args.token_file.read_text().strip() if args.token_file else None
    if (args.bind not in {'127.0.0.1','localhost'} or args.token_file) and (not token or len(token)<32):
        parser.error('Private GPU service requires a token file with at least 32 characters')
    run=args.run.resolve() if args.run else None
    if run and not (run/'tracks.json').is_file():parser.error('기존 트래킹 결과를 찾지 못했습니다.')
    manager=TrackingJobs(args.jobs_dir, args.python)
    def stop(_signum,_frame):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop)
    server=ThreadingHTTPServer((args.bind,args.port),handler_for(run,manager,token))
    print(f"FPA: http://127.0.0.1:{args.port}/ — 영상 트래킹 / 작업 화면 / 사용 가이드",flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        manager.close()
        server.server_close()
