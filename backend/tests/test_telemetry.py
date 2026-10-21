"""Telemetry hub behaviour: one sampler, many subscribers, no head-of-line blocking."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.schemas import (
    MetricsSnapshot,
    MetricsSummary,
    ServerStatus,
    VLLMMetrics,
)
from app.telemetry import TelemetryHub


class FakeManager:
    def status(self) -> ServerStatus:
        return ServerStatus(state="running", model="fake/model", healthy=True)


class CountingMetrics:
    """Snapshot source that records how often it is scraped."""

    def __init__(self, delay: float = 0.01) -> None:
        self.calls = 0
        self.delay = delay

    async def snapshot(self, server: ServerStatus) -> MetricsSnapshot:
        self.calls += 1
        await asyncio.sleep(self.delay)
        return MetricsSnapshot(
            timestamp=datetime.now(timezone.utc),
            server=server,
            vllm=VLLMMetrics(),
            summary=MetricsSummary(
                requests=0,
                successes=0,
                errors=0,
                prompt_tokens=0,
                completion_tokens=0,
            ),
        )


class BrokenMetrics:
    async def snapshot(self, server: ServerStatus) -> MetricsSnapshot:
        raise RuntimeError("prometheus is down")


@pytest.mark.asyncio
async def test_one_sampler_serves_every_subscriber() -> None:
    service = CountingMetrics()
    hub = TelemetryHub(service, FakeManager(), interval=0.05)  # type: ignore[arg-type]
    subscriptions = [await hub.subscribe(interval=0.05) for _ in range(4)]

    await asyncio.sleep(0.28)
    delivered = [sub.queue.qsize() for sub in subscriptions]

    stats = hub.stats()
    assert stats["running"] is True
    assert stats["subscribers"] == 4
    assert stats["frames"] == service.calls
    # Scrapes track elapsed time, not the number of listeners.
    assert service.calls <= 6
    assert all(count >= 1 for count in delivered)

    await hub.close()
    assert hub.stats()["running"] is False


@pytest.mark.asyncio
async def test_frames_share_a_sequence_and_carry_stream_metadata() -> None:
    hub = TelemetryHub(CountingMetrics(), FakeManager(), interval=0.05)  # type: ignore[arg-type]
    first = await hub.subscribe(interval=0.05)
    second = await hub.subscribe(interval=0.05)

    frame_a = await asyncio.wait_for(hub.next_frame(first), timeout=2)
    frame_b = await asyncio.wait_for(hub.next_frame(second), timeout=2)

    assert frame_a.snapshot is not None
    assert frame_b.snapshot is not None
    assert frame_a.snapshot.stream is not None
    assert frame_a.snapshot.stream.sequence == frame_a.id
    assert frame_a.snapshot.stream.subscribers == 2
    assert frame_a.snapshot.stream.interval_s == 0.05
    assert frame_a.snapshot.stream.sample_ms >= 0
    # Both listeners render the same sample, not two independent scrapes.
    assert frame_a.snapshot.timestamp == frame_b.snapshot.timestamp

    await hub.close()


@pytest.mark.asyncio
async def test_matching_cadence_does_not_skip_every_other_frame() -> None:
    """A 1 Hz subscriber on a 1 Hz sampler must see every frame.

    Scheduling jitter used to make a tick land a fraction of a millisecond
    before the subscriber's next deadline, so it was skipped and clients saw
    alternating 1s/2s gaps (an apparent 1.5s cadence).
    """
    hub = TelemetryHub(CountingMetrics(delay=0.0), FakeManager(), interval=0.05, queue_size=64)  # type: ignore[arg-type]
    subscription = await hub.subscribe(interval=0.05)

    await asyncio.sleep(0.5)
    samples = hub.stats()["samples"]
    assert samples >= 8
    assert subscription.queue.qsize() >= samples - 1

    await hub.close()


@pytest.mark.asyncio
async def test_slow_subscriber_drops_frames_without_blocking_others() -> None:
    hub = TelemetryHub(CountingMetrics(), FakeManager(), interval=0.02, queue_size=2)  # type: ignore[arg-type]
    slow = await hub.subscribe(interval=0.02)
    fast = await hub.subscribe(interval=0.02)

    # The fast client drains, the slow one never reads. The sampler must keep
    # ticking and the slow queue must stay bounded.
    for _ in range(6):
        await asyncio.wait_for(hub.next_frame(fast), timeout=2)

    assert slow.queue.qsize() <= 2
    stats = hub.stats()
    assert stats["frames"] >= 6
    assert stats["subscribers"] == 2

    await hub.close()


@pytest.mark.asyncio
async def test_sampler_stops_when_the_last_subscriber_leaves() -> None:
    service = CountingMetrics()
    hub = TelemetryHub(service, FakeManager(), interval=0.05)  # type: ignore[arg-type]
    left = await hub.subscribe(interval=0.05)
    right = await hub.subscribe(interval=0.05)

    await asyncio.sleep(0.12)
    await hub.unsubscribe(left)
    assert hub.stats()["subscribers"] == 1
    assert hub.stats()["running"] is True

    await hub.unsubscribe(right)
    assert hub.stats()["subscribers"] == 0
    assert hub.stats()["running"] is False

    settled = service.calls
    await asyncio.sleep(0.15)
    assert service.calls == settled

    await hub.close()


@pytest.mark.asyncio
async def test_scrape_failure_emits_an_error_frame_and_keeps_streaming() -> None:
    hub = TelemetryHub(BrokenMetrics(), FakeManager(), interval=0.05)  # type: ignore[arg-type]
    subscription = await hub.subscribe(interval=0.05)

    frame = await asyncio.wait_for(hub.next_frame(subscription), timeout=2)
    assert frame.error is not None
    assert "prometheus is down" in frame.error
    assert frame.snapshot is None
    assert hub.stats()["failures"] >= 1
    assert hub.stats()["running"] is True

    await hub.close()
