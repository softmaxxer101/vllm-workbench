"""Live metrics endpoints.

Two transports share one collector:

* `GET /api/metrics` returns a single snapshot for first paint, polling
  fallbacks and scripts;
* `GET /api/metrics/stream` upgrades to Server-Sent Events and pushes the
  snapshots produced by the shared `TelemetryHub` sampler.

The stream is deliberately boring where it matters: one sampler per process,
monotonic frame ids, keep-alive comments on idle, bounded per-client queues, and
a `retry:` hint so the browser reconnects on its own after a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import StreamingResponse

from ..manager import VLLMProcessManager
from ..metrics import MetricsService
from ..schemas import MetricsSnapshot, RequestMetric
from ..telemetry import SSE_HEARTBEAT_S, TelemetryHub, stream_headers
from .deps import get_hub, get_manager, get_metrics

logger = logging.getLogger("workbench.api.metrics")
router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("", response_model=MetricsSnapshot)
async def metrics_snapshot(
    manager: VLLMProcessManager = Depends(get_manager),
    metrics: MetricsService = Depends(get_metrics),
) -> MetricsSnapshot:
    return await metrics.snapshot(manager.status())


@router.get("/requests", response_model=list[RequestMetric])
async def request_history(
    limit: int = Query(default=50, ge=1, le=500),
    metrics: MetricsService = Depends(get_metrics),
) -> list[RequestMetric]:
    return metrics.recent(limit)


@router.get("/stream")
async def stream_metrics(
    request: Request,
    interval: float = Query(
        default=1.0,
        ge=0.25,
        le=10.0,
        description="Minimum seconds between frames for this client.",
    ),
    hub: TelemetryHub = Depends(get_hub),
) -> StreamingResponse:
    """Push shared telemetry frames over SSE.

    The hub samples at its own fixed cadence (1 Hz); `interval` only throttles
    delivery to a slower client, so ten tabs cost the engine exactly one scrape
    per second. Frames are full snapshots, which makes reconnects idempotent:
    `Last-Event-ID` is honoured to avoid replaying a frame the client already
    rendered.
    """

    try:
        last_event_id = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        last_event_id = 0

    subscription = await hub.subscribe(interval=interval)

    async def events() -> AsyncIterator[bytes]:
        yield b"retry: 2000\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(
                        hub.next_frame(subscription), timeout=SSE_HEARTBEAT_S
                    )
                except asyncio.TimeoutError:
                    if not hub.running:
                        # The sampler died; end the response so the browser's
                        # EventSource reconnects instead of waiting forever.
                        logger.warning("Telemetry sampler stopped; closing stream")
                        break
                    yield _comment(
                        f"keep-alive {datetime.now(timezone.utc).isoformat()}"
                    )
                    continue

                if frame.id <= last_event_id:
                    continue
                if frame.error is not None or frame.snapshot is None:
                    logger.warning("Telemetry sample failed: %s", frame.error)
                    yield _event(
                        "telemetry.error",
                        {
                            "sequence": frame.id,
                            "message": "Telemetry snapshot failed.",
                            "detail": frame.error,
                        },
                        frame.id,
                    )
                    continue
                yield _event(
                    "telemetry",
                    frame.snapshot.model_dump(mode="json"),
                    frame.id,
                )
        finally:
            await hub.unsubscribe(subscription)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers=stream_headers(),
    )


@router.get("/stream/stats")
async def stream_stats(hub: TelemetryHub = Depends(get_hub)) -> dict:
    """Sampler diagnostics: subscribers, cadence, scrape duration, failures."""
    return hub.stats()


@router.delete("", status_code=204)
async def clear_metrics(metrics: MetricsService = Depends(get_metrics)) -> None:
    metrics.clear()


@router.get("/live")
async def live_metrics(
    manager: VLLMProcessManager = Depends(get_manager),
    metrics: MetricsService = Depends(get_metrics),
    hub: TelemetryHub = Depends(get_hub),
) -> dict:
    """Small payload for frequent polling by the header/status widgets."""
    vllm = await metrics.prometheus.scrape() if manager.state == "running" else None
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": manager.state,
        "gpu": (await metrics.gpus())[:1],
        "tokens_per_second": vllm.rates.generation_tokens_per_second if vllm else None,
        "running_requests": vllm.gauges.running_requests if vllm else None,
        "waiting_requests": vllm.gauges.waiting_requests if vllm else None,
        "kv_cache_usage": vllm.gauges.kv_cache_usage if vllm else None,
        "stream": hub.stats(),
    }


def _event(event: str, payload: dict, sequence: int) -> bytes:
    data = json.dumps(payload, separators=(",", ":"))
    return f"id: {sequence}\nevent: {event}\ndata: {data}\n\n".encode()


def _comment(text: str) -> bytes:
    return f": {text}\n\n".encode()
