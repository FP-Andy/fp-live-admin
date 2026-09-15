"""Coalesce club branding updates without occupying a DB connection per match."""
import logging
import threading
import time
from collections.abc import Callable
from uuid import UUID

logger = logging.getLogger(__name__)


class BrandingRefreshQueue:
    """One worker; pending matches carry IDs only, never open DB sessions.

    An update during a render schedules one more render with the latest data.
    Repeated pending updates restart the short debounce window.
    """

    def __init__(self, render: Callable[[UUID], None], debounce_seconds: float = 2.0):
        self._render = render
        self._delay = debounce_seconds
        self._condition = threading.Condition()
        self._pending: dict[UUID, float] = {}
        self._worker: threading.Thread | None = None
        self._closed = False

    def submit(self, match_id: UUID) -> None:
        with self._condition:
            if self._closed:
                return
            self._pending[match_id] = time.monotonic() + self._delay
            if self._worker is None:
                self._worker = threading.Thread(target=self._run, name="branding-refresh", daemon=True)
                self._worker.start()
            self._condition.notify()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._pending.clear()
            self._condition.notify()

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._closed:
                    if not self._pending:
                        self._condition.wait()
                        continue
                    match_id = min(self._pending, key=self._pending.__getitem__)
                    remaining = self._pending[match_id] - time.monotonic()
                    if remaining > 0:
                        self._condition.wait(remaining)
                        continue
                    del self._pending[match_id]
                    break
                if self._closed:
                    return
            try:
                self._render(match_id)
            except Exception:
                logger.exception("Broadcast branding refresh failed for %s", match_id)
