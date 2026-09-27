#!/usr/bin/env python3
"""Offline YOLO26 person tracking. No video leaves this machine.

Writes normalized boxes at absolute source-video times and a browser H.264
preview. Track IDs belong to this one run; they are not player identities.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import time
import uuid


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, default=Path("runtime/fpa-cv/demo"))
    parser.add_argument("--model", default="yolo26s.pt")
    parser.add_argument("--tracker", default="bytetrack.yaml", help="Ultralytics tracker YAML or local config path")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float, default=30, help="Seconds; 0 = remaining video")
    parser.add_argument("--sample-fps", type=float, default=10)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--conf", type=float, default=0.20)
    parser.add_argument("--device", default="auto", help="auto (MPS/CUDA/CPU), cpu, mps, or CUDA device index")
    parser.add_argument("--progress-json", action="store_true", help="Emit structured progress for the local job queue")
    parser.add_argument("--anchor-frame", type=int, help="Include the operator calibration frame exactly")
    parser.add_argument("--initial-setup", type=Path, help="Server-validated initial detections and operator exclusions")
    parser.add_argument("--video-name", help="Original uploaded filename for review metadata")
    parser.add_argument("--uniforms", type=Path, help="Review JSON exported after eyedropper setup, or five-group RGB palette JSON; enables ByteTrack team constraints")
    parser.add_argument("--preview-width", type=int, default=1920)
    parser.add_argument("--preview-encoder", choices=('auto', 'cpu', 'gpu'), default='auto', help="GPU preview encoding when available; does not alter frames used for detection")
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--threaded-colors", action="store_true", help="Use the in-process color stage instead of a separate CPU process")
    parser.add_argument("--serial", action="store_true", help="Disable CUDA pipeline overlap for diagnosis and output parity checks")
    parser.add_argument("--roi", help="Fixed-camera court polygon, normalized x,y;x,y;... (box centers)")
    parser.add_argument("--roi-margin", type=float, default=.08, help="Keep a touchline buffer outside ROI, in video-height units (default .08; 0 = strict court)")
    args = parser.parse_args()
    if args.initial_setup and (not args.uniforms or args.anchor_frame is None or not args.initial_setup.is_file()):
        parser.error('--initial-setup requires a saved setup, --uniforms and --anchor-frame')
    if not args.video.is_file():
        parser.error("Video does not exist")
    if not all(math.isfinite(n) for n in [args.start, args.duration, args.sample_fps, args.conf, args.roi_margin]) or args.start < 0 or args.duration < 0 or args.sample_fps <= 0 or not 0 < args.conf < 1 or not 0 <= args.roi_margin <= .3 or args.imgsz < 32 or args.preview_width < 32:
        parser.error("Invalid start/duration/fps/conf/image size")
    if (args.output / "tracks.json").exists() or (args.output / "preview.mp4").exists():
        parser.error("Output already contains a run. Choose a new directory to preserve reviews.")
    return args


def select_device(requested):
    if requested != 'auto':
        return requested
    import torch
    return 'mps' if torch.backends.mps.is_available() else '0' if torch.cuda.is_available() else 'cpu'


def frame_at_or_after(seconds, fps):
    """Do not skip an exact source frame due to time/fps round-trip noise."""
    frame=seconds*fps
    nearest=round(frame)
    return nearest if math.isclose(frame,nearest,rel_tol=0,abs_tol=1e-7) else math.ceil(frame)


def tracking_frame_count(first, last, stride, anchor_frame=None):
    """Count inference frames, including an extra off-stride calibration frame."""
    total = len(range(first, last, stride))
    if anchor_frame is not None and first <= anchor_frame < last and (anchor_frame-first) % stride:
        total += 1
    return total


def frame_progress(processed, total, elapsed):
    """Estimate remaining tracking time from this run's cumulative throughput."""
    remaining = max(0, total-processed)
    measured = processed > 0 and elapsed > 0
    return {'processedFrames': processed, 'totalFrames': total, 'remainingFrames': remaining,
            'elapsed': elapsed, 'processingFps': processed/elapsed if measured else None,
            'eta': elapsed/processed*remaining if measured else None}


def roi_zone(box, roi, aspect, margin):
    """Retain nearby out-of-court detections without calling them players."""
    if roi is None:
        return "court"
    import cv2
    import numpy as np
    x1,y1,x2,y2=box
    contour=np.asarray(roi,dtype=np.float32)*np.array([aspect,1],dtype=np.float32)
    distance=cv2.pointPolygonTest(contour,((x1+x2)/2*aspect,(y1+y2)/2),True)
    return "court" if distance>=-1e-7 else "touchline" if distance>=-margin else None


