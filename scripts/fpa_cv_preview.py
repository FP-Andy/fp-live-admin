"""Browser H.264 preview encoding independent of OpenCV's bundled codecs."""
from pathlib import Path
from functools import lru_cache
import shutil
import subprocess
import tempfile


def nvenc_options(device):
    return ['-c:v', 'h264_nvenc', '-gpu', str(device), '-preset', 'p4', '-tune', 'hq',
            '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-profile:v', 'high', '-threads', '1']


@lru_cache(maxsize=8)
def probe_nvenc(executable, device, size):
    """A listed encoder need not have working drivers; encode actual frames."""
    width, height = size
    command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-f', 'lavfi', '-i', f'color=c=black:s={width}x{height}:r=30',
               '-frames:v', '2', *nvenc_options(device), '-pix_fmt', 'yuv420p', '-f', 'null', '-']
    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    return result.returncode == 0, result.stderr[-800:]


class PreviewWriter:
    def __init__(self, path, fps, size, *, encoder='cpu', device=None):
        if encoder not in ('auto', 'cpu', 'gpu'):
            raise ValueError('Unknown preview encoder')
        self.path = Path(path)
        self.size = size
        self.frames = 0
        self.closed = False
        self.fallback_reason = None
        self.process = self.errors = self.writer = None
        executable = shutil.which('ffmpeg')
        use_gpu = False
        if encoder == 'gpu' and (not executable or device is None):
            raise RuntimeError('GPU 미리보기에는 FFmpeg와 CUDA 장치가 필요합니다.')
        if executable and device is not None and encoder != 'cpu':
            use_gpu, detail = probe_nvenc(executable, str(device), tuple(size))
            if not use_gpu:
                if encoder == 'gpu':
                    raise RuntimeError(f'GPU 미리보기 인코더를 사용할 수 없습니다: {detail}')
                self.fallback_reason = detail
        if executable:
            self.errors = tempfile.TemporaryFile()
            width, height = size
            command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                       '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', f'{width}x{height}',
                       '-framerate', str(fps), '-i', 'pipe:0', '-an',
                       *(nvenc_options(device) if use_gpu else ['-c:v', 'libx264',
                         '-preset', 'veryfast', '-crf', '23', '-threads', '2']),
                       '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(self.path)]
            try:
                self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                                stdout=subprocess.DEVNULL, stderr=self.errors)
            except BaseException:
                self.errors.close()
                raise
            self.encoder = 'FFmpeg NVENC H.264' if use_gpu else 'FFmpeg libx264'
        else:
            # Preserve the working macOS backend when FFmpeg CLI is absent.
            import cv2
            self.writer = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*'avc1'), fps, size)
            if not self.writer.isOpened():
                self.writer.release()
                raise RuntimeError('H.264 미리보기 인코더가 없습니다. FFmpeg(libx264)를 설치하세요.')
            self.encoder = 'OpenCV avc1'

    def write(self, frame):
        if self.closed:
            raise RuntimeError('Preview encoder is closed')
        if frame.shape != (self.size[1], self.size[0], 3) or str(frame.dtype) != 'uint8':
            raise ValueError('Preview requires uint8 BGR frames at the configured size')
        if self.process:
            try:
                self.process.stdin.write(frame.tobytes())
            except (BrokenPipeError, OSError):
                self.release()
                raise RuntimeError('미리보기 인코더 연결이 종료되었습니다.')
        else:
            self.writer.write(frame)
        self.frames += 1

    def release(self):
        if self.closed:
            return
        self.closed = True
        error = None
        if self.process:
            try:
                try:
                    self.process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                try:
                    code = self.process.wait(timeout=120)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                    code = -1
                if code:
                    self.errors.seek(0)
                    detail = self.errors.read().decode(errors='replace')[-1600:]
                    error = RuntimeError(f'미리보기 H.264 인코딩 실패 ({code}): {detail}')
            finally:
                self.errors.close()
        else:
            self.writer.release()
        if error or not self.frames or not self.path.is_file() or not self.path.stat().st_size:
            self.path.unlink(missing_ok=True)
            raise error or RuntimeError('미리보기 영상이 생성되지 않았습니다.')

    def abort(self):
        if not self.closed:
            self.closed = True
            if self.process:
                self.process.kill()
                self.process.wait()
                try:
                    self.process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                self.errors.close()
            else:
                self.writer.release()
        self.path.unlink(missing_ok=True)
