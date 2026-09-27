"""One CPU appearance worker, sharing one frame instead of pickling 4K video.

The caller serializes requests: the shared frame is not overwritten until the
worker returns. Detection boxes retain their NumPy dtype and original order.
"""
from multiprocessing import get_context, shared_memory
from pathlib import Path
import shutil
import traceback


def _work(connection, name, shape, uniforms):
    import numpy as np
    from fpa_cv_colors import appearance
    from fpa_cv_uniforms import classify_uniform
    memory = shared_memory.SharedMemory(name=name)
    frame = np.ndarray(shape, dtype=np.uint8, buffer=memory.buf)
    try:
        connection.send(('ready', None))
        while True:
            boxes = connection.recv()
            if boxes is None:
                break
            descriptors = [appearance(frame, box) for box in boxes]
            connection.send(('result', (descriptors, [classify_uniform(a, uniforms) for a in descriptors])))
    except EOFError:
        pass
    except BaseException:
        try:
            connection.send(('error', traceback.format_exc()))
        except (BrokenPipeError, OSError):
            pass
    finally:
        connection.close()
        memory.close()


class AppearanceWorker:
    def __init__(self, shape, uniforms):
        import math
        import numpy as np
        size = math.prod(shape)
        # Linux containers can have a small /dev/shm. Check before touching
        # pages; SharedMemory allocation alone does not reserve physical space.
        if Path('/dev/shm').is_dir() and shutil.disk_usage('/dev/shm').free < size*2:
            raise OSError('Not enough shared memory for the appearance worker')
        self.memory = shared_memory.SharedMemory(create=True, size=size)
        self.frame = np.ndarray(shape, dtype=np.uint8, buffer=self.memory.buf)
        context = get_context('spawn')
        self.connection, child = context.Pipe()
        self.process = context.Process(target=_work, args=(child, self.memory.name, shape, uniforms),
                                       name='fpa-appearance', daemon=True)
        try:
            self.process.start()
            child.close()
            if not self.connection.poll(15):
                raise RuntimeError('Appearance worker failed to start')
            state, detail = self.connection.recv()
            if state != 'ready':
                raise RuntimeError(f'Appearance worker failed: {detail}')
        except BaseException:
            child.close()
            self.close()
            raise

    def describe(self, frame, boxes):
        import numpy as np
        if frame.shape != self.frame.shape or frame.dtype != self.frame.dtype:
            raise ValueError('Unexpected frame shape or dtype')
        np.copyto(self.frame, frame)
        self.connection.send(boxes)
        while not self.connection.poll(.1):
            if not self.process.is_alive():
                raise RuntimeError('Appearance worker stopped before returning a frame')
        state, result = self.connection.recv()
        if state != 'result':
            raise RuntimeError(f'Appearance worker failed: {result}')
        return result

    def close(self):
        try:
            if self.process.is_alive():
                try:
                    self.connection.send(None)
                except (BrokenPipeError, OSError):
                    pass
                self.process.join(timeout=2)
                if self.process.is_alive():
                    self.process.terminate()
                    self.process.join(timeout=2)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join()
        finally:
            self.connection.close()
            self.memory.close()
            self.memory.unlink()