def main():
    args = arguments()
    def progress(stage, percent, **extra):
        if args.progress_json:
            print('FPA_PROGRESS ' + json.dumps({'stage':stage, 'progress':percent, **extra}), flush=True)
    progress('영상·모델 준비', 0)
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(args.output.resolve() / "config"))
    import cv2
    import numpy as np
    import ultralytics
    from ultralytics import YOLO
    from fpa_cv_colors import appearance
    from fpa_cv_uniforms import load_uniforms, classify_uniform, uniform_team
    from fpa_cv_duplicates import suppress_new_duplicates
    from fpa_cv_pipeline import OrderedPipeline

    device = select_device(args.device)
    # Keep the existing CPU/MPS execution path until separately benchmarked.
    use_pipeline = not args.serial and device not in ('cpu', 'mps')
    uniforms = load_uniforms(args.uniforms) if args.uniforms else None
    initial_setup=json.loads(args.initial_setup.read_text()) if args.initial_setup else None
    tracker = None
    if uniforms:
        from types import SimpleNamespace
        from ultralytics.utils import YAML
        from ultralytics.utils.checks import check_yaml
        from fpa_cv_bytetrack import ColorBYTETracker
        config = YAML.load(check_yaml(args.tracker))
        if config.get('tracker_type') != 'bytetrack':
            raise SystemExit('--uniforms supports the existing ByteTrack tracker only')
        # Upstream model.track also initializes BYTETracker(frame_rate=30).
        # Retain the exact YAML buffer in sampled update counts for parity.
        tracker = ColorBYTETracker(SimpleNamespace(**config), frame_rate=30, observation_fps=args.sample_fps)

    roi = None
    if args.roi:
        try:
            roi = np.array([list(map(float, pair.split(","))) for pair in args.roi.split(";")], dtype=np.float32)
            if roi.shape[0] < 3 or roi.shape[1] != 2 or not np.isfinite(roi).all() or (roi < 0).any() or (roi > 1).any():
                raise ValueError()
        except (ValueError, IndexError):
            raise SystemExit("ROI must contain at least three normalized x,y pairs")

    cap = cv2.VideoCapture(str(args.video))
    fps, count = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not cap.isOpened() or fps <= 0 or count <= 0 or width <= 0 or height <= 0:
        raise SystemExit("Cannot read video metadata")
    first = frame_at_or_after(args.start, fps)
    last = min(count, frame_at_or_after(args.start + args.duration, fps)) if args.duration else count
    if first >= last:
        raise SystemExit("Start must be before end of video")
    if args.anchor_frame is not None and not first <= args.anchor_frame < last:
        raise SystemExit("Initial setup frame must be inside the analysis range")
    if initial_setup and (initial_setup['frameIndex']!=first or args.anchor_frame!=first):
        raise SystemExit('Reviewed initial detections must be the first tracking frame')
    stride = max(1, round(fps / args.sample_fps))
    if tracker is not None:
        tracker.confirm_frames=max(3,round(fps/stride*.6))
    total_frames = tracking_frame_count(first, last, stride, args.anchor_frame)
    print(f'Device: {device} | model: {args.model} | team constraints: {bool(uniforms)}', flush=True)
    progress('모델 불러오는 중', 1, **frame_progress(0, total_frames, 0))
    model = YOLO(args.model)
    preview = None
    pw = min(width, args.preview_width) // 2 * 2
    ph = round(height * pw / width / 2) * 2
    if not args.no_preview:
        from fpa_cv_preview import PreviewWriter
        preview = PreviewWriter(args.output / 'preview.mp4', fps, (pw, ph),
                                encoder=args.preview_encoder,
                                device=device.removeprefix('cuda:') if device not in ('cpu', 'mps') else None)
        print(f'Preview encoder: {preview.encoder}', flush=True)
        if preview.fallback_reason:
            print(f'GPU preview unavailable; using CPU: {preview.fallback_reason}', flush=True)
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)
    appearance_worker = None
    if tracker is not None and use_pipeline and not args.threaded_colors:
        from fpa_cv_appearance_worker import AppearanceWorker
        try:
            appearance_worker = AppearanceWorker((height, width, 3), uniforms)
        except OSError as error:
            print(f'Appearance worker unavailable; using in-process colors: {error}', flush=True)
        except BaseException:
            cap.release()
            if preview:
                preview.abort()
            raise
    frames, summaries = [], {}
    started = time.monotonic()
    processed = 0
    last_progress = 0.0
    suppressed_count=0
    seed_tracks=set()
    progress('선수 추적 중', 2, **frame_progress(0, total_frames, 0))
    def source_frames():
        # One owner for capture and preview; keep every source frame in the
        # preview, but prefetch only sampled/anchor frames for inference.
        for frame_index in range(first, last):
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError(f"Decode failed at frame {frame_index}; incomplete run has not been published")
            if preview:
                preview.write(cv2.resize(frame, (pw, ph)))
            if (frame_index-first) % stride == 0 or frame_index == args.anchor_frame:
                yield {'index': frame_index, 'frame': frame}

    def detect(packet):
        frame_index, frame = packet['index'], packet['frame']
        original_scores = manual_teams = None
        if initial_setup and frame_index == first:
            from ultralytics.engine.results import Boxes
            from fpa_cv_initial import initial_detections
            rows, original_scores, manual_teams = initial_detections(initial_setup, width, height, max(config['new_track_thresh'], config['track_high_thresh']))
            detections = Boxes(np.asarray(rows, dtype=np.float32).reshape(-1, 6), (height, width))
        else:
            result = model.predict(frame, classes=[0], imgsz=args.imgsz, conf=args.conf,
                                   device=device, verbose=False)[0]
            detections = result.boxes.cpu().numpy()
        packet.update(detections=detections, original_scores=original_scores, manual_teams=manual_teams)
        return packet

    def describe(packet):
        if appearance_worker:
            descriptors, classifications = appearance_worker.describe(packet['frame'], packet['detections'].xyxyn)
        else:
            descriptors = [appearance(packet['frame'], box) for box in packet['detections'].xyxyn]
            classifications = [classify_uniform(a, uniforms) for a in descriptors]
        packet.update(descriptors=descriptors, classifications=classifications)
        return packet

    # A single inference owner and FIFO queues preserve the exact sequence.
    # Tracker-dependent duplicate rejection and all identity updates stay here.
    stages = [('detect', detect), ('describe', describe)] if tracker is not None else []
    pipeline = OrderedPipeline(source_frames(), stages, capacity=2, threaded=use_pipeline)
    tracking_seconds = 0.0
    try:
        with pipeline:
            for packet in pipeline:
                work_started = time.monotonic()
                frame_index, frame = packet['index'], packet['frame']
                t = round(frame_index / fps, 6)
                if tracker is not None:
                    detections = packet['detections']
                    original_scores, manual_teams = packet['original_scores'], packet['manual_teams']
                    descriptors, classifications = packet['descriptors'], packet['classifications']
                    if original_scores is None:
                        established=[old.xyxy for old in tracker.tracked_stracks if old.is_activated and (old.tracklet_len>=3 or old.track_id in seed_tracks)]
                        keep,reasons=suppress_new_duplicates(detections,descriptors,classifications,established)
                        suppressed_count+=len(reasons)
                        detections=detections[keep]
                        descriptors=[descriptors[i] for i in keep]
                        classifications=[classifications[i] for i in keep]
                    teams = [uniform_team(result) for result in classifications]
                    if manual_teams is not None:
                        teams=[manual if manual is not None else observed for manual,observed in zip(manual_teams,teams)]
                    output = tracker.update(detections, teams=teams)
                    if manual_teams is not None:
                        seed_teams={int(row[4]):manual_teams[int(row[7])] for row in output if manual_teams[int(row[7])] is not None}
                        seed_tracks=set(seed_teams)
                        tracker.seed_teams(seed_teams)
                    observations = [(int(row[4]), row[:4]/np.array([width,height,width,height]), float(original_scores[int(row[7])] if original_scores is not None else row[5])) for row in output]
                else:
                    result = model.track(frame, persist=True, tracker=args.tracker, classes=[0],
                                         imgsz=args.imgsz, conf=args.conf, device=device, verbose=False)[0]
                    observations = [] if result.boxes is None or result.boxes.id is None else zip(result.boxes.id.int().cpu().tolist(), result.boxes.xyxyn.cpu().tolist(), result.boxes.conf.cpu().tolist())
                boxes = []
                if observations:
                    for track, xyxy, confidence in observations:
                        x1, y1, x2, y2 = [max(0.0, min(1.0, n)) for n in xyxy]
                        zone=roi_zone((x1,y1,x2,y2),roi,width/height,args.roi_margin)
                        if zone is None:
                            continue
                        normalized = [round(n, 6) for n in (x1, y1, x2, y2)]
                        boxes.append({"id": track, "box": normalized, "confidence": round(confidence, 4), "appearance": appearance(frame, normalized), "zone":zone})
                        if track not in summaries:
                            summaries[track] = {"id": track, "first": t, "last": t, "samples": 0}
                        summaries[track]["last"] = t
                        summaries[track]["samples"] += 1
                frames.append({"t": t, "boxes": boxes})
                processed += 1
                tracking_seconds += time.monotonic()-work_started
                now = time.monotonic()
                if processed == 1 or processed == total_frames or now-last_progress >= 1:
                    progress('선수 추적 중', 2+processed/total_frames*94, sourceTime=t,
                             **frame_progress(processed, total_frames, now-started),
                             samples=processed, trackCount=len(summaries))
                    last_progress = now
                if processed == 1 or processed % 50 == 0:
                    print(f"{(frame_index-first+1)/(last-first)*100:5.1f}% | source {t:.2f}s | {len(boxes)} people | {len(summaries)} tracks | {time.monotonic()-started:.1f}s elapsed", flush=True)
    except BaseException:
        if preview:
            preview.abort()
        raise
    finally:
        if appearance_worker:
            appearance_worker.close()
        cap.release()
    print('Pipeline timings: ' + json.dumps({'threaded': use_pipeline, 'colorProcess': appearance_worker is not None, 'stages': pipeline.stats, 'trackingSeconds': tracking_seconds}), flush=True)
    if preview:
        progress('미리보기 영상 저장 중', 97, eta=None)
        preview.release()
    stats = frame_progress(processed, total_frames, time.monotonic()-started)
    # Frame throughput cannot estimate final file writes; do not retain an old ETA.
    progress('결과 저장 중', 98, **{**stats, 'eta': None}, samples=processed, trackCount=len(summaries))
    # Source fingerprint is separate from run UUID; a retrack must not inherit old IDs.
    stat = args.video.stat()
    with args.video.open("rb") as source:
        digest = hashlib.sha256(source.read(1024 * 1024))
        source.seek(max(0, stat.st_size - 1024 * 1024))
        digest.update(source.read(1024 * 1024))
    payload = {
        "schema": "fpa-tracks/v1", "datasetId": str(uuid.uuid4()),
        "video": {"name": args.video_name or args.video.name, "sizeBytes": stat.st_size, "fingerprint": digest.hexdigest(),
                  "fps": fps, "width": width, "height": height, "duration": count / fps,
                  "clipStart": first / fps, "clipEnd": last / fps,
                  "preview": "preview.mp4" if preview else None},
        "detector": {"model": Path(args.model).name, "ultralytics": ultralytics.__version__,
                     "appearance": "overhead-rgb12-local-background/v3",
                     "device": device,
                     "initialSetup": {"frameIndex":initial_setup['frameIndex'],"excludedDetectionIds":initial_setup.get('excludedDetectionIds',[]),"source":"operator-reviewed-frame"} if initial_setup else None,
                     "teamConstraint": {"enabled": bool(uniforms), "uniforms": uniforms,
                                        "stableObservations":3,"conflictSeconds":.6,"minimumMargin":.4,
                                        "stages":["high-confidence","low-confidence"]} if uniforms else {"enabled":False},
                     "tracker": Path(args.tracker).name, "imgsz": args.imgsz, "confidence": args.conf,
                     "trackerConfig": Path(args.tracker).read_text() if Path(args.tracker).is_file() else None,
                     "sampleFps": fps / stride, "roi": roi.tolist() if roi is not None else None,
                     "duplicateSuppression":{"version":"contained-newcomer/v1","suppressedObservations":suppressed_count},
                     "roiMargin":args.roi_margin if roi is not None else 0},
        "frames": frames, "tracks": list(summaries.values()),
    }
    temp = args.output / "tracks.json.tmp"
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(args.output / "tracks.json")
    progress("분석 완료", 100, **{**stats, 'eta': None}, samples=processed, trackCount=len(summaries))
    print(f"Done: {args.output / 'tracks.json'} | {len(frames)} samples, {len(summaries)} track fragments | {time.monotonic()-started:.1f}s", flush=True)


if __name__ == "__main__":
    import signal
    def cancel(signum, frame):
        # Job cancellation must close queues and the encoder instead of leaving
        # an FFmpeg process holding a partial preview open.
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM, cancel)
    main()
