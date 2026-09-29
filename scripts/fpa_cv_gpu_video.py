"""NVDEC + GPU preview scaling/encoding, returning only analysis frames.

Trim/select use frame indices, not approximate timestamp seeks. Downloading via
planar YUV420P preserves OpenCV's BGR conversion for supported 8-bit sources.
The caller compares the first decoded frame before enabling this path.
"""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
from threading import Timer

from fpa_cv_preview import nvenc_options


def decoder_formats(source):
    """Download NVDEC's native depth before reproducing OpenCV's conversion."""
    probe = shutil.which('ffprobe')
    if not probe:
        raise RuntimeError('FFprobe is required to select the GPU pixel format')
    result = subprocess.run([probe, '-v', 'error', '-select_streams', 'v:0',
                             '-show_entries', 'stream=pix_fmt', '-of', 'json', str(source)],
                            capture_output=True, text=True, timeout=15, check=True)
    pixel_format = json.loads(result.stdout)['streams'][0]['pix_fmt']
    if pixel_format in {'yuv420p10le', 'p010le'}:
        return 'p010le', 'yuv420p10le'
    if pixel_format in {'yuv420p', 'yuvj420p', 'nv12'}:
        return 'nv12', 'yuv420p'
    raise RuntimeError(f'Unsupported GPU source pixel format: {pixel_format}')


class GpuVideo:
    encoder = 'FFmpeg NVDEC + CUDA scale + NVENC H.264'
    fallback_reason = None

    def __init__(self, source, path, *, width, height, fps, first, last, stride,
                 anchor, preview_size, device='0'):
        executable = shutil.which('ffmpeg')
        if not executable:
            raise RuntimeError('FFmpeg is required for GPU video decoding')
        native_format, planar_format = decoder_formats(source)
        self.converter = None
        if native_format=='p010le':
            from fpa_cv_native_color import NativeColor
            self.converter=NativeColor(width,height,source)
        self.path = Path(path) if path else None
        self.width, self.height = width, height
        self.indices = [i for i in range(first, last) if (i-first) % stride == 0 or i == anchor]
        self.read_count = 0
        self.closed = False
        self.errors = tempfile.TemporaryFile()
        selection = f'not(mod(n,{stride}))'
        if anchor is not None and first <= anchor < last:
            selection += f'+eq(n,{anchor-first})'
        output_format = planar_format if self.converter else 'bgr24'
        analysis = f"select='{selection}',hwdownload,format={native_format},format={planar_format},format={output_format}"
        trim = f'trim=start_frame={first}:end_frame={last}'
        command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                   '-hwaccel', 'cuda', '-hwaccel_device', str(device), '-hwaccel_output_format', 'cuda',
                   '-i', str(source)]
        if self.path:
            pw, ph = preview_size
            graph = (f'[0:v]{trim},split=2[full][sample];'
                     f'[full]scale_cuda={pw}:{ph}:format=nv12:interp_algo=bilinear,setpts=N/({fps}*TB)[preview];'
                     f'[sample]{analysis}[raw]')
            command += ['-filter_complex', graph, '-map', '[preview]', '-an', '-sn',
                        *nvenc_options(device), '-r', str(fps), '-fps_mode', 'cfr',
                        '-frames:v', str(last-first), '-movflags', '+faststart', str(self.path)]
        else:
            command += ['-filter_complex', f'[0:v]{trim},{analysis}[raw]']
        command += ['-map', '[raw]', '-an', '-sn', '-c:v', 'rawvideo', '-threads', '1',
                    '-pix_fmt', output_format, '-frames:v', str(len(self.indices)),
                    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']
        try:
            self.process = subprocess.Popen(command, stdout=subprocess.PIPE,
                                            stderr=self.errors, stdin=subprocess.DEVNULL)
        except BaseException:
            if self.converter:self.converter.close()
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
        return True, self.converter.convert(data) if self.converter else np.frombuffer(data, np.uint8).reshape(self.height, self.width, 3)

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
        if self.converter:self.converter.close()
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
            if self.converter:self.converter.close()
        if self.path:
            self.path.unlink(missing_ok=True)
