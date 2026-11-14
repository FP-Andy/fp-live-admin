"""RF-DETR basketball inference with explicit CPU/CUDA execution."""
from pathlib import Path
import hashlib
import json
import time
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "runtime/kbl-cv/models/rfdetr_m_640.onnx"
SHA256 = "708789b50c42b5265cced64276a8beb1b7f294d324f954d359fd8a2d01f5a939"
SOURCE = "https://huggingface.co/ortizeg/basketball-rf-detr-m-640"
# This COCO export uses category IDs 1..10, unlike the tutorial's API IDs 0..9.
NAMES = ["background", "ball", "ball-in-basket", "number", "player",
         "player-in-possession", "player-jump-shot", "player-layup-dunk",
         "player-shot-block", "referee", "rim"]


def overlap(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    intersection = ix * iy
    area = lambda r: max(0, r[2]-r[0])*max(0, r[3]-r[1])
    return intersection / max(1e-6, area(a)+area(b)-intersection)


def category(d):
    return "player" if d["class"].startswith("player") else d["class"]


def suppress(detections, threshold=.5):
    """Merge overlapping crops and player action subclasses before tracking."""
    kept = []
    for d in sorted(detections, key=lambda x: -x["confidence"]):
        if not any(category(k) == category(d) and overlap(k["box"], d["box"]) > threshold for k in kept):
            kept.append(d)
    return kept


def decode(boxes, logits, width, height, offset=(0, 0), threshold=.15, names=None):
    names = NAMES if names is None else names
    if logits.shape[1] != len(names):
        raise ValueError("Model logits and class mapping disagree")
    probs = 1 / (1 + np.exp(-np.clip(logits, -50, 50)))
    flat = probs.ravel()
    best = np.argpartition(flat, -min(300, len(flat)))[-300:]
    result = []
    for idx in best[np.argsort(flat[best])[::-1]]:
        query, cls = divmod(int(idx), probs.shape[1])
        confidence = float(flat[idx])
        if confidence < threshold or names[cls] == "background":
            continue
        cx, cy, bw, bh = boxes[query]
        box = [float(np.clip(cx-bw/2, 0, 1)*width+offset[0]),
               float(np.clip(cy-bh/2, 0, 1)*height+offset[1]),
               float(np.clip(cx+bw/2, 0, 1)*width+offset[0]),
               float(np.clip(cy+bh/2, 0, 1)*height+offset[1])]
        if box[2] > box[0] and box[3] > box[1]:
            result.append({"box": box, "class": names[cls], "confidence": confidence})
    return result


class BasketballDetector:
    def __init__(self, threads=6, device="cpu", device_id=0, profile_dir=None, model_manifest=None):
        import onnxruntime as ort
        if device not in ("cpu", "cuda"):
            raise ValueError("device must be cpu or cuda")
        if threads < 1 or device_id < 0:
            raise ValueError("threads must be positive and device_id nonnegative")
        started = time.perf_counter()
        available = ort.get_available_providers()
        if device == "cuda" and "CUDAExecutionProvider" not in available:
            raise RuntimeError(f"CUDA was requested but is unavailable: {available}")
        model, expected_hash, self.names = MODEL, SHA256, NAMES
        manifest = {}
        if model_manifest:
            manifest_path = Path(model_manifest)
            manifest = json.loads(manifest_path.read_text())
            model = manifest_path.parent / manifest['onnxFile']
            expected_hash = manifest['sha256']
            self.names = manifest['names']
            if manifest['inputSize'] != [640, 640] or not self.names:
                raise ValueError('Only explicitly mapped 640x640 models are supported')
        if hashlib.sha256(model.read_bytes()).hexdigest() != expected_hash:
            raise ValueError("Basketball model checksum mismatch")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        if profile_dir:
            Path(profile_dir).mkdir(parents=True, exist_ok=True)
            options.enable_profiling = True
            options.profile_file_prefix = str(Path(profile_dir)/f"{device}-onnx")
        providers = ([("CUDAExecutionProvider", {"device_id": device_id, "use_tf32": 0}),
                      "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"])
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=providers)
        if device == "cuda" and "CUDAExecutionProvider" not in self.session.get_providers():
            raise RuntimeError("CUDA session initialization fell back to CPU")
        # Runtime EP errors must not silently turn a CUDA benchmark into CPU work.
        self.session.disable_fallback()
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].shape != [1, 3, 640, 640]:
            raise ValueError('Unexpected detector input shape')
        boxes = [o.name for o in outputs if o.shape[-1] == 4]
        logits = [o.name for o in outputs if o.shape[-1] == len(self.names)]
        if len(boxes) != 1 or len(logits) != 1 or boxes == logits:
            raise ValueError('Expected unambiguous boxes and logits outputs')
        self.input_name, self.output_names = inputs[0].name, [boxes[0], logits[0]]
        self.execution = {"requestedDevice": device, "deviceId": device_id,
                          "providers": self.session.get_providers(),
                          "providerOptions": self.session.get_provider_options(),
                          "ortVersion": ort.__version__, "threads": threads,
                          "modelSha256": expected_hash, "modelId": manifest.get('modelId', SOURCE),
                          "names": self.names, "precision": "FP32", "batchSize": 1,
                          "initializationSeconds": time.perf_counter()-started}
        self.timing = {"calls": 0, "preprocessSeconds": 0., "inferenceSeconds": 0., "decodeSeconds": 0.}
        self.mean = np.array([.485, .456, .406], np.float32)
        self.std = np.array([.229, .224, .225], np.float32)

    def predict(self, frame, offset=(0, 0), threshold=.15):
        started = time.perf_counter()
        h, w = frame.shape[:2]
        rgb = cv2.resize(frame, (640, 640))[:, :, ::-1].astype(np.float32)/255
        tensor = np.ascontiguousarray(((rgb-self.mean)/self.std).transpose(2, 0, 1)[None])
        prepared = time.perf_counter()
        # run() returns host arrays and waits for the GPU output copy to complete.
        boxes, logits = self.session.run(self.output_names, {self.input_name: tensor})
        inferred = time.perf_counter()
        result = decode(boxes[0], logits[0], w, h, offset, threshold, self.names)
        self.timing["calls"] += 1
        self.timing["preprocessSeconds"] += prepared-started
        self.timing["inferenceSeconds"] += inferred-prepared
        self.timing["decodeSeconds"] += time.perf_counter()-inferred
        return result

    def court(self, frame, anchors, tiles=True):
        """Search people and balls together, including balls overlapping bodies."""
        h, w = frame.shape[:2]
        top = max(0, int(min(p[1] for p in anchors))-220)
        bottom = min(h, int(max(p[1] for p in anchors))+35)
        found = self.predict(frame[top:bottom], (0, top))
        if tiles:
            # Preserve small-object pixels with overlapping local views.
            for left in (0, 560, 1120):
                right = min(w, left+800)
                found.extend(self.predict(frame[top:bottom, left:right], (left, top)))
        return suppress(found)


def deinterlace(frame):
    return cv2.resize(frame[::2], (frame.shape[1], frame.shape[0]))
