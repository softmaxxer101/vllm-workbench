"""Development-only mock of the vLLM OpenAI server.

The workbench talks to it exactly like vLLM: /health, /v1/models,
/v1/chat/completions (streaming and non-streaming) and /metrics in Prometheus
text format. It is only launched when WORKBENCH_VLLM_MOCK=1, which keeps the UI
and the proxy fully testable on machines without a GPU.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

app = FastAPI(title="Mock vLLM engine")

MODEL = "mock-model"
MAX_MODEL_LEN = 4096
SERVED_NAME = MODEL

_STATE = {
    "running": 0,
    "waiting": 0,
    "prompt_tokens": 0,
    "generation_tokens": 0,
    "ttft_count": 0,
    "ttft_sum": 0.0,
    "itl_count": 0,
    "itl_sum": 0.0,
    "ttft_buckets": {0.01: 0, 0.05: 0, 0.1: 0, 0.25: 0, 0.5: 0, 1.0: 0, 2.5: 0},
    "itl_buckets": {0.005: 0, 0.01: 0, 0.02: 0, 0.05: 0, 0.1: 0, 0.25: 0},
}
_STARTED = time.time()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "model": MODEL}


@app.get("/v1/models")
async def models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": SERVED_NAME,
                "object": "model",
                "created": int(_STARTED),
                "owned_by": "mock-vllm",
            }
        ],
    }


def _last_user_text(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _build_answer(prompt: str, temperature: float, max_tokens: int) -> list[str]:
    clean = " ".join(prompt.split())[:280]
    intro = (
        "This is a simulated response from the vLLM Workbench demo engine. "
        "No GPU is being used — start the real vLLM server on the Server page "
        "to run an actual model."
    )
    detail = (
        f'You asked: "{clean}". A production vLLM deployment would now stream the '
        "model's actual tokens through the same SSE pipeline you are reading right now. "
        "Try the live parameter controls, compare two configurations side by side, or run "
        "a temperature sweep to see the metrics dashboard react."
    )
    closing = (
        "When the real engine is running, this panel shows the same layout with generation "
        "latency, time-to-first-token and throughput measured from your hardware."
    )
    pool = (intro + " " + detail + " " + closing).split()
    words = pool[: max(8, min(max_tokens, len(pool)))]
    # A gentle temperature-dependent flourish keeps sweep results distinguishable.
    if temperature >= 1.2:
        words = [word + ("!" if index % 9 == 0 else "") for index, word in enumerate(words)]
    elif temperature == 0:
        words = words[: max(8, len(words) - 12)]
    if random.random() < 0.15:
        words = [word.upper() if index % 17 == 0 else word for index, word in enumerate(words)]
    return words


async def _stream_chat(payload: dict) -> StreamingResponse:
    messages = payload.get("messages") or []
    prompt = _last_user_text(messages)
    max_tokens = int(payload.get("max_tokens") or 256)
    temperature = float(payload.get("temperature") or 0.7)
    words = _build_answer(prompt, temperature, max_tokens)
    request_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())
    prompt_tokens = max(1, len(prompt) // 4)
    _STATE["prompt_tokens"] += prompt_tokens
    _STATE["running"] += 1

    async def events():
        try:
            await asyncio.sleep(0.12)
            first = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": SERVED_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": ""},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(first)}\n\n"
            ttft = 0.12 + random.uniform(0.01, 0.06)
            _STATE["ttft_count"] += 1
            _STATE["ttft_sum"] += ttft
            for limit in _STATE["ttft_buckets"]:
                if ttft <= limit:
                    _STATE["ttft_buckets"][limit] += 1

            generated = 0
            for index, word in enumerate(words):
                await asyncio.sleep(0.018 + random.uniform(0.0, 0.01))
                generated += 1
                _STATE["generation_tokens"] += 1
                itl = 0.018
                _STATE["itl_count"] += 1
                _STATE["itl_sum"] += itl
                for limit in _STATE["itl_buckets"]:
                    if itl <= limit:
                        _STATE["itl_buckets"][limit] += 1
                content = word + (" " if index < len(words) - 1 else "")
                chunk = {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": SERVED_NAME,
                    "choices": [
                        {"index": 0, "delta": {"content": content}, "finish_reason": None}
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n"

            final = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": SERVED_NAME,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(final)}\n\n"
            usage = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": SERVED_NAME,
                "choices": [],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": generated,
                    "total_tokens": prompt_tokens + generated,
                },
            }
            yield f"data: {json.dumps(usage)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            _STATE["running"] = max(0, _STATE["running"] - 1)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    payload = await request.json()
    if payload.get("stream"):
        return await _stream_chat(payload)
    messages = payload.get("messages") or []
    prompt = _last_user_text(messages)
    max_tokens = int(payload.get("max_tokens") or 256)
    temperature = float(payload.get("temperature") or 0.7)
    words = _build_answer(prompt, temperature, max_tokens)
    await asyncio.sleep(0.25)
    prompt_tokens = max(1, len(prompt) // 4)
    _STATE["prompt_tokens"] += prompt_tokens
    _STATE["generation_tokens"] += len(words)
    _STATE["ttft_count"] += 1
    _STATE["ttft_sum"] += 0.25
    for limit in _STATE["ttft_buckets"]:
        if 0.25 <= limit:
            _STATE["ttft_buckets"][limit] += 1
    return JSONResponse(
        {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": SERVED_NAME,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": " ".join(words)},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": len(words),
                "total_tokens": prompt_tokens + len(words),
            },
        }
    )


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    lines: list[str] = []

    def gauge(name: str, value: float) -> None:
        lines.append(f"# HELP {name} mock gauge")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")

    gauge("vllm:num_requests_running", _STATE["running"])
    gauge("vllm:num_requests_waiting", _STATE["waiting"])
    gauge("vllm:kv_cache_usage_perc", round(0.08 + _STATE["running"] * 0.05, 3))
    gauge("vllm:engine_sleep_state", 1 if _STATE["running"] == 0 else 0)

    for name, key in (
        ("vllm:prompt_tokens", "prompt_tokens"),
        ("vllm:generation_tokens", "generation_tokens"),
    ):
        lines.append(f"# TYPE {name} counter")
        lines.append(f"{name}{{model_name=\"{MODEL}\"}} {_STATE[key]}")

    lines.append("# TYPE vllm:prefix_cache_queries counter")
    lines.append(f'vllm:prefix_cache_queries{{model_name="{MODEL}"}} 12')
    lines.append("# TYPE vllm:prefix_cache_hits counter")
    lines.append(f'vllm:prefix_cache_hits{{model_name="{MODEL}"}} 3')

    for base, count_key, sum_key, buckets in (
        (
            "vllm:time_to_first_token_seconds",
            "ttft_count",
            "ttft_sum",
            _STATE["ttft_buckets"],
        ),
        (
            "vllm:inter_token_latency_seconds",
            "itl_count",
            "itl_sum",
            _STATE["itl_buckets"],
        ),
    ):
        lines.append(f"# TYPE {base} histogram")
        for le, count in buckets.items():
            lines.append(
                f'{base}_bucket{{model_name="{MODEL}",le="{le}"}} {count}'
            )
        lines.append(f'{base}_bucket{{model_name="{MODEL}",le="+Inf"}} {_STATE[count_key]}')
        lines.append(f'{base}_sum{{model_name="{MODEL}"}} {round(_STATE[sum_key], 6)}')
        lines.append(f'{base}_count{{model_name="{MODEL}"}} {_STATE[count_key]}')

    return PlainTextResponse(
        "\n".join(lines) + "\n",
        headers={"Content-Type": "text/plain; version=0.0.4"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Mock vLLM engine")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="mock-model")
    parser.add_argument("--max-model-len", type=int, default=4096)
    parser.add_argument("--served-model-name", default=None)
    args = parser.parse_args()

    global MODEL, MAX_MODEL_LEN, SERVED_NAME
    MODEL = args.model
    MAX_MODEL_LEN = args.max_model_len
    SERVED_NAME = args.served_model_name or args.model.rsplit("/", 1)[-1]
    print(
        f"[mock-vllm] {datetime.now(timezone.utc).isoformat()} starting mock engine "
        f"for {MODEL} (served as {SERVED_NAME}) on {args.host}:{args.port}",
        flush=True,
    )
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
