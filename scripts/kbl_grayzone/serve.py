"""Local-only KBL workbench. Serves allowlisted media with byte ranges.

Run: python3 scripts/kbl_grayzone/serve.py --port 4350
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, unquote, parse_qs, quote
import argparse
import json
import mimetypes
import traceback
import re
import os
import sys
import importlib.util

# Local installs may keep S3 dependencies in the CV environment while the
# workbench uses the system interpreter for its working OpenCV installation.
# Append only when needed so the main interpreter's packages remain preferred.
if importlib.util.find_spec('boto3') is None:
    local_site=Path(__file__).resolve().parents[2]/'runtime/kbl-cv/venv/lib'/f'python{sys.version_info.major}.{sys.version_info.minor}'/'site-packages'
    if (local_site/'boto3').is_dir():sys.path.append(str(local_site))
from read_context import scoped
for thread_limit in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','VECLIB_MAXIMUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ.setdefault(thread_limit,'2')
import jobs
import pose_jobs
import case_store

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "apps/web/public/kbl-grayzone"
MEDIA = ROOT / "outputs/kbl-grayzone-demo-20261020"
ANALYSIS = ROOT / "outputs/kbl-grayzone-analysis/v2"
NAS = ROOT / "outputs/kbl-role-fusion-20261023/published"
REPORTS = ROOT / "outputs/kbl-reports"
MANIFEST = json.loads((MEDIA / "manifest.json").read_text()) if (MEDIA / "manifest.json").is_file() else {"clips": []}
ROSTERS = json.loads((MEDIA / "referees.json").read_text()) if (MEDIA / "referees.json").is_file() else {"games": []}
# Historical local demo calibrations are not part of the web package.
CALIBRATIONS = {}
CLIPS = {}
for c in MANIFEST["clips"]:
    city = next((k for k in CALIBRATIONS if k in c["slug"]), None)
    if city is None: continue
    key = f'{city}-{c["clip_number"]}'
    CLIPS[key] = dict(c, id=key, city=city)

def report_filename(case):
    def part(value, fallback):
        return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', ' ', str(value or ''))).strip() or fallback
    number=part(case.get('gameNumber'), '미확인')
    if number.isascii() and number.isdigit():number=number.zfill(3)
    return f"KBL 경기{number} {part(case.get('home'), '홈팀')} vs {part(case.get('away'), '원정팀')} - 경기 판독 리포트.pdf"

def scene(key, source="auto"):
    c=CLIPS[key];active=jobs.active_run(key);p=(active/"tracks.json") if active else ANALYSIS/key/"tracks.json"
    experiment=ROOT/"outputs/kbl-grayzone-analysis/basketball-experiment"/key
    available=["legacy"]
    if (experiment/"ready.json").exists() and (experiment/"combined.json").exists() and (experiment/"ball.json").exists():
        current=jobs.profile_for(key,CALIBRATIONS[c["city"]])
        experiment_profile=json.loads((experiment/"combined.json").read_text()).get("profile",{})
        if all(current.get(k)==experiment_profile.get(k) for k in ("anchors","palettes","ballKeyframes")):
            available.append("basketball")
    nas=NAS/key
    if (nas/"ready.json").exists():
        current=jobs.profile_for(key,CALIBRATIONS[c["city"]])
        profile=json.loads((nas/"tracks.json").read_text()).get("profile",{})
        if all(current.get(k)==profile.get(k) for k in ("anchors","palettes","ballKeyframes")):available.append("nas")
    selected="nas" if source=="nas" and "nas" in available else "basketball" if source not in ("legacy","nas") and "basketball" in available else "legacy"
    if selected=="basketball":p=experiment/"combined.json"
    if selected=="nas":p=nas/"tracks.json"
    tracked=json.loads(p.read_text()) if p.exists() else None
    manual=APP/"data"/f"{key}.json"
    return {
        "schema":"kbl-grayzone-scene/v1", "id":key,"posePipelineVersion":pose_jobs.PIPELINE_VERSION,
        "court":{"length":28,"width":15,"units":"metres","assumption":True},
        "calibration":{"method":"manual-nine-anchor-quadratic","status":"provisional","anchors":tracked.get("profile",{}).get("anchors",CALIBRATIONS[c["city"]]) if tracked else CALIBRATIONS[c["city"]]},
        "frames":[{"t":f["t"],"boxes":[{k:b[k] for k in ("id","box","confidence","appearance","roleHint","maskPolygon","trackingSource","seedReviewed") if k in b} for b in f["boxes"]]} for f in tracked["frames"]] if tracked else [],
        "detector":{k:tracked["detector"][k] for k in ("model","modelSource","tracker","imgsz","sampleFps","roiBeforeAssociation","outsideObservationsExcluded","inputObservations","reviewStatus","identityMethod","limitations") if k in tracked["detector"]} if tracked else None,
        "analysisSource":selected,"availableSources":available,
        "comparison":json.loads((experiment/"ready.json").read_text()) if "basketball" in available else None,
        "datasetId":tracked["datasetId"] if tracked else None,
        "review":json.loads(manual.read_text()) if manual.exists() else {},
        "appliedSetup":tracked.get("profile") if tracked else None,
        "setup":jobs.profile_for(key,CALIBRATIONS[c["city"]]),
        "ball":json.loads((nas/"ball.json").read_text()) if selected=="nas" else json.loads((experiment/"ball.json").read_text()) if selected=="basketball" else json.loads((active/"ball.json").read_text()) if active and (active/"ball.json").exists() else None,
        "job":jobs.status(key),
    }

class UploadBody:
    """Track bounded media bytes so an early rejection can finish its response."""
    def __init__(self,stream,size):self.stream=stream;self.remaining=size
    def read(self,size):
        data=self.stream.read(min(size,self.remaining));self.remaining-=len(data);return data
    def discard_remaining(self):
        try:
            while self.remaining:
                if not self.read(min(self.remaining,1024*1024)):break
        except OSError:
            pass  # The client already disconnected; preserve the original error.

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:return self.post()
        except (BrokenPipeError,ConnectionResetError):return
        except Exception:return self.unexpected_error()
    def post(self):
        if self.headers.get("Host","").split(":")[0] not in ("127.0.0.1","localhost"):return self.send_error(403)
        origin=self.headers.get("Origin")
        if origin and origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
        path=unquote(urlparse(self.path).path)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/video-jobs',path)
        if match:
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=128:return self.send_error(413)
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict) or set(payload)-{'action','playerOrientation'} or payload.get('action')!='create' or payload.get('playerOrientation','map') not in ('map','source','refit'):return self.json({'error':'영상 제작 요청을 확인하세요.'},code=400)
                import video_jobs
                return self.json(video_jobs.submit(*match.groups(),payload.get('playerOrientation','map')))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/manual-court',path)
        if match:
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=16000:return self.send_error(413)
                import court_manual
                return self.json(court_manual.save(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path=='/api/internal/fpc-intakes':
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=512000:return self.send_error(413)
                import review_intake
                return self.json(review_intake.create_for_authorized_fpc(json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/intake/([a-f0-9]{24})/sequence/(review-\d+)',path)
        if match:
            try:
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=64000:return self.send_error(413)
                import sequence_sync
                return self.json(sequence_sync.save(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/work-sessions',path)
        if match:
            try:
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=64000:return self.send_error(413)
                import work_session
                return self.json(work_session.save(match[1],json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path=='/api/gpu/start':
            # A browser action must originate from this exact local application.
            if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
            size=int(self.headers.get('Content-Length',0))
            if not 0<size<=128:return self.send_error(413)
            payload=json.loads(self.rfile.read(size))
            if payload!={'action':'start'}:return self.json({'error':'T4 시작 요청을 확인하세요.'},code=400)
            try:
                import gpu_control
                return self.json(gpu_control.start())
            except (ValueError,RuntimeError) as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/auto-pose-finalize',path)
        if match:
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                import auto_pose_review
                return self.json(auto_pose_review.finalize(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-video-batches',path)
        if match:
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                import report_video_batch
                return self.json(report_video_batch.submit(match[1],json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-jobs',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                import report_jobs,review_flow
                data=json.loads(self.rfile.read(size));review_flow.require_report(match[1])
                return self.json(report_jobs.submit(match[1],data.get('revision')))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/reports/([a-f0-9]{24})/publish',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<=size<=1000:return self.send_error(413)
                if size:self.rfile.read(size)
                import report_versions
                return self.json(report_versions.publish(*match.groups()))
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/sequence-import',path)
        if match:
            try:
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=4000:return self.send_error(413)
                import sequence_import
                return self.json(sequence_import.add(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/wide-reference',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=8000:return self.send_error(413)
                import wide_reference
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict):raise ValueError('광각 근거 요청을 확인하세요.')
                return self.json(wide_reference.save(*match.groups(),payload))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/intake/([a-f0-9]{24})/records',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=6000:return self.send_error(413)
                import review_intake
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict):raise ValueError('정정할 기록을 확인하세요.')
                return self.json(review_intake.correct_record(match[1],payload))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path=='/api/library/fpc/refresh':
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<=size<=1000:return self.send_error(413)
                if size:self.rfile.read(size)
                import fpc_sources,match_library,storage_policy
                storage_policy.external_root()
                fpc_sources.refresh();return self.json(match_library.source_status())
            except (ValueError,TypeError,OSError):return self.json({'error':'FPC 새로고침 요청을 확인하세요.'},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=503)
        match=re.fullmatch(r'/api/library/matches/([a-z0-9-]+)/(fpc|wide/(?:refresh|cache|resume|pause))',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=4000:return self.send_error(413)
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict):raise ValueError('요청 형식을 확인하세요.')
                import match_library,wide_preparation
                key,action=match.groups()
                if action=='fpc':
                    result=match_library.link_fpc(key,payload)
                    result.update(wide_preparation.discover(result['fpcMatchId']))
                    return self.json(result)
                row=match_library.get(key);mid=row.get('fpcMatchId')
                if not mid:raise ValueError('이 경기의 FPC 녹화를 먼저 연결하세요.')
                action=action.split('/')[1]
                return self.json(wide_preparation.pause(mid) if action=='pause' else wide_preparation.submit(mid,action,payload.get('sessionId')))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/(cases|intake)/([a-z0-9-]+)/uniforms',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=12000:return self.send_error(413)
                import uniforms
                return self.json(uniforms.save(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path=='/api/library/matches':
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=8000:return self.send_error(413)
                import match_library
                created=match_library.create(json.loads(self.rfile.read(size)))
                if created.get('fpcMatchId') and (not created.get('alreadyExists') or created.get('fpcLinkedNow')):
                    import wide_preparation
                    created.update(wide_preparation.discover(created['fpcMatchId']))
                return self.json(created)
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/(intake|matches)/([a-z0-9-]+)/referees',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=4000:return self.send_error(413)
                import referee_roster
                return self.json(referee_roster.save(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path.startswith('/api/intake/'):
            try:
                import review_intake
                size=int(self.headers.get('Content-Length',0))
                match=re.fullmatch(r'/api/intake/([a-f0-9]{24})/media/(\d+)',path)
                if match:
                    if not 0<size<=8*1024**2:return self.send_error(413)
                    offset=int(parse_qs(urlparse(self.path).query).get('offset',['-1'])[0])
                    body=UploadBody(self.rfile,size)
                    try:return self.json(review_intake.upload(*match.groups(),offset,body,size))
                    except (ValueError,TypeError,KeyError,OSError,StopIteration,RuntimeError):
                        previous_timeout=self.connection.gettimeout()
                        try:
                            self.connection.settimeout(15)
                            body.discard_remaining()
                        finally:self.connection.settimeout(previous_timeout)
                        raise
                if not 0<size<=512000:return self.send_error(413)
                data=json.loads(self.rfile.read(size))
                if path=='/api/intake/create':return self.json(review_intake.create(data))
                if path=='/api/intake/demo':return self.json(review_intake.demo())
                match=re.fullmatch(r'/api/intake/([a-f0-9]{24})/(finalize|resume-matching|selection|handoff|media-assignments)',path)
                if not match:return self.send_error(404)
                key,action=match.groups()
                return self.json(review_intake.select(key,data) if action=='selection' else review_intake.assign_media(key,data) if action=='media-assignments' else review_intake.handoff(key) if action=='handoff' else review_intake.resume_matching(key) if action=='resume-matching' else review_intake.finalize(key))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/review-flow',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                import review_flow
                return self.json(review_flow.complete(*match.groups(),json.loads(self.rfile.read(size))))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/objects',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=100000:return self.send_error(413)
                import broadcast_objects,review_flow
                data=json.loads(self.rfile.read(size));review_flow.require_stage(match[1],'objects',match[2])
                return self.json(broadcast_objects.save(*match.groups(),data))
            except (ValueError,TypeError,KeyError,OSError,StopIteration) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/pose(?:/(review))?',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=100000:return self.send_error(413)
                import broadcast_pose,review_flow
                data=json.loads(self.rfile.read(size));key,event,action=match.groups()
                review_flow.require_stage(key,'joints',event)
                return self.json(broadcast_pose.review(key,event,data) if action else broadcast_pose.submit(key,event,data))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/pose-variants',path)
        if match:
            try:
                if origin!=f'http://{self.headers.get("Host")}':return self.send_error(403)
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send_error(415)
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=1000:return self.send_error(413)
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict) or set(payload)!={'captureId'}:raise ValueError('저장된 장면을 확인하세요.')
                import pose_variant,review_flow
                review_flow.require_stage(match[1],'spatial',match[2])
                return self.json(pose_variant.create(*match.groups(),payload['captureId']))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/reconstruction',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=18_000_000:return self.send_error(413)
                import broadcast_reconstruction,review_flow
                data=json.loads(self.rfile.read(size));review_flow.require_stage(match[1],'spatial',match[2])
                return self.json(broadcast_reconstruction.save(*match.groups(),data))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-editorial(?:/(preview))?',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=60000:return self.send_error(413)
                import report_inputs
                return self.json(report_inputs.save(match[1],json.loads(self.rfile.read(size)),preview=bool(match[2])))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
            except Exception:return self.report_error()
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/review-package',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                import report_bundle,review_flow
                data=json.loads(self.rfile.read(size));review_flow.require_report(match[1])
                return self.json(report_bundle.build(match[1],data))
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
            except Exception:return self.report_error()
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=2000:return self.send_error(413)
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ValueError('프레임 선택 개정 번호가 필요합니다.')
                import review_flow
                review_flow.require_report(match[1])
                from case_report import generate_case_report
                return self.json(generate_case_report(match[1],data.get('revision')))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
            except Exception:return self.report_error()
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/selection',path)
        if match:
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=16000:return self.send_error(413)
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ValueError('선택 정보가 필요합니다.')
                return self.json(case_store.save_selection(match[1],match[2],data))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path.startswith('/api/poses/'):
            key=path.removeprefix('/api/poses/')
            if key not in CLIPS:return self.send_error(404)
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=256000:return self.send_error(413)
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ValueError('프레임 정보가 필요합니다.')
                source=data.get('analysisSource')
                if source not in ('legacy','basketball','nas'):raise ValueError('분석 결과를 선택하세요.')
                return self.json(pose_jobs.submit(data,CLIPS[key],scene(key,source),MEDIA/CLIPS[key]['file']))
            except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},code=400)
            except RuntimeError as e:return self.json({'error':str(e)},code=409)
        if path=="/api/reports":
            try:
                size=int(self.headers.get("Content-Length",0))
                if not 0<size<=48_000_000:return self.send_error(413)
                from report_pdf import create_report
                return self.json(create_report(json.loads(self.rfile.read(size)),REPORTS,scene,CLIPS))
            except (ValueError,TypeError,KeyError) as e:return self.json({"error":str(e)},code=400)
            except RuntimeError as e:return self.json({"error":str(e)},code=409)
        if not path.startswith("/api/setup/"):return self.send_error(404)
        key=path.removeprefix("/api/setup/")
        if key not in CLIPS:return self.send_error(404)
        try:
            size=int(self.headers.get("Content-Length",0))
            if not 0<size<=128000:return self.send_error(413)
            data=json.loads(self.rfile.read(size))
            return self.json(jobs.submit(key,data))
        except (ValueError,TypeError) as e:return self.json({"error":str(e)},code=400)
        except RuntimeError as e:return self.json({"error":str(e)},code=409)
    def do_HEAD(self):
        try:return self.respond(head=True)
        except (BrokenPipeError,ConnectionResetError):return
        except Exception:return self.unexpected_error(head=True)
    def do_GET(self):
        try:return self.respond()
        except (BrokenPipeError,ConnectionResetError):return
        except Exception:return self.unexpected_error()
    def unexpected_error(self,head=False):
        traceback.print_exc()
        import diagnostics,sys
        message='서버 처리 중 오류가 발생했습니다. 저장된 작업과 현재 입력을 유지하고 다시 시도하세요.'
        return self.json({'error':message,'diagnostics':diagnostics.record(self,message,sys.exc_info()[1])},head,500)
    def report_error(self,head=False):
        # Keep unexpected report failures as JSON so the editor retains drafts.
        traceback.print_exc()
        import diagnostics,sys
        message='리포트 처리 중 서버 오류가 발생했습니다. 입력을 유지한 채 다시 시도하세요.'
        return self.json({'error':message,'diagnostics':diagnostics.record(self,message,sys.exc_info()[1])},head,500)

    def json(self,data,head=False,code=200):
        if isinstance(data,dict) and data.get('error') and 'diagnostics' not in data:
            import diagnostics
            data={**data,'diagnostics':diagnostics.record(self,data['error'])}
        body=json.dumps(data,ensure_ascii=False,separators=(",",":")).encode()
        self.send_response(code);self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body)));self.send_header("Cache-Control","no-store");self.end_headers()
        if not head:self.wfile.write(body)
    @scoped
    def respond(self,head=False):
        if self.headers.get("Host","").split(":")[0] not in ("127.0.0.1","localhost"):
            return self.send_error(403,"Local host only")
        path=unquote(urlparse(self.path).path);reconstruction_file=None
        if path=='/api/internal/store-identity':
            import hashlib
            info=ROOT.stat();value=hashlib.sha256(f'{info.st_dev}:{info.st_ino}'.encode()).hexdigest()
            return self.json({'storeIdentity':value},head)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-video-(readiness|batches)',path)
        if match:
            try:
                import report_video_batch
                return self.json(report_video_batch.readiness(match[1]) if match[2]=='readiness' else {'job':report_video_batch.latest(match[1])},head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-video-batches/([a-f0-9]{24})',path)
        if match:
            try:
                import report_video_batch
                job=report_video_batch.status(match[2])
                if job.get('caseId')!=match[1]:return self.send_error(404)
                return self.json({'job':job},head)
            except (ValueError,KeyError,OSError):return self.send_error(404)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/review-videos',path)
        if match:
            try:
                import review_videos
                return self.json(review_videos.catalog(match[1]),head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/video-jobs/([a-f0-9]{24})',path)
        if match:
            try:
                import video_jobs
                job=video_jobs.status(match[2])
                if job.get('caseId')!=match[1]:return self.send_error(404)
                return self.json(job,head)
            except (ValueError,KeyError,OSError):return self.send_error(404)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/work-sessions',path)
        if match:
            try:
                import work_session
                return self.json(work_session.view(match[1],export=parse_qs(urlparse(self.path).query).get('export')==['1']),head)
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        if path=='/api/gpu/status':
            try:
                import gpu_control
                return self.json(gpu_control.status(),head)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/report-jobs/([a-f0-9]{24})',path)
        if match:
            try:
                import report_jobs
                return self.json({'job':report_jobs.status(match[1])},head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/reports',path)
        if match:
            try:
                import report_versions
                return self.json(report_versions.listing(match[1]),head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/case-report/([a-z0-9-]+)/([a-f0-9]{24})\.(pdf|json)',path)
        if match:
            try:
                import report_versions
                reconstruction_file=report_versions.file(*match.groups())
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        if path=='/api/referees':
            import referee_roster
            return self.json({'catalogue':referee_roster.CATALOGUE},head)
        match=re.fullmatch(r'/api/(intake|matches)/([a-z0-9-]+)/referees',path)
        if match:
            try:
                import referee_roster
                return self.json(referee_roster.view(*match.groups()),head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        intake_sequence=re.fullmatch(r'/api/intake/([a-f0-9]{24})/sequence/(review-\d+)',path)
        case_sequence=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/sequence',path)
        if intake_sequence or case_sequence:
            try:
                import sequence_sync
                result=sequence_sync.view(*intake_sequence.groups()) if intake_sequence else sequence_sync.for_case(*case_sequence.groups())
                return self.json(result,head)
            except (ValueError,KeyError,OSError,RuntimeError,StopIteration) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/intake/([a-f0-9]{24})/wide/(review-\d+)(?:/(info|media)/([a-z0-9-]+)(\.mp4)?)?',path)
        if match:
            try:
                import wide_pairing,review_intake
                key,eid,action,sid,_=match.groups()
                if action=='media':reconstruction_file=wide_pairing.file(key,eid,sid)
                else:return self.json(wide_pairing.info(review_intake.load(key),eid,sid) if action=='info' else wide_pairing.view(key,eid),head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,400)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/wide-reference(\.jpg)?',path)
        if match:
            try:
                import wide_reference
                if not match[3]:return self.json(wide_reference.view(match[1],match[2]),head)
                reconstruction_file=wide_reference.image_file(match[1],match[2])
            except (ValueError,KeyError,OSError,RuntimeError,StopIteration) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/wide-source/([a-z0-9-]+)\.mp4',path)
        if match:
            try:
                import wide_reference
                reconstruction_file=wide_reference.source_file(*match.groups())
            except (ValueError,KeyError,OSError,RuntimeError,StopIteration):return self.send_error(404)
        match=re.fullmatch(r'/api/(cases|intake)/([a-z0-9-]+)/uniforms',path)
        if match:
            try:
                import uniforms
                return self.json(uniforms.load(*match.groups()),head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        if path in ('/api/library/matches','/api/library/fpc') or re.fullmatch(r'/api/library/matches/[a-z0-9-]+',path):
            try:
                import match_library
                return self.json(match_library.listing() if path=='/api/library/matches' else match_library.source_status() if path=='/api/library/fpc' else match_library.detail(path.rsplit('/',1)[-1]),head)
            except (ValueError,TypeError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
            except RuntimeError as e:return self.json({'error':str(e)},head,503)
        match=re.fullmatch(r'/api/library/matches/([a-z0-9-]+)/wide',path)
        if match:
            try:
                import match_library,wide_preparation
                row=match_library.get(match[1]);mid=row.get('fpcMatchId')
                return self.json(wide_preparation.public(mid) if mid else {'state':'unlinked','message':'FPC 경기를 연결하면 광각 녹화를 미리 준비할 수 있습니다.','recordings':[]},head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/review-flow',path)
        if match:
            try:
                import review_flow
                return self.json(review_flow.status(match[1]),head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/objects',path)
        if match:
            try:
                import broadcast_objects
                return self.json(broadcast_objects.view(*match.groups()),head)
            except (ValueError,KeyError,OSError,RuntimeError,StopIteration) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/case-wide-assist/([a-z0-9-]+)/(review-\d+)/(\d+)/([a-f0-9]{16})\.jpg',path)
        if match:
            try:
                import multiview
                reconstruction_file=multiview.image_file(match[1],match[2],int(match[3]),match[4])
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,404)
        match=re.fullmatch(r'/case-object-frame/([a-z0-9-]+)/(review-\d+)/(\d+)\.jpg',path)
        if match:
            try:
                import broadcast_objects
                reconstruction_file=broadcast_objects.image_file(match[1],match[2],int(match[3]))
            except (ValueError,KeyError,OSError,RuntimeError,StopIteration) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/intake',path)
        if match:
            try:
                import review_intake
                return self.json(review_intake.latest(match[1]),head)
            except (ValueError,KeyError,OSError) as e:return self.json({'error':str(e)},head,400)
        match=re.fullmatch(r'/api/intake/([a-f0-9]{24})',path)
        if match:
            try:
                import review_intake
                return self.json(review_intake.public(review_intake.load(match[1])),head)
            except (OSError,ValueError):return self.send_error(404)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/report-editorial',path)
        if match:
            try:
                import report_inputs
                return self.json(report_inputs.view(match[1]),head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
            except Exception:return self.report_error(head)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/report-referee-([123]).jpg',path)
        if match:
            try:
                import report_inputs
                image=report_inputs.referee_file(match[1],match[2],int(match[3])).read_bytes()
                self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(image)));self.end_headers()
                if not head:self.wfile.write(image)
                return
            except (ValueError,KeyError,IndexError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
            except Exception:return self.report_error(head)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/report-map.jpg',path)
        if match:
            try:
                import report_inputs
                image=report_inputs.map_file(*match.groups()).read_bytes()
                self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(image)));self.end_headers()
                if not head:self.wfile.write(image)
                return
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
            except Exception:return self.report_error(head)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/pose',path)
        if match:
            try:
                import broadcast_pose
                return self.json({'pose':broadcast_pose.current(*match.groups())},head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/pose-variants/([a-f0-9]{24})',path)
        if match:
            try:
                import pose_variant,broadcast_reconstruction,broadcast_pose
                key,event,variant=match.groups();scene=broadcast_reconstruction.current(key,event,strict=True)
                base=broadcast_pose.validate_pose(key,event,scene['poseJobId'],scene['state']['entities'])
                pose,_,meta=pose_variant.load(key,event,variant,scene['state'],base)
                return self.json({'pose':pose,'selectedCount':len(meta['selected'])},head)
            except (ValueError,KeyError,OSError,RuntimeError,TypeError) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/pose-export',path)
        if match:
            try:
                import broadcast_pose
                return self.json(broadcast_pose.export(match[1]),head)
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/reconstruction',path)
        if match:
            try:
                import broadcast_reconstruction
                return self.json({'saved':broadcast_reconstruction.current(*match.groups())},head)
            except (ValueError,KeyError,StopIteration):return self.send_error(404)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/case-reconstruction/([a-z0-9-]+)/(review-\d+)/(map|overview|eye|crewMap|eye1|eye2|eye3)\.jpg',path)
        if match:
            try:
                import broadcast_reconstruction
                reconstruction_file=broadcast_reconstruction.image_file(*match.groups())
            except (ValueError,KeyError,StopIteration):return self.send_error(404)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/broadcast-tracking',path)
        if match:
            try:return self.json(case_store.broadcast_packet(*match.groups()),head)
            except (ValueError,FileNotFoundError):return self.send_error(404)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)/events/(review-\d+)/tracking',path)
        if match:
            try:return self.json(case_store.tracking_packet(*match.groups()),head)
            except (ValueError,FileNotFoundError):return self.send_error(404)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        match=re.fullmatch(r'/api/cases/([a-z0-9-]+)',path)
        if match:
            try:return self.json(case_store.load_case(match[1]),head)
            except (ValueError,FileNotFoundError):return self.send_error(404)
        if path.startswith('/api/pose-jobs/'):
            try:return self.json(pose_jobs.status(path.removeprefix('/api/pose-jobs/')),head)
            except ValueError as e:return self.json({'error':str(e)},head,404)
        if path.startswith("/api/jobs/"):
            key=path.removeprefix("/api/jobs/")
            if key not in CLIPS:return self.send_error(404)
            return self.json(jobs.status(key),head)
        if path=="/api/clips":
            clips=[]
            for key,c in CLIPS.items():
                roster=next(g["referees"] for g in ROSTERS["games"] if g["match_id"]==c["match_id"])
                clips.append({k:c[k] for k in ("id","city","game","date","clip_number","source_start_hms","source_start_seconds","source_percent","scene_note","fps","width","height","file_duration_seconds")}|
                    {"media":f"/media/{key}.mp4","poster":f"/posters/{key}.jpg","roster":roster,"tracked":(ANALYSIS/key/"tracks.json").exists()})
            return self.json(clips,head)
        if path.startswith("/api/scene/"):
            key=path.removeprefix("/api/scene/")
            if key not in CLIPS:return self.send_error(404)
            source=parse_qs(urlparse(self.path).query).get("source",["auto"])[0]
            if source not in ("auto","legacy","basketball","nas"):return self.send_error(400)
            return self.json(scene(key,source),head)
        if reconstruction_file is not None or path.startswith(('/case-reconstruction/','/case-object-frame/')):
            if reconstruction_file is None:return self.send_error(404)
            file=reconstruction_file
        elif path.startswith('/wide-source/'):
            match=re.fullmatch(r'/wide-source/([a-f0-9-]{36})/([a-f0-9-]{36})/(\d+)\.mp4',path)
            if not match:return self.send_error(404)
            try:
                import wide_preparation
                file=wide_preparation.media_file(match[1],match[2],int(match[3]))
            except (ValueError,OSError):return self.send_error(404)
        elif path.startswith('/case-review-video/'):
            match=re.fullmatch(r'/case-review-video/([a-z0-9-]+)/(review-\d+)/([a-f0-9]{24})\.mp4',path)
            if not match:return self.send_error(404)
            try:
                import review_videos
                file=review_videos.file(*match.groups())
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
            except (OSError,ValueError,KeyError,StopIteration):return self.send_error(404)
        elif path.startswith('/case-review-package/'):
            match=re.fullmatch(r'/case-review-package/([a-z0-9-]+)/([a-f0-9]{24})\.zip',path)
            if not match or match[1] not in case_store.CASES:return self.send_error(404)
            try:
                import report_bundle
                file=report_bundle.bundle_file(*match.groups())
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
            except (OSError,ValueError,KeyError):return self.send_error(404)
        elif path.startswith('/case-report/'):
            match=re.fullmatch(r'/case-report/([a-z0-9-]+)\.(pdf|json)',path)
            if not match:return self.send_error(404)
            try:
                import report_versions
                file=report_versions.latest_file(*match.groups())
            except (ValueError,KeyError,OSError,RuntimeError) as e:return self.json({'error':str(e)},head,409)
        elif path.startswith(('/case-overlays/','/case-maps/')):
            match=re.fullmatch(r'/case-(overlays|maps)/([a-z0-9-]+)/(review-\d+)/(\d{6})\.png',path)
            if not match:return self.send_error(404)
            try:
                kind,key,event_id,frame=match.groups()
                file=case_store.broadcast_overlay(key,event_id,int(frame),kind)
            except (ValueError,FileNotFoundError):return self.send_error(404)
            except RuntimeError as e:return self.json({'error':str(e)},head,409)
        elif path.startswith('/intake-assets/'):
            match=re.fullmatch(r'/intake-assets/([a-f0-9]{24})/(\d+)\.mp4',path)
            if not match:return self.send_error(404)
            try:
                import review_intake
                file=review_intake.media_path(*match.groups())
            except (OSError,ValueError,StopIteration):return self.send_error(404)
        elif path.startswith('/case-assets/'):
            match=re.fullmatch(r'/case-assets/([a-z0-9-]+)/(wide|broadcast)/([a-zA-Z0-9_.-]+)',path)
            if not match:return self.send_error(404)
            try:file=case_store.media_file(*match.groups())
            except ValueError:return self.send_error(404)
        elif path.startswith('/case-pose-variant/'):
            match=re.fullmatch(r'/case-pose-variant/([a-z0-9-]+)/(review-\d+)/([a-f0-9]{24})\.json',path)
            if not match:return self.send_error(404)
            try:
                import pose_variant,broadcast_reconstruction,broadcast_pose
                key,event,variant=match.groups();scene=broadcast_reconstruction.current(key,event,strict=True)
                base=broadcast_pose.validate_pose(key,event,scene['poseJobId'],scene['state']['entities'])
                pose_variant.load(key,event,variant,scene['state'],base)
                file=pose_variant.folder(key,event,variant)/'meshes.json'
            except (ValueError,KeyError,OSError,RuntimeError,TypeError):return self.send_error(404)
        elif path.startswith('/pose-assets/'):
            match=re.fullmatch(r'/pose-assets/([a-f0-9]{24})/(frame.jpg|meshes.json)',path)
            if not match:return self.send_error(404)
            file=pose_jobs.folder(match[1])/match[2]
        elif path.startswith("/reports/"):
            name=path.removeprefix("/reports/")
            if not re.fullmatch(r"[a-f0-9]{24}\.(pdf|json)",name):return self.send_error(404)
            file=REPORTS/name
        elif path.startswith("/media/"):
            key=path.removeprefix("/media/").removesuffix(".mp4")
            if key not in CLIPS:return self.send_error(404)
            file=MEDIA/CLIPS[key]["file"]
        else:
            relative=path.lstrip("/") or "index.html"
            file=(APP/relative).resolve()
            if not file.is_relative_to(APP.resolve()) or not file.is_file():return self.send_error(404)
        if not file.is_file():return self.send_error(404)
        size=file.stat().st_size;start=0;end=size-1;partial=False
        request=self.headers.get("Range")
        if request:
            match=re.fullmatch(r"bytes=(\d*)-(\d*)",request)
            if not match or not any(match.groups()):return self.send_error(416)
            if match[1]:
                start=int(match[1]);end=min(int(match[2]) if match[2] else end,end)
            else:start=max(0,size-int(match[2]))
            if start>end or start>=size:
                self.send_response(416);self.send_header("Content-Range",f"bytes */{size}");self.end_headers();return
            partial=True
        self.send_response(206 if partial else 200)
        content_type=mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix==".mjs":content_type="text/javascript"
        self.send_header("Content-Type",content_type);self.send_header("Accept-Ranges","bytes")
        if path.startswith(("/reports/","/case-report/","/case-review-package/","/case-review-video/")):
            disposition=f'attachment; filename="{file.name}"'
            report_match=re.fullmatch(r'/case-report/([a-z0-9-]+)(?:/[a-f0-9]{24})?\.pdf',path)
            if report_match:
                try:
                    name=report_filename(case_store.load_case(report_match[1]))
                    disposition=f"attachment; filename=\"kbl-review-report.pdf\"; filename*=UTF-8''{quote(name,safe='')}"
                except (ValueError,KeyError,OSError,RuntimeError):pass
            video_match=re.fullmatch(r'/case-review-video/([a-z0-9-]+)/(review-\d+)/([a-f0-9]{24})\.mp4',path)
            if video_match:
                try:
                    import video_delivery
                    case=case_store.load_case(video_match[1]);event=next(e for e in case['events'] if e['id']==video_match[2])
                    import review_videos
                    meta,_=review_videos.inspect(*video_match.groups())
                    name=video_delivery.video_filename(case,event,meta)
                    disposition=f"attachment; filename=\"kbl-review-video.mp4\"; filename*=UTF-8''{quote(name,safe='')}"
                except (ValueError,KeyError,OSError,RuntimeError,StopIteration):pass
            self.send_header("Content-Disposition",disposition)
        self.send_header("Content-Length",str(end-start+1));self.send_header("Cache-Control","no-cache")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Cross-Origin-Resource-Policy","same-origin")
        if partial:self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:return
        try:
            with file.open("rb") as f:
                f.seek(start);remaining=end-start+1
                while remaining:
                    chunk=f.read(min(1024*1024,remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,fmt,*args):
        if args and str(args[1]) not in ("200","206","304"):super().log_message(fmt,*args)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--port",type=int,default=4350);args=parser.parse_args()
    import cv2
    cv2.setNumThreads(1)
    server=ThreadingHTTPServer(("127.0.0.1",args.port),Handler)
    print(f"KBL referee workbench: http://127.0.0.1:{args.port}",flush=True)
    server.serve_forever()
