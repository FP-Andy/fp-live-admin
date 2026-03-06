import os
import re
import subprocess
import shutil
from typing import Literal
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Gateway Manager")

HLS_BASE = os.getenv("GATEWAY_PUBLIC_HLS_BASE", "http://localhost:8080").rstrip("/")
RTMP_SERVER = os.getenv("GATEWAY_PUBLIC_RTMP_SERVER", "rtmp://localhost:1935/live").rstrip("/")
RTMP_PULL_BASE = os.getenv("GATEWAY_RTMP_PULL_BASE", "rtmp://gateway-rtmp/live").rstrip("/")
SCRIPTS_DIR = Path("/scripts")
HLS_DIR = Path("/srv/hls")


class StartMatchRequest(BaseModel):
    match_id: str
    source_url: str | None = None
    ingest_protocol: Literal["SRT", "RTMP"] | None = None
    srt_url: str | None = None  # Backward compatibility.


def _validate_match_id(match_id: str) -> None:
    if not re.match(r"^[a-zA-Z0-9_-]+$", match_id):
        raise HTTPException(status_code=400, detail="invalid match_id")


def _run_script(name: str, *args: str) -> str:
    script = SCRIPTS_DIR / name
    if not script.exists():
        raise HTTPException(status_code=500, detail=f"script missing: {name}")

    proc = subprocess.run([str(script), *args], capture_output=True, text=True)
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=output.strip() or f"script failed: {name}")
    return output.strip()


def _rtmp_info(match_id: str) -> dict:
    stream_key = match_id
    return {
        "server_url": RTMP_SERVER,
        "stream_key": stream_key,
        "push_url": f"{RTMP_SERVER}/{stream_key}",
        "pull_url": f"{RTMP_PULL_BASE}/{stream_key}",
    }


def _resolve_source(match_id: str, body: StartMatchRequest) -> tuple[str, str, dict | None]:
    source_url = (body.source_url or body.srt_url or "").strip()
    protocol = (body.ingest_protocol or "").upper()

    if not protocol:
        if source_url.startswith("rtmp://"):
            protocol = "RTMP"
        elif source_url.startswith("srt://"):
            protocol = "SRT"
        elif source_url:
            protocol = "SRT"
        else:
            raise HTTPException(status_code=400, detail="source_url or ingest_protocol is required")

    if protocol not in ("SRT", "RTMP"):
        raise HTTPException(status_code=400, detail="ingest_protocol must be SRT or RTMP")

    if protocol == "RTMP":
        info = _rtmp_info(match_id)
        if not source_url:
            source_url = info["pull_url"]
        return source_url, protocol, info

    if not source_url:
        raise HTTPException(status_code=400, detail="SRT ingest requires source_url")
    return source_url, protocol, None


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/matches/start")
def start_match(body: StartMatchRequest):
    _validate_match_id(body.match_id)
    source_url, ingest_protocol, rtmp = _resolve_source(body.match_id, body)
    _run_script("start_match.sh", body.match_id, source_url)
    return {
        "ok": True,
        "match_id": body.match_id,
        "ingest_protocol": ingest_protocol,
        "source_url": source_url,
        "hls_url": f"{HLS_BASE}/hls/{body.match_id}/stream.m3u8",
        "rtmp": rtmp,
    }


@app.get("/matches/{match_id}/rtmp-info")
def rtmp_info(match_id: str):
    _validate_match_id(match_id)
    info = _rtmp_info(match_id)
    return {"ok": True, "match_id": match_id, **info}


@app.post("/matches/{match_id}/stop")
def stop_match(match_id: str):
    _validate_match_id(match_id)
    out = _run_script("stop_match.sh", match_id)
    return {"ok": True, "match_id": match_id, "message": out}


@app.post("/matches/{match_id}/clear")
def clear_match(match_id: str):
    _validate_match_id(match_id)
    _run_script("stop_match.sh", match_id)
    target = HLS_DIR / match_id
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    return {"ok": True, "match_id": match_id, "message": "cleared"}


@app.get("/matches/status")
def status():
    out = _run_script("status.sh")
    lines = [line for line in out.splitlines() if line.strip()]
    return {"ok": True, "lines": lines}
