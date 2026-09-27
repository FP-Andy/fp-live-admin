"""NVDEC + GPU preview scaling/encoding, returning only analysis frames.

Trim/select use frame indices, not approximate timestamp seeks. Downloading via
planar YUV420P preserves OpenCV's BGR conversion for supported 8-bit sources.
The caller compares the first decoded frame before enabling this path.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Timer

from fpa_cv_preview import nvenc_options


class GpuVideo:
    encoder = 'FFmpeg NVDEC + CUDA scale + NVENC H.264'
    fallback_reason = None

    def __init__(self, source, path, *, width, height, fps, first, last, stride,
                 anchor, preview_size, device='0'):
        executable = shutil.which('ffmpeg')
        if not executable:
            raise RuntimeError('FFmpeg is required for GPU video decoding')
        self.path = Path(path) if path else None
        self.width, self.height = width, height
        self.indices = [i for i in range(first, last) if (i-first) % stride == 0 or i == anchor]
        self.read_count = 0
        self.closed = False
        self.errors = tempfile.TemporaryFile()
        selection = f'not(mod(n,{stride}))'
        if anchor is not None and first <= anchor < last:
            selection += f'+eq(n,{anchor-first})'
        analysis = f"select='{selection}',hwdownload,format=nv12,format=yuv420p,format=bgr24"
        trim = f'trim=start_frame={first}:end_frame={last}'
        command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                   '-hwaccel', 'cuda', '-hwaccel_device', str(device), '-hwaccel_output_format', 'cuda',
                   '-i', str(source)]
        if self.path:
            pw, ph = preview_size
            graph = (f'[0:v]{trim},split=2[full][sample];'
                     f'[full]scale_cuda={pw}:{ph}:interp_algo=bilinear,setpts=N/({fps}*TB)[preview];'
                     f'[sample]{analysis}[raw]')
            command += ['-filter_complex', graph, '-map', '[preview]', '-an', '-sn',
                        *nvenc_options(device), '-r', str(fps), '-fps_mode', 'cfr',
                        '-frames:v', str(last-first), '-movflags', '+faststart', str(self.path)]
        else:
            command += ['-filter_complex', f'[0:v]{trim},{analysis}[raw]']
        command += ['-map', '[raw]', '-an', '-sn', '-c:v', 'rawvideo', '-threads', '1',
                    '-pix_fmt', 'bgr24', '-frames:v', str(len(self.indices)),
                    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']
        try:
            self.process = subprocess.Popen(command, stdout=subprocess.PIPE,
                                            stderr=self.errors, stdin=subprocess.DEVNULL)
        except BaseException:
            self.errors.close()
            raise

    def read(self):
        import numpy as np
        if self.closed or self.read_count >= len(self.indices):
            return False, None
        size = self.width*self.height*3
        # Bound the initial hardware probe; auto mode can then fall back even
        # if a driver/codec hangs before delivering its first frame.
        timer = Timer(30, self.process.kill) if self.read_count == 0 else None
        if timer:
            timer.start()
        try:
            data = self.process.stdout.read(size)
        finally:
            if timer:
                timer.cancel()
        if len(data) != size:
            self.errors.seek(0)
            raise RuntimeError('GPU decode returned an incomplete frame: '+self.errors.read().decode(errors='replace')[-1200:])
        self.read_count += 1
        return True, np.frombuffer(data, np.uint8).reshape(self.height, self.width, 3)

    def release(self):
        if self.closed:
            return
        try:
            if self.read_count != len(self.indices):
                raise RuntimeError('GPU video did not return every analysis frame')
            try:
                code = self.process.wait(timeout=30)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError('GPU video finalization timed out') from error
            if code:
                self.errors.seek(0)
                raise RuntimeError('GPU video failed: '+self.errors.read().decode(errors='replace')[-1200:])
            if self.path and (not self.path.is_file() or not self.path.stat().st_size):
                raise RuntimeError('GPU preview was not created')
        except BaseException:
            self.abort()
            raise
        self.closed = True
        self.process.stdout.close()
        self.errors.close()

    def abort(self):
        if not self.closed:
            self.closed = True
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait()
            self.process.stdout.close()
            self.errors.close()
        if self.path:
            self.path.unlink(missing_ok=True)
