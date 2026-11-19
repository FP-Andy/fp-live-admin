"""Broadcast PNG composition must retain alpha and the existing layer URLs."""
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.broadcast_assets import BroadcastAssetStore, CANVAS, composite_asset_pair, store_asset_pair


def png(image):
    out = BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()


class BroadcastCompositeTests(unittest.TestCase):
    def setUp(self):
        background = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
        background.putpixel((500, 500), (10, 40, 80, 255))
        asset = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
        asset.putpixel((500, 500), (250, 100, 20, 128))
        asset.putpixel((600, 600), (255, 255, 255, 255))
        self.layers = (png(background), png(asset))

    def test_alpha_composition_preserves_card_and_transparent_canvas(self):
        result = Image.open(BytesIO(composite_asset_pair(*self.layers)))
        self.assertEqual(result.mode, 'RGBA')
        self.assertEqual(result.size, CANVAS)
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((600, 600)), (255, 255, 255, 255))
        self.assertEqual(result.getpixel((500, 500)), (130, 70, 50, 255))

    def test_mismatched_canvas_is_rejected(self):
        with self.assertRaises(ValueError):
            composite_asset_pair(self.layers[0], png(Image.new('RGBA', (1, 1))))

    def test_storage_preserves_original_layers_and_provides_stable_live_url(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BROADCAST_RUNTIME_DIR': directory, 'BROADCAST_S3_BUCKET': '', 'BROADCAST_PUBLIC_BASE_URL': 'https://broadcast.example'}, clear=False):
            store = BroadcastAssetStore()
            saved = store_asset_pair(store, 'match-1/live/possession/latest', 'possession', {}, rendered=self.layers)
            self.assertTrue(saved.combined_url.endswith('/match-1/live/possession/latest/combined.png'))
            self.assertEqual(store.read_asset_url(saved.background_url, 'match-1'), self.layers[0])
            self.assertEqual(store.read_asset_url(saved.asset_url, 'match-1'), self.layers[1])
            self.assertEqual(store.read_asset_url(saved.combined_url, 'match-1'), composite_asset_pair(*self.layers))
            with self.assertRaises(ValueError):
                store.read_asset_url(saved.asset_url, 'other-match')
            with self.assertRaises(ValueError):
                store.read_asset_url('https://evil.example/api/broadcast/assets/match-1/asset.png', 'match-1')


if __name__ == '__main__':
    unittest.main()
