"""Frame alignment, partial results and GPU subprocess cleanup."""
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fpa_cv_gpu_video import GpuVideo


class GpuVideoTests(unittest.TestCase):
    def video(self, data=b'', *, path=None, first=2, last=7, stride=2, anchor=3):
        process=MagicMock()
        process.stdout=io.BytesIO(data)
        process.wait.return_value=0
        process.poll.return_value=None
        with patch('fpa_cv_gpu_video.shutil.which',return_value='/ffmpeg'), patch('fpa_cv_gpu_video.subprocess.Popen',return_value=process):
            video=GpuVideo('source',path,width=2,height=2,fps=30,first=first,last=last,stride=stride,anchor=anchor,preview_size=(2,2))
        return video,process

    def test_off_stride_anchor_order_and_exact_end(self):
        video,process=self.video(b''.join(bytes([n])*12 for n in [2,3,4,6]))
        self.assertEqual(video.indices,[2,3,4,6])
        for n in video.indices:
            ok,frame=video.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape,(2,2,3))
            self.assertTrue((frame==n).all())
        self.assertEqual(video.read(),(False,None))
        video.release();video.release()
        process.kill.assert_not_called()

    def test_truncated_frame_aborts_partial_preview(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'preview.mp4';path.write_bytes(b'partial')
            video,process=self.video(b'bad',path=path)
            with self.assertRaisesRegex(RuntimeError,'incomplete frame'):
                try:video.read()
                finally:video.abort()
            self.assertFalse(path.exists())
            process.kill.assert_called_once()

    def test_unconsumed_output_cannot_finalize(self):
        video,process=self.video()
        with self.assertRaisesRegex(RuntimeError,'every analysis frame'):video.release()
        self.assertTrue(video.closed)
        process.kill.assert_called_once()

    def test_encoder_failure_cannot_publish(self):
        video,process=self.video(b'x'*12,first=0,last=1,anchor=0)
        video.read();process.wait.return_value=1
        with self.assertRaisesRegex(RuntimeError,'GPU video failed'):video.release()
        self.assertTrue(video.closed)

    def test_finalization_timeout_kills_process(self):
        video,process=self.video(b'x'*12,first=0,last=1,anchor=0)
        video.read();process.wait.side_effect=[subprocess.TimeoutExpired('ffmpeg',30),0]
        with self.assertRaisesRegex(RuntimeError,'timed out'):video.release()
        process.kill.assert_called_once()


if __name__=='__main__':unittest.main()
