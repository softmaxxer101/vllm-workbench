"""Metrics collection.

Two complementary sources:

* per-request measurements taken by the streaming proxy (TTFT, inter-token
  latency, throughput) — accurate for what the workbench itself sends;
* vLLM's Prometheus endpoint plus `nvidia-smi` for engine/GPU state.

Everything degrades gracefully: if vLLM is stopped or `/metrics` is missing,
the snapshot reports `available: false` instead of failing.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Iterable

import httpx

from .config import Settings
from .schemas import (
    GPUMetric,
    MetricsSnapshot,
    MetricsSummary,
    RequestMetric,
    SeriesPoint,
    ServerStatus,
    VLLMCounterRates,
    VLLMGauges,
    VLLMLatencies,
    VLLMMetrics,
)

logger = logging.getLogger("workbench.metrics")

_SAMPLE_RE = re.compile(
    r"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?P<labels>.*?)\})?\s+(?P<value>[^\s]+)$"
)
_LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def _parse_prometheus(text: str) -> list[tuple[str, dict[str, str], float]]:
    samples: list[tuple[str, dict[str, str], float]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = _SAMPLE_RE.match(line)
        if not match:
            continue
        try:
            value = float(match.group("value"))
        except ValueError:
            continue
        labels = dict(_LABEL_RE.findall(match.group("labels") or ""))
        samples.append((match.group("name"), labels, value))
    return samples


def _sum_any(
    samples: Iterable[tuple[str, dict[str, str], float]], names: list[str]
) -> float | None:
    """Sum a metric across label sets, preferring the first matching name."""
    by_name: dict[str, float] = {}
    for name, _labels, value in samples:
        if name in names:
            by_name[name] = by_name.get(name, 0.0) + value
    for name in names:
        if name in by_name:
            return by_name[name]
    return None


def _histogram_quantiles(
    samples: Iterable[tuple[str, dict[str, str], float]], base: str
) -> tuple[float | None, float | None, float | None]:
    """Return (p50, p95, mean) in milliseconds from Prometheus histogram buckets."""
    sum_value: float | None = None
    count_value: float | None = None
    buckets: dict[float, float] = {}
    for name, labels, value in samples:
        if name == f"{base}_sum":
            sum_value = (sum_value or 0.0) + value
        elif name == f"{base}_count":
            count_value = (count_value or 0.0) + value
        elif name == f"{base}_bucket":
            raw_le = labels.get("le")
            if raw_le is None:
                continue
            try:
                le = float(raw_le)
            except ValueError:
                continue
            buckets[le] = buckets.get(le, 0.0) + value

    if not count_value:
        return None, None, None

    def quantile(q: float) -> float | None:
        threshold = q * count_value
        last_finite: float | None = None
        for le in sorted(buckets):
            if le == float("inf"):
                continue
            last_finite = le
            if buckets[le] >= threshold:
                return le * 1000
        # The quantile sits in the +Inf bucket; the highest finite bound is the
        # closest honest approximation available from bucket data.
        return last_finite * 1000 if last_finite is not None else None

    mean_ms = (sum_value / count_value * 1000) if sum_value is not None else None
    return quantile(0.5), quantile(0.95), mean_ms


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(q * (len(ordered) - 1)))))
    return ordered[index]


class PrometheusPoller:
    """Scrapes vLLM's Prometheus endpoint and derives live token rates."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = httpx.AsyncClient(
            timeout=settings.metrics_scrape_timeout_s, trust_env=False
        )
        self._prev_generation: float | None = None
        self._prev_prompt: float | None = None
        self._prev_at: float | None = None
        self._rate_generation: float | None = None
        self._rate_prompt: float | None = None

    async def close(self) -> None:
        await self._client.aclose()

    def reset_rates(self) -> None:
        self._prev_generation = None
        self._prev_prompt = None
        self._prev_at = None
        self._rate_generation = None
        self._rate_prompt = None

    async def scrape(self) -> VLLMMetrics:
        started = time.monotonic()
        try:
            response = await self._client.get(f"{self.settings.vllm_base_url}/metrics")
            if response.status_code != 200:
                return VLLMMetrics()
            text = response.text
        except (httpx.HTTPError, OSError):
            return VLLMMetrics()

        samples = _parse_prometheus(text)
        if not samples:
            return VLLMMetrics()

        running = _sum_any(samples, ["vllm:num_requests_running"])
        waiting = _sum_any(samples, ["vllm:num_requests_waiting"])
        kv = _sum_any(samples, ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"])
        if kv is not None:
            kv = max(0.0, min(1.0, kv))
        awake = _sum_any(samples, ["vllm:engine_sleep_state"])
        gen_tokens = _sum_any(
            samples, ["vllm:generation_tokens", "vllm:generation_tokens_total"]
        )
        prompt_tokens = _sum_any(samples, ["vllm:prompt_tokens", "vllm:prompt_tokens_total"])

        now = time.monotonic()
        if gen_tokens is not None and prompt_tokens is not None:
            if (
                self._prev_at is not None
                and self._prev_generation is not None
                and now > self._prev_at
            ):
                elapsed = now - self._prev_at
                gen_delta = gen_tokens - self._prev_generation
                prompt_delta = prompt_tokens - self._prev_prompt  # type: ignore[operator]
                if gen_delta >= 0:
                    self._rate_generation = gen_delta / elapsed
                if prompt_delta >= 0:
                    self._rate_prompt = prompt_delta / elapsed
            self._prev_generation = gen_tokens
            self._prev_prompt = prompt_tokens
            self._prev_at = now

        ttft_p50, ttft_p95, _ = _histogram_quantiles(samples, "vllm:time_to_first_token_seconds")
        itl_p50, itl_p95, _ = _histogram_quantiles(
            samples, "vllm:inter_token_latency_seconds"
        )
        cache_hits = _sum_any(
            samples, ["vllm:prefix_cache_hits", "vllm:prefix_cache_hits_total"]
        )
        cache_queries = _sum_any(
            samples, ["vllm:prefix_cache_queries", "vllm:prefix_cache_queries_total"]
        )
        hit_rate = (
            max(0.0, min(1.0, cache_hits / cache_queries))
            if cache_hits is not None and cache_queries
            else None
        )

        logger.debug(
            "Scraped vLLM metrics in %.1f ms", (time.monotonic() - started) * 1000
        )
        return VLLMMetrics(
            available=True,
            gauges=VLLMGauges(
                running_requests=int(running) if running is not None else None,
                waiting_requests=int(waiting) if waiting is not None else None,
                kv_cache_usage=kv,
                engine_awake=(awake == 0.0) if awake is not None else None,
            ),
            rates=VLLMCounterRates(
                generation_tokens_per_second=(
                    round(self._rate_generation, 2)
                    if self._rate_generation is not None
                    else None
                ),
                prompt_tokens_per_second=(
                    round(self._rate_prompt, 2) if self._rate_prompt is not None else None
                ),
            ),
            latencies=VLLMLatencies(
                ttft_p50_ms=ttft_p50,
                ttft_p95_ms=ttft_p95,
                inter_token_p50_ms=itl_p50,
                inter_token_p95_ms=itl_p95,
            ),
            total_prompt_tokens=int(prompt_tokens) if prompt_tokens is not None else None,
            total_generation_tokens=int(gen_tokens) if gen_tokens is not None else None,
            prefix_cache_hit_rate=hit_rate,
        )


class MetricsService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.prometheus = PrometheusPoller(settings)
        self._requests: deque[RequestMetric] = deque(maxlen=settings.metrics_retention)
        self._gpu_cache: list[GPUMetric] = []
        self._gpu_cached_at: float = 0.0
        self._gpu_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Start the background GPU poller.

        `nvidia-smi` regularly takes 200-400 ms. Awaiting it inside the 1 Hz
        snapshot made frames arrive late and then early, which reads as a
        jittery stream. Probing on a separate loop keeps snapshot assembly in
        the low milliseconds and lets frames land on time.
        """
        if self._gpu_task is None or self._gpu_task.done():
            self._gpu_task = asyncio.create_task(self._refresh_gpus(), name="gpu-poller")

    async def _refresh_gpus(self) -> None:
        while True:
            try:
                if self.settings.gpu_probe:
                    self._gpu_cache = await self._probe_gpus()
                    self._gpu_cached_at = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - defensive
                logger.exception("GPU probe failed")
            await asyncio.sleep(5.0)

    async def close(self) -> None:
        task, self._gpu_task = self._gpu_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self.prometheus.close()

    # ----------------------------------------------------------- request stats
    def record(
        self,
        *,
        source: str,
        model: str,
        stream: bool,
        prompt_tokens: int,
        completion_tokens: int,
        ttft_ms: float | None,
        latency_ms: float,
        inter_token_ms: float | None,
        finish_reason: str | None,
        status: str,
        error: str | None,
        parameters: dict[str, float | int | str | None],
    ) -> RequestMetric:
        generation_ms = max(latency_ms - (ttft_ms or 0.0), 1.0)
        tokens_per_second = (
            completion_tokens / (generation_ms / 1000) if completion_tokens > 0 else None
        )
        metric = RequestMetric(
            id=f"req_{uuid.uuid4().hex[:12]}",
            created_at=datetime.now(timezone.utc),
            source=source,
            model=model,
            stream=stream,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ttft_ms=round(ttft_ms, 2) if ttft_ms is not None else None,
            latency_ms=round(latency_ms, 2),
            inter_token_ms=(
                round(inter_token_ms, 2) if inter_token_ms is not None else None
            ),
            tokens_per_second=(
                round(tokens_per_second, 2) if tokens_per_second is not None else None
            ),
            finish_reason=finish_reason,
            status=status,  # type: ignore[arg-type]
            error=error,
            parameters=parameters,
        )
        self._requests.append(metric)
        return metric

    def summary(self) -> MetricsSummary:
        requests = list(self._requests)
        if not requests:
            return MetricsSummary(
                requests=0,
                successes=0,
                errors=0,
                prompt_tokens=0,
                completion_tokens=0,
            )
        successes = [item for item in requests if item.status == "ok"]
        errors = [item for item in requests if item.status == "error"]
        ttfts = [item.ttft_ms for item in requests if item.ttft_ms is not None]
        throughput = [
            item.tokens_per_second
            for item in requests
            if item.tokens_per_second is not None and item.status == "ok"
        ]
        latencies = [item.latency_ms for item in requests if item.status == "ok"]
        return MetricsSummary(
            requests=len(requests),
            successes=len(successes),
            errors=len(errors),
            prompt_tokens=sum(item.prompt_tokens for item in requests),
            completion_tokens=sum(item.completion_tokens for item in requests),
            tokens_per_second=round(mean(throughput), 2) if throughput else None,
            avg_ttft_ms=round(mean(ttfts), 2) if ttfts else None,
            p50_ttft_ms=round(_percentile(ttfts, 0.5), 2) if ttfts else None,  # type: ignore[arg-type]
            p95_ttft_ms=round(_percentile(ttfts, 0.95), 2) if ttfts else None,  # type: ignore[arg-type]
            avg_latency_ms=round(mean(latencies), 2) if latencies else None,
        )

    def series(self, window_seconds: int = 1800, bucket_seconds: int = 30) -> list[SeriesPoint]:
        now = datetime.now(timezone.utc)
        start = now - timedelta(seconds=window_seconds)
        bucket_count = window_seconds // bucket_seconds
        buckets: list[list[RequestMetric]] = [[] for _ in range(bucket_count)]
        for metric in self._requests:
            if metric.created_at < start:
                continue
            offset = int((metric.created_at - start).total_seconds() // bucket_seconds)
            if 0 <= offset < bucket_count:
                buckets[offset].append(metric)

        points: list[SeriesPoint] = []
        for index, items in enumerate(buckets):
            timestamp = start + timedelta(seconds=(index + 1) * bucket_seconds)
            tps = [
                item.tokens_per_second
                for item in items
                if item.tokens_per_second is not None and item.status == "ok"
            ]
            ttfts = [item.ttft_ms for item in items if item.ttft_ms is not None]
            points.append(
                SeriesPoint(
                    timestamp=timestamp,
                    requests=len(items),
                    tokens=sum(item.completion_tokens for item in items),
                    errors=sum(1 for item in items if item.status == "error"),
                    avg_tokens_per_second=round(mean(tps), 2) if tps else None,
                    avg_ttft_ms=round(mean(ttfts), 2) if ttfts else None,  # type: ignore[arg-type]
                )
            )
        return points

    def recent(self, limit: int = 50) -> list[RequestMetric]:
        return list(self._requests)[-limit:][::-1]

    def clear(self) -> None:
        self._requests.clear()

    # ------------------------------------------------------------------ GPUs
    async def gpus(self, *, max_age: float = 3.0) -> list[GPUMetric]:
        if not self.settings.gpu_probe:
            return []
        if self._gpu_cache and time.monotonic() - self._gpu_cached_at < max_age:
            return self._gpu_cache
        # When the background poller owns the probe, read its cache even if it
        # is a few seconds old: a live snapshot must never wait on nvidia-smi.
        if self._gpu_task is not None and not self._gpu_task.done():
            return self._gpu_cache
        self._gpu_cache = await self._probe_gpus()
        self._gpu_cached_at = time.monotonic()
        return self._gpu_cache

    async def _probe_gpus(self) -> list[GPUMetric]:
        command = [
            "nvidia-smi",
            "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except (FileNotFoundError, OSError):
            return []
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=3.0)
        except asyncio.TimeoutError:
            process.kill()
            try:
                await process.wait()
            except Exception:
                pass
            return []

        gpus: list[GPUMetric] = []
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 6:
                continue

            def number(value: str) -> float | None:
                try:
                    return float(value)
                except ValueError:
                    return None

            gpus.append(
                GPUMetric(
                    index=int(number(parts[0]) or 0),
                    name=parts[1],
                    memory_used_mb=number(parts[2]),
                    memory_total_mb=number(parts[3]),
                    utilization_percent=number(parts[4]),
                    temperature_c=number(parts[5]),
                )
            )
        return gpus

    # --------------------------------------------------------------- snapshot
    async def snapshot(self, server: ServerStatus) -> MetricsSnapshot:
        vllm_task = (
            self.prometheus.scrape() if server.state == "running" else _empty_vllm()
        )
        vllm, gpus = await asyncio.gather(vllm_task, self.gpus())
        return MetricsSnapshot(
            timestamp=datetime.now(timezone.utc),
            server=server,
            vllm=vllm,
            gpus=gpus,
            summary=self.summary(),
            series=self.series(),
            recent=self.recent(100),
        )


async def _empty_vllm() -> VLLMMetrics:
    return VLLMMetrics()
