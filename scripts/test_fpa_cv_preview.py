"""Exercise the real encoder, MP4 playback metadata and failed-output cleanup."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fpa_cv_preview import PreviewWriter, probe_nvenc


class Frame:
    shape = (180, 320, 3)
    dtype = 'uint8'
    def tobytes(self):
        return bytes([20, 100, 220]) * (320 * 180)


class PreviewTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg CLI required')
    def test_h264_mp4_preserves_all_frames_and_fractional_fps(self):
        encoders = ['cpu', 'gpu'] if os.environ.get('FPA_TEST_NVENC') == '1' else ['cpu']
        for encoder in encoders:
            with self.subTest(encoder=encoder):
                self.check_playback(encoder)

    def check_playback(self, encoder):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)/'preview.mp4'
            writer = PreviewWriter(output, 30000/1001, (320, 180), encoder=encoder, device='0')
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

    def test_auto_falls_back_before_writing_when_gpu_probe_fails(self):
        with tempfile.TemporaryDirectory() as root, \
             patch('fpa_cv_preview.shutil.which', return_value='ffmpeg'), \
             patch('fpa_cv_preview.probe_nvenc', return_value=(False, 'driver missing')), \
             patch('fpa_cv_preview.subprocess.Popen') as start:
            writer = PreviewWriter(Path(root)/'preview.mp4', 30, (320, 180), encoder='auto', device='0')
            self.assertEqual(writer.encoder, 'FFmpeg libx264')
            self.assertEqual(writer.fallback_reason, 'driver missing')
            self.assertIn('libx264', start.call_args.args[0])
            self.assertNotIn('h264_nvenc', start.call_args.args[0])
            writer.abort()

    def test_explicit_gpu_failure_does_not_silently_change_benchmark_backend(self):
        with tempfile.TemporaryDirectory() as root, \
             patch('fpa_cv_preview.shutil.which', return_value='ffmpeg'), \
             patch('fpa_cv_preview.probe_nvenc', return_value=(False, 'driver missing')), \
             patch('fpa_cv_preview.subprocess.Popen') as start:
            with self.assertRaisesRegex(RuntimeError, 'driver missing'):
                PreviewWriter(Path(root)/'preview.mp4', 30, (320, 180), encoder='gpu', device='0')
            start.assert_not_called()

    def test_cpu_path_does_not_probe_gpu(self):
        with tempfile.TemporaryDirectory() as root, \
             patch('fpa_cv_preview.shutil.which', return_value='ffmpeg'), \
             patch('fpa_cv_preview.probe_nvenc') as probe, \
             patch('fpa_cv_preview.subprocess.Popen'):
            writer = PreviewWriter(Path(root)/'preview.mp4', 30, (320, 180), encoder='auto')
            probe.assert_not_called()
            writer.abort()

    def test_probe_is_bounded_and_requires_a_successful_encode(self):
        probe_nvenc.cache_clear()
        with patch('fpa_cv_preview.subprocess.run', side_effect=subprocess.TimeoutExpired('ffmpeg', 15)):
            ok, reason = probe_nvenc('ffmpeg', '0', (320, 180))
            self.assertFalse(ok)
            self.assertIn('timed out', reason)
        probe_nvenc.cache_clear()

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg CLI required')
    def test_abort_stops_encoder_and_removes_partial_output(self):
        encoders = ['cpu', 'gpu'] if os.environ.get('FPA_TEST_NVENC') == '1' else ['cpu']
        for encoder in encoders:
            with self.subTest(encoder=encoder):
                self.check_abort(encoder)

    def check_abort(self, encoder):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)/'preview.mp4'
            writer = PreviewWriter(output, 30, (320,180), encoder=encoder, device='0')
            writer.write(Frame())
            writer.abort()
            self.assertIsNotNone(writer.process.poll())
            self.assertFalse(output.exists())

    def test_encoder_failure_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            encoder = root/'broken-ffmpeg'
            encoder.write_text(f'#!{Path(sys.executable).resolve()}\nimport sys\nfrom pathlib import Path\nPath(sys.argv[-1]).write_bytes(b"partial")\nsys.stderr.write("test encoder failure")\nsys.exit(3)\n')
            encoder.chmod(0o700)
            output = root/'preview.mp4'
            with patch('fpa_cv_preview.shutil.which', return_value=str(encoder)):
                writer = PreviewWriter(output, 30, (320,180))
                with self.assertRaisesRegex(RuntimeError, 'test encoder failure'):
                    writer.release()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
