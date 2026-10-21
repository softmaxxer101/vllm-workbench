"""Parameter sweep execution."""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Depends
from pydantic import ValidationError

from ..config import Settings
from ..errors import WorkbenchError
from ..manager import VLLMProcessManager
from ..proxy import EngineProxy
from ..schemas import (
    ChatRequest,
    SweepBucket,
    SweepRequest,
    SweepResponse,
    SweepResult,
)
from .deps import get_manager, get_proxy, get_settings

logger = logging.getLogger("workbench.api.sweep")
router = APIRouter(prefix="/sweep", tags=["sweep"])

_INT_FIELDS = {"top_k", "max_tokens"}


@router.post("", response_model=SweepResponse)
async def run_sweep(
    payload: SweepRequest,
    manager: VLLMProcessManager = Depends(get_manager),
    proxy: EngineProxy = Depends(get_proxy),
    settings: Settings = Depends(get_settings),
) -> SweepResponse:
    if manager.state != "running":
        raise WorkbenchError(
            "Start the vLLM server before running a sweep.",
            status_code=503,
            code="engine_not_running",
        )

    total_runs = len(payload.values) * payload.runs_per_value
    if total_runs > settings.max_sweep_runs:
        raise WorkbenchError(
            f"This sweep would run {total_runs} generations, above the limit of "
            f"{settings.max_sweep_runs}.",
            status_code=422,
            code="sweep_too_large",
            hint="Reduce the number of values or runs per value.",
        )

    base = payload.sampling.model_dump()
    requests: list[tuple[float, int, ChatRequest]] = []
    for value in payload.values:
        if payload.parameter in _INT_FIELDS and not float(value).is_integer():
            raise WorkbenchError(
                f"`{payload.parameter}` needs whole numbers.",
                status_code=422,
                code="invalid_sweep_value",
            )
        field_value = int(value) if payload.parameter in _INT_FIELDS else value
        try:
            built = ChatRequest(
                messages=payload.messages,
                stream=True,
                source="sweep",
                **{**base, payload.parameter: field_value},
            )
        except ValidationError as exc:
            first = exc.errors()[0]
            raise WorkbenchError(
                f"Value {value:g} is invalid for {payload.parameter}.",
                status_code=422,
                code="invalid_sweep_value",
                hint=str(first.get("msg", "")),
            ) from exc
        for run in range(1, payload.runs_per_value + 1):
            requests.append((value, run, built))

    semaphore = asyncio.Semaphore(min(payload.concurrency, settings.max_concurrent_sweeps))
    started = time.perf_counter()

    async def execute(value: float, run: int, request: ChatRequest) -> SweepResult:
        async with semaphore:
            try:
                result = await proxy.complete(request, source="sweep")
                return SweepResult(
                    value=value,
                    run=run,
                    ok=True,
                    output=result["text"],
                    latency_ms=round(result["latency_ms"], 2),
                    ttft_ms=(
                        round(result["ttft_ms"], 2) if result["ttft_ms"] is not None else None
                    ),
                    completion_tokens=result["completion_tokens"],
                    tokens_per_second=(
                        round(result["tokens_per_second"], 2)
                        if result["tokens_per_second"] is not None
                        else None
                    ),
                    finish_reason=result["finish_reason"],
                )
            except WorkbenchError as exc:
                return SweepResult(
                    value=value, run=run, ok=False, error=exc.message, latency_ms=0
                )
            except Exception as exc:  # keep other runs alive
                logger.exception("Sweep run failed")
                return SweepResult(value=value, run=run, ok=False, error=str(exc), latency_ms=0)

    results = await asyncio.gather(*(execute(*item) for item in requests))
    duration_ms = (time.perf_counter() - started) * 1000

    buckets: list[SweepBucket] = []
    for value in payload.values:
        items = [item for item in results if item.value == value]
        ok_items = [item for item in items if item.ok]
        buckets.append(
            SweepBucket(
                value=value,
                runs=len(items),
                errors=sum(1 for item in items if not item.ok),
                avg_latency_ms=round(
                    sum(item.latency_ms for item in ok_items) / len(ok_items), 2
                )
                if ok_items
                else 0.0,
                avg_ttft_ms=(
                    round(
                        sum(item.ttft_ms for item in ok_items if item.ttft_ms is not None)
                        / max(1, sum(1 for item in ok_items if item.ttft_ms is not None)),
                        2,
                    )
                    if any(item.ttft_ms is not None for item in ok_items)
                    else None
                ),
                avg_tokens_per_second=(
                    round(
                        sum(
                            item.tokens_per_second
                            for item in ok_items
                            if item.tokens_per_second is not None
                        )
                        / max(
                            1,
                            sum(
                                1 for item in ok_items if item.tokens_per_second is not None
                            ),
                        ),
                        2,
                    )
                    if any(item.tokens_per_second is not None for item in ok_items)
                    else None
                ),
                avg_completion_tokens=round(
                    sum(item.completion_tokens for item in ok_items) / len(ok_items), 1
                )
                if ok_items
                else 0.0,
            )
        )

    return SweepResponse(
        parameter=payload.parameter,
        results=sorted(results, key=lambda item: (item.value, item.run)),
        buckets=buckets,
        duration_ms=round(duration_ms, 2),
    )
