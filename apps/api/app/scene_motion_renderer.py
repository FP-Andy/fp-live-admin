"""Encode the console's own React view through the private web renderer."""
import os
from pathlib import Path
import time

import httpx

SCENE_RENDER_VERSION = 'fpc-native-v1'


def render_scene_data(data: dict, output: Path) -> None:
    token = os.getenv('SCENE_MOTION_RENDER_TOKEN', '').strip()
    if not token:
        raise RuntimeError('Scene renderer token is not configured')
    url = os.getenv('SCENE_MOTION_RENDER_URL', 'http://web:3000/api/internal/scene-motion-render')
    deadline = time.monotonic() + 180
    partial = output.with_suffix('.partial')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with httpx.Client(timeout=170, trust_env=False) as client:
            while True:
                with client.stream('POST', url, headers={'x-scene-render-token': token},
                                   json={'version': SCENE_RENDER_VERSION, 'sceneData': data}) as response:
                    if response.status_code == 429 and time.monotonic() < deadline:
                        time.sleep(3)
                        continue
                    response.raise_for_status()
                    if (response.headers.get('x-scene-renderer') != SCENE_RENDER_VERSION
                            or response.headers.get('content-type', '').split(';')[0] != 'video/mp4'):
                        raise RuntimeError('Unexpected scene renderer response')
                    size = 0
                    with partial.open('wb') as target:
                        for chunk in response.iter_bytes():
                            size += len(chunk)
                            if size > 32 * 1024 * 1024:
                                raise RuntimeError('Scene MP4 exceeds size limit')
                            target.write(chunk)
                    with partial.open('rb') as source:
                        if b'ftyp' not in source.read(32):
                            raise RuntimeError('Scene renderer did not return an MP4')
                    partial.replace(output)
                    return
    finally:
        partial.unlink(missing_ok=True)
