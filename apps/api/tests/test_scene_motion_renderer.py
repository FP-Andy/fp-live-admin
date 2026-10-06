"""Native scene export, render caching and immutable old-object contracts."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import scene_motion as motion
from app import scene_motion_renderer as renderer

SCENE = {'beforeDots': [{'id': '7', 'x': 20, 'y': 30, 'teamSide': 'home', 'number': '7'}],
         'afterDots': [{'id': '7', 'x': 55, 'y': 32, 'teamSide': 'home', 'number': '7'}]}


class Storage:
    configured = True
    def __init__(self): self.objects = {}; self.uploads = []
    def exists(self, key): return key in self.objects
    def upload(self, file, key, **kwargs):
        self.objects[key] = file.read_bytes(); self.uploads.append(key)


class SceneRendererTests(unittest.TestCase):
    def test_current_scene_data_and_assets_version_are_cached(self):
        actions = [{'seq': 1, 'action': 'Dribble', 'jersey': '7', 'teamSide': 'home', 'extra': {'sceneState': SCENE}}]
        payload = [{'seq': 1}]
        storage = Storage()
        motion.attach_scene_motions(actions, payload, clip_key='clip', storage=None, prefix='prefix')
        data = actions[0]['sceneData']
        key = motion.scene_motion_key('prefix', 'clip', 1, data)
        legacy = key.replace('/' + renderer.SCENE_RENDER_VERSION, '')
        storage.objects[legacy] = b'old artwork'
        calls = []
        def render(value, target): calls.append(value); target.write_bytes(b'native MP4')
        with patch.object(motion, 'render_scene_data', side_effect=render):
            for _ in range(2):
                self.assertEqual(motion.attach_scene_motions(actions, payload, clip_key='clip', storage=storage, prefix='prefix'), [])
        self.assertEqual(calls, [data])
        self.assertEqual(storage.uploads, [key])
        self.assertEqual(payload[0]['sceneMotionKey'], key)
        self.assertEqual(storage.objects[legacy], b'old artwork')
        self.assertNotEqual(key, motion.scene_motion_key('prefix', 'clip', 1, {**data, 'caption': 'edited'}))

    def test_failed_native_render_never_publishes_legacy_artwork(self):
        actions = [{'seq': 1, 'extra': {'sceneState': SCENE}}]
        storage = Storage()
        with patch.object(motion, 'render_scene_data', side_effect=RuntimeError('fixture failure')):
            errors = motion.attach_scene_motions(actions, None, clip_key='clip', storage=storage, prefix='prefix')
        self.assertEqual(len(errors), 1)
        self.assertFalse(storage.uploads)
        self.assertNotIn('sceneMotionKey', actions[0])
        self.assertTrue(actions[0]['sceneData'])

    def test_private_renderer_response_and_atomic_file(self):
        attempts = []
        def handle(request):
            attempts.append(request)
            self.assertEqual(request.headers['x-scene-render-token'], 'fixture-token')
            if len(attempts) == 1: return httpx.Response(429)
            return httpx.Response(200, headers={'x-scene-renderer': renderer.SCENE_RENDER_VERSION, 'content-type': 'video/mp4'}, content=b'\x00\x00\x00\x20ftypisom' + b'0' * 40)
        with tempfile.TemporaryDirectory() as tmp:
            client = httpx.Client(transport=httpx.MockTransport(handle))
            target = Path(tmp) / 'out.mp4'
            with patch.dict(os.environ, SCENE_MOTION_RENDER_TOKEN='fixture-token'), patch.object(renderer.httpx, 'Client', return_value=client), patch.object(renderer.time, 'sleep'):
                renderer.render_scene_data({'players': []}, target)
            self.assertEqual(len(attempts), 2)
            self.assertIn(b'ftyp', target.read_bytes())
            self.assertFalse(target.with_suffix('.partial').exists())

    def test_wrong_version_or_invalid_mp4_preserves_existing_file(self):
        for version, payload in [('old', b'ftypisom'), (renderer.SCENE_RENDER_VERSION, b'not a video')]:
            def handle(request): return httpx.Response(200, headers={'x-scene-renderer': version, 'content-type': 'video/mp4'}, content=payload)
            with self.subTest(version=version), tempfile.TemporaryDirectory() as tmp:
                client = httpx.Client(transport=httpx.MockTransport(handle))
                target = Path(tmp) / 'out.mp4'; target.write_bytes(b'original')
                with patch.dict(os.environ, SCENE_MOTION_RENDER_TOKEN='fixture-token'), patch.object(renderer.httpx, 'Client', return_value=client):
                    with self.assertRaises(RuntimeError): renderer.render_scene_data({}, target)
                self.assertEqual(target.read_bytes(), b'original')
                self.assertFalse(target.with_suffix('.partial').exists())

    def test_no_token_does_not_start_render(self):
        with patch.dict(os.environ, SCENE_MOTION_RENDER_TOKEN=''), patch.object(renderer.httpx, 'Client') as client:
            with self.assertRaises(RuntimeError): renderer.render_scene_data({}, Path('/unused'))
            client.assert_not_called()

    def test_frontend_backend_render_version_match(self):
        web = Path(__file__).resolve().parents[2] / 'web/lib/scene-motion-render.ts'
        self.assertIn(f"SCENE_RENDER_VERSION = '{renderer.SCENE_RENDER_VERSION}'", web.read_text())


if __name__ == '__main__': unittest.main()
