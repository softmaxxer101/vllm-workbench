"""Shared telemetry sampler for the live metrics stream.

A naive SSE endpoint samples the engine once per connected browser tab. That
means a laptop with three tabs open triples the Prometheus scrapes and
`nvidia-smi` calls, and tabs can disagree about the values they show because
each one samples at a different instant.

This module owns a single sampler loop per application process:

* it ticks once per `interval` seconds and builds one snapshot,
* every snapshot is fanned out to all subscribers as a monotonic frame,
* each subscriber has a small bounded queue, so a slow client drops old frames
  instead of stalling the sampler for everyone else,
* a subscriber can ask to be throttled to a slower cadence than the sampler,
* the sampler only runs while at least one subscriber is attached.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from .manager import VLLMProcessManager
from .metrics import MetricsService
from .schemas import MetricsSnapshot, ServerStatus, StreamInfo

logger = logging.getLogger("workbench.telemetry")

DEFAULT_INTERVAL_S = 1.0
# Comment frames keep idle proxies from closing the connection before the next
# sample is due. Browsers ignore them, so they are free.
SSE_HEARTBEAT_S = 12.0


class SnapshotSource(Protocol):
    async def snapshot(self, server: ServerStatus) -> MetricsSnapshot: ...


@dataclass(slots=True)
class Frame:
    """One sampled snapshot, shared by every subscriber."""

    id: int
    snapshot: MetricsSnapshot | None
    sampled_in_ms: float
    sampled_at: datetime
    error: str | None = None


@dataclass(slots=True, eq=False)
class Subscription:
    interval: float
    queue: asyncio.Queue[Frame]
    dropped: int = 0
    last_delivery_at: float = 0.0


class TelemetryHub:
    def __init__(
        self,
        metrics: MetricsService,
        manager: VLLMProcessManager,
        *,
        interval: float = DEFAULT_INTERVAL_S,
        queue_size: int = 4,
    ) -> None:
        self._metrics: SnapshotSource = metrics
        self._manager = manager
        self.interval = interval
        self.queue_size = max(1, queue_size)
        self._subscribers: set[Subscription] = set()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._sequence = 0
        self._frames = 0
        self._failures = 0
        self._sample_ms: float | None = None
        self._last_frame_at: datetime | None = None
        self._last_started = time.monotonic()
        # Number of engine scrapes actually performed. Tests assert that this
        # grows with time, not with the number of connected clients.
        self.samples = 0

    # ------------------------------------------------------------------ status
    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def stats(self) -> dict[str, float | int | str | bool | None]:
        return {
            "running": self.running,
            "subscribers": len(self._subscribers),
            "frames": self._frames,
            "samples": self.samples,
            "failures": self._failures,
            "sequence": self._sequence,
            "interval_s": self.interval,
            "sample_ms": round(self._sample_ms, 2) if self._sample_ms is not None else None,
            "last_frame_at": (
                self._last_frame_at.isoformat() if self._last_frame_at is not None else None
            ),
            "uptime_s": round(max(time.monotonic() - self._last_started, 0.0), 2),
        }

    # -------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        async with self._lock:
            self._ensure_task()

    def _ensure_task(self) -> None:
        if self._task is None or self._task.done():
            self._last_started = time.monotonic()
            self._task = asyncio.create_task(self._run(), name="telemetry-sampler")

    async def close(self) -> None:
        async with self._lock:
            self._subscribers.clear()
            await self._cancel_task()

    async def _cancel_task(self) -> None:
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------ subscriptions
    async def subscribe(self, *, interval: float | None = None) -> Subscription:
        requested = interval if interval and interval > 0 else self.interval
        subscription = Subscription(
            interval=requested,
            queue=asyncio.Queue(maxsize=self.queue_size),
        )
        async with self._lock:
            self._subscribers.add(subscription)
            self._ensure_task()
        return subscription

    async def unsubscribe(self, subscription: Subscription) -> None:
        async with self._lock:
            self._subscribers.discard(subscription)
            if not self._subscribers:
                await self._cancel_task()

    async def next_frame(self, subscription: Subscription) -> Frame:
        return await subscription.queue.get()

    # --------------------------------------------------------------- sampling
    async def _run(self) -> None:
        while True:
            started = time.perf_counter()
            error: str | None = None
            snapshot: MetricsSnapshot | None = None
            try:
                snapshot = await self._metrics.snapshot(self._manager.status())
                self.samples += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a failed scrape must not kill the stream
                self._failures += 1
                error = f"{type(exc).__name__}: {exc}"

            sampled_in_ms = (time.perf_counter() - started) * 1000
            self._sample_ms = sampled_in_ms
            self._sequence += 1
            frame = Frame(
                id=self._sequence,
                snapshot=snapshot,
                sampled_in_ms=sampled_in_ms,
                sampled_at=datetime.now(timezone.utc),
                error=error,
            )
            self._frames += 1
            self._last_frame_at = frame.sampled_at
            try:
                self._fan_out(frame)
            except Exception:  # never let one bad frame kill every subscriber
                logger.exception("Telemetry fan-out failed")

            elapsed = time.perf_counter() - started
            await asyncio.sleep(max(0.02, self.interval - elapsed))

    def _fan_out(self, frame: Frame) -> None:
        now = time.monotonic()
        subscribers = len(self._subscribers)
        # A small early tolerance keeps a 1 Hz subscriber at 1 Hz: without it,
        # a sampler tick a millisecond early would be skipped and the client
        # would see alternating 1s and 2s gaps.
        tolerance = min(0.15, self.interval * 0.15)
        for subscription in list(self._subscribers):
            # Clients that want the sampler's own cadence (or faster) get every
            # frame. Throttling only applies to genuinely slower subscribers,
            # where a skipped tick is the intent rather than jitter.
            if subscription.interval > self.interval * 1.25:
                if now - subscription.last_delivery_at < subscription.interval - tolerance:
                    continue
            subscription.last_delivery_at = now
            self._offer(subscription, frame, subscribers)

    def _offer(self, subscription: Subscription, frame: Frame, subscribers: int) -> None:
        # Each subscriber gets its own envelope: the payload is shared, but the
        # stream metadata (sequence is global, dropped is per client) is not.
        snapshot = frame.snapshot
        delivery = Frame(
            id=frame.id,
            snapshot=(
                snapshot.model_copy(
                    update={
                        "stream": StreamInfo(
                            sequence=frame.id,
                            sample_ms=round(frame.sampled_in_ms, 2),
                            interval_s=self.interval,
                            subscribers=subscribers,
                            dropped=subscription.dropped,
                        )
                    }
                )
                if snapshot is not None
                else None
            ),
            sampled_in_ms=frame.sampled_in_ms,
            sampled_at=frame.sampled_at,
            error=frame.error,
        )
        queue = subscription.queue
        while True:
            try:
                queue.put_nowait(delivery)
                return
            except asyncio.QueueFull:
                # Drop the oldest frame: a live dashboard wants the newest
                # sample, never a growing backlog.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:  # pragma: no cover - single consumer
                    pass
                subscription.dropped += 1


def stream_headers() -> dict[str, str]:
    """Headers that keep SSE uncompressed and unbuffered behind proxies."""
    return {
        "Cache-Control": "no-cache, no-store, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
