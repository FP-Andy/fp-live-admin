"""Exercise the real encoder, MP4 playback metadata and failed-output cleanup."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fpa_cv_preview import PreviewWriter


class Frame:
    shape = (180, 320, 3)
    dtype = 'uint8'
    def tobytes(self):
        return bytes([20, 100, 220]) * (320 * 180)


class PreviewTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg CLI required')
    def test_h264_mp4_preserves_all_frames_and_fractional_fps(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)/'preview.mp4'
            writer = PreviewWriter(output, 30000/1001, (320, 180))
            for _ in range(60):
                writer.write(Frame())
            writer.release()
            stream = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))['streams'][0]
            self.assertEqual(stream['codec_name'], 'h264')
            self.assertEqual(stream['pix_fmt'], 'yuv420p')
            self.assertEqual((stream['width'],stream['height']), (320,180))
            self.assertEqual(int(stream['nb_frames']), 60)
            self.assertAlmostEqual(float(stream['duration']), 60/(30000/1001), places=3)
            data = output.read_bytes()
            self.assertLess(data.index(b'moov'), data.index(b'mdat'))
            subprocess.run(['ffmpeg','-v','error','-i',str(output),'-f','null','-'],check=True)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg CLI required')
    def test_abort_stops_encoder_and_removes_partial_output(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)/'preview.mp4'
            writer = PreviewWriter(output, 30, (320,180))
            writer.write(Frame())
            writer.abort()
            self.assertIsNotNone(writer.process.poll())
            self.assertFalse(output.exists())

    def test_encoder_failure_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            encoder = root/'broken-ffmpeg'
            encoder.write_text(f'#!{sys.executable}\nimport sys\nfrom pathlib import Path\nPath(sys.argv[-1]).write_bytes(b"partial")\nsys.stderr.write("test encoder failure")\nsys.exit(3)\n')
            encoder.chmod(0o700)
            output = root/'preview.mp4'
            with patch('fpa_cv_preview.shutil.which', return_value=str(encoder)):
                writer = PreviewWriter(output, 30, (320,180))
                with self.assertRaisesRegex(RuntimeError, 'test encoder failure'):
                    writer.release()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
