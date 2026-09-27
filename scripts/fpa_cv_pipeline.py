"""Bounded, ordered stages for overlapping decode, inference and CPU work.

Each stage has exactly one owner. Tracking stays in the consuming thread, so
prefetch cannot reorder tracker updates or change identity state.
"""
from queue import Empty, Full, Queue
from threading import Event, Thread
import time


_END = object()


class OrderedPipeline:
    def __init__(self, source, stages=(), *, capacity=2, threaded=True):
        if capacity < 1:
            raise ValueError('Pipeline capacity must be positive')
        self.source = source
        self.stages = stages
        self.threaded = threaded
        self.queues = [Queue(maxsize=capacity) for _ in range(len(stages)+1)]
        self.stop = Event()
        self.errors = Queue()
        self.workers = []
        self.stats = {name: {'items': 0, 'busySeconds': 0.0}
                      for name in ['decode_preview', *(name for name, _ in stages)]}

    def _check_error(self):
        try:
            error, traceback = self.errors.get_nowait()
        except Empty:
            return
        raise error.with_traceback(traceback)

    def _put(self, queue, item):
        while not self.stop.is_set():
            try:
                queue.put(item, timeout=.05)
                return True
            except Full:
                pass
        return False

    def _items(self, queue):
        while not self.stop.is_set():
            self._check_error()
            try:
                item = queue.get(timeout=.05)
            except Empty:
                continue
            if item is _END:
                return
            yield item
        self._check_error()

    def _record(self, name, seconds):
        self.stats[name]['items'] += 1
        self.stats[name]['busySeconds'] += seconds

    def _produce(self):
        try:
            source = iter(self.source)
            while not self.stop.is_set():
                started = time.monotonic()
                try:
                    item = next(source)
                except StopIteration:
                    break
                self._record('decode_preview', time.monotonic()-started)
                if not self._put(self.queues[0], item):
                    break
            self._put(self.queues[0], _END)
        finally:
            if hasattr(self.source, 'close'):
                self.source.close()

    def _transform(self, index, name, transform):
        for item in self._items(self.queues[index]):
            started = time.monotonic()
            result = transform(item)
            self._record(name, time.monotonic()-started)
            if not self._put(self.queues[index+1], result):
                return
        self._put(self.queues[index+1], _END)

    def _run(self, target, args):
        try:
            target(*args)
        except BaseException as error:
            self.errors.put((error, error.__traceback__))
            self.stop.set()

    def __enter__(self):
        if self.threaded:
            tasks = [('decode_preview', self._produce, ())]
            tasks += [(name, self._transform, (index, name, transform))
                      for index, (name, transform) in enumerate(self.stages)]
            for name, target, args in tasks:
                worker = Thread(target=self._run, args=(target, args), name=f'fpa-{name}', daemon=True)
                self.workers.append(worker)
                worker.start()
        return self

    def __iter__(self):
        if self.threaded:
            yield from self._items(self.queues[-1])
        else:
            source = iter(self.source)
            while True:
                started = time.monotonic()
                try:
                    item = next(source)
                except StopIteration:
                    return
                self._record('decode_preview', time.monotonic()-started)
                for name, transform in self.stages:
                    started = time.monotonic()
                    item = transform(item)
                    self._record(name, time.monotonic()-started)
                yield item

    def __exit__(self, kind, error, traceback):
        self.stop.set()
        deadline = time.monotonic()+5
        for worker in self.workers:
            worker.join(timeout=max(0, deadline-time.monotonic()))
        if not self.threaded and hasattr(self.source, 'close'):
            self.source.close()
        if kind is None:
            self._check_error()
            if any(worker.is_alive() for worker in self.workers):
                raise RuntimeError('Video pipeline failed to stop; result has not been published')
        # Drop prefetched frames promptly, also when a consumer exits early.
        for queue in self.queues:
            while not queue.empty():
                queue.get_nowait()
