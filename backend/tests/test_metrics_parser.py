from __future__ import annotations

import pytest

from app.metrics import _histogram_quantiles, _parse_prometheus, _sum_any


PROM_TEXT = """# HELP vllm:num_requests_running running
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="m"} 2
vllm:num_requests_waiting{engine="0"} 5
vllm:kv_cache_usage_perc{engine="0"} 0.42
vllm:generation_tokens{model_name="m"} 1000
vllm:prompt_tokens{model_name="m"} 250
vllm:time_to_first_token_seconds_bucket{le="0.05"} 5
vllm:time_to_first_token_seconds_bucket{le="0.1"} 8
vllm:time_to_first_token_seconds_bucket{le="0.5"} 9
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 10
vllm:time_to_first_token_seconds_sum 0.73
vllm:time_to_first_token_seconds_count 10
"""


def test_parse_and_sum() -> None:
    samples = _parse_prometheus(PROM_TEXT)
    assert len(samples) == 11
    assert _sum_any(samples, ["vllm:num_requests_running"]) == 2
    assert _sum_any(samples, ["vllm:prompt_tokens", "vllm:prompt_tokens_total"]) == 250


def test_histogram_quantiles() -> None:
    samples = _parse_prometheus(PROM_TEXT)
    p50, p95, mean = _histogram_quantiles(samples, "vllm:time_to_first_token_seconds")
    assert p50 == pytest.approx(50)
    assert p95 == pytest.approx(500)
    assert mean == pytest.approx(73)
