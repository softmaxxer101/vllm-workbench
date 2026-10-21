"""Streaming proxy between the workbench UI / OpenAI clients and vLLM."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import AsyncIterator, Any

import httpx
from starlette.responses import JSONResponse, Response, StreamingResponse

from .config import Settings
from .errors import WorkbenchError
from .manager import VLLMProcessManager
from .metrics import MetricsService
from .schemas import ChatRequest, ChatMessage

logger = logging.getLogger("workbench.proxy")

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

_OOM_MARKERS = ("out of memory", "outofmemory", "cuda error")


def estimate_tokens(messages: list[ChatMessage] | list[dict[str, Any]]) -> int:
    """Cheap character-based estimate — good enough for UI counters."""
    total = 0
    for message in messages:
        if isinstance(message, ChatMessage):
            content = message.content
        else:
            content = str(message.get("content") or "")
        total += len(content) / 3.8 + 4
    return max(1, int(total))


def _prompt_from_payload(payload: dict[str, Any]) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 1
    total = 0.0
    for item in messages:
        if isinstance(item, dict):
            content = item.get("content")
            if isinstance(content, str):
                total += len(content) / 3.8 + 4
            elif isinstance(content, list):
                total += len(json.dumps(content)) / 3.8 + 4
    return max(1, int(total))


class EngineProxy:
    def __init__(
        self, settings: Settings, manager: VLLMProcessManager, metrics: MetricsService
    ) -> None:
        self.settings = settings
        self.manager = manager
        self.metrics = metrics
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=10.0, read=None, write=60.0, pool=30.0
            ),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
            trust_env=False,
        )

    async def close(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ public
    async def chat_request(self, request: ChatRequest, *, source: str) -> Response:
        config = self.manager.config
        payload = request.to_upstream_payload(config.api_model_name, stream=request.stream)
        return await self._dispatch(
            payload,
            source=source,
            stream=request.stream,
            prompt_estimate=estimate_tokens(request.messages),
        )

    async def chat_raw(self, payload: dict[str, Any], *, source: str = "api") -> Response:
        """OpenAI-compatible entry point. Unknown fields are passed through untouched."""
        self._ensure_ready()
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            raise WorkbenchError(
                "`messages` must be a non-empty array.",
                status_code=422,
                code="invalid_messages",
            )
        for message in messages:
            if not isinstance(message, dict) or "role" not in message or "content" not in message:
                raise WorkbenchError(
                    "Each message needs a `role` and `content`.",
                    status_code=422,
                    code="invalid_messages",
                )

        stream = bool(payload.get("stream", False))
        normalized: dict[str, Any] = dict(payload)
        normalized["model"] = self.manager.config.api_model_name
        normalized["stream"] = stream
        if stream:
            options = normalized.get("stream_options")
            options = dict(options) if isinstance(options, dict) else {}
            options["include_usage"] = True
            normalized["stream_options"] = options

        return await self._dispatch(
            normalized,
            source=source,
            stream=stream,
            prompt_estimate=_prompt_from_payload(normalized),
            include_metrics=False,
        )

    async def complete(self, request: ChatRequest, *, source: str = "sweep") -> dict[str, Any]:
        """Run one streaming completion internally and return the aggregated result.

        Used by parameter sweeps so they get real TTFT/throughput numbers instead
        of estimates. Errors are raised as WorkbenchError for per-run isolation.
        """
        self._ensure_ready()
        config = self.manager.config
        payload = request.to_upstream_payload(config.api_model_name, stream=True)
        url = f"{self.manager.base_url}/v1/chat/completions"
        started = time.perf_counter()
        first_token_at: float | None = None
        last_token_at: float | None = None
        gaps: list[float] = []
        pieces: list[str] = []
        chunk_tokens = 0
        usage: dict[str, Any] = {}
        finish_reason: str | None = None
        params = {
            "temperature": payload.get("temperature"),
            "top_p": payload.get("top_p"),
            "top_k": payload.get("top_k"),
            "max_tokens": payload.get("max_tokens"),
            "repetition_penalty": payload.get("repetition_penalty"),
            "presence_penalty": payload.get("presence_penalty"),
            "frequency_penalty": payload.get("frequency_penalty"),
        }

        try:
            async with self._client.stream(
                "POST", url, json=payload, timeout=self.settings.request_timeout_s
            ) as upstream:
                if upstream.status_code >= 400:
                    body = (await upstream.aread()).decode("utf-8", errors="replace")
                    raise WorkbenchError(
                        self._body_message(body),
                        status_code=502,
                        code="engine_error",
                        hint=self._upstream_hint(body),
                    )
                async for line in upstream.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(parsed, dict):
                        continue
                    if parsed.get("usage"):
                        usage = parsed["usage"]
                    choices = parsed.get("choices") or []
                    if not choices or not isinstance(choices[0], dict):
                        continue
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content") or delta.get("reasoning_content") or ""
                    if choices[0].get("finish_reason"):
                        finish_reason = choices[0]["finish_reason"]
                    if text:
                        now = time.perf_counter()
                        if first_token_at is None:
                            first_token_at = now
                        elif last_token_at is not None:
                            gaps.append(now - last_token_at)
                        last_token_at = now
                        chunk_tokens += 1
                        pieces.append(str(text))
        except httpx.HTTPError as exc:
            self.metrics.record(
                source=source,
                model=config.api_model_name,
                stream=True,
                prompt_tokens=estimate_tokens(request.messages),
                completion_tokens=chunk_tokens,
                ttft_ms=None,
                latency_ms=(time.perf_counter() - started) * 1000,
                inter_token_ms=None,
                finish_reason=None,
                status="error",
                error=str(exc),
                parameters=params,  # type: ignore[arg-type]
            )
            raise WorkbenchError(
                "The connection to vLLM was interrupted.",
                status_code=503,
                code="engine_unreachable",
            ) from exc

        latency_ms = (time.perf_counter() - started) * 1000
        ttft_ms = (first_token_at - started) * 1000 if first_token_at else None
        completion_tokens = int(usage.get("completion_tokens") or chunk_tokens)
        prompt_tokens = int(usage.get("prompt_tokens") or estimate_tokens(request.messages))
        inter_token_ms = (sum(gaps) / len(gaps)) * 1000 if gaps else None
        self.metrics.record(
            source=source,
            model=config.api_model_name,
            stream=True,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ttft_ms=ttft_ms,
            latency_ms=latency_ms,
            inter_token_ms=inter_token_ms,
            finish_reason=finish_reason,
            status="ok",
            error=None,
            parameters=params,  # type: ignore[arg-type]
        )
        generation_ms = max(latency_ms - (ttft_ms or 0), 1)
        return {
            "text": "".join(pieces),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "ttft_ms": ttft_ms,
            "latency_ms": latency_ms,
            "inter_token_ms": inter_token_ms,
            "tokens_per_second": (
                completion_tokens / (generation_ms / 1000) if completion_tokens else None
            ),
            "finish_reason": finish_reason,
        }

    # ----------------------------------------------------------------- internal
    def _ensure_ready(self) -> None:
        state = self.manager.state
        if state == "running":
            return
        if state == "starting":
            raise WorkbenchError(
                "The model is still loading.",
                status_code=503,
                code="engine_starting",
                hint="Wait until the server status turns green, then send again.",
            )
        if state == "stopping":
            raise WorkbenchError(
                "The model server is shutting down.",
                status_code=503,
                code="engine_stopping",
                hint="Start the server again from the Server page.",
            )
        if state == "error":
            raise WorkbenchError(
                "The vLLM server is not running due to an error.",
                status_code=503,
                code="engine_error",
                hint="Open the Server page to see the error and restart the engine.",
            )
        raise WorkbenchError(
            "The vLLM server is not running.",
            status_code=503,
            code="engine_stopped",
            hint="Start the server from the Server page first.",
        )

    async def _dispatch(
        self,
        payload: dict[str, Any],
        *,
        source: str,
        stream: bool,
        prompt_estimate: int,
        include_metrics: bool = True,
    ) -> Response:
        self._ensure_ready()
        request_id = uuid.uuid4().hex[:16]
        params = {
            "temperature": payload.get("temperature"),
            "top_p": payload.get("top_p"),
            "top_k": payload.get("top_k"),
            "max_tokens": payload.get("max_tokens"),
            "repetition_penalty": payload.get("repetition_penalty"),
            "presence_penalty": payload.get("presence_penalty"),
            "frequency_penalty": payload.get("frequency_penalty"),
        }
        url = f"{self.manager.base_url}/v1/chat/completions"
        started = time.perf_counter()
        if stream:
            return StreamingResponse(
                self._stream(
                    url,
                    payload,
                    source=source,
                    request_id=request_id,
                    started=started,
                    prompt_estimate=prompt_estimate,
                    params=params,
                    include_metrics=include_metrics,
                ),
                media_type="text/event-stream",
                headers={**SSE_HEADERS, "X-Request-Id": request_id},
            )

        try:
            response = await self._client.post(url, json=payload, timeout=self.settings.request_timeout_s)
        except httpx.ConnectError as exc:
            self._record_error(
                source, request_id, prompt_estimate, started, params, "Cannot reach vLLM.", 0
            )
            raise WorkbenchError(
                "Could not connect to the vLLM server.",
                status_code=503,
                code="engine_unreachable",
                hint="The process may have just crashed. Refresh the server status and restart.",
            ) from exc
        except httpx.TimeoutException as exc:
            self._record_error(
                source, request_id, prompt_estimate, started, params, "Request timed out.", 0
            )
            raise WorkbenchError(
                "vLLM timed out while generating a response.",
                status_code=504,
                code="engine_timeout",
                hint="Lower max tokens or reduce the prompt size, then try again.",
            ) from exc

        if response.status_code >= 400:
            hint = self._upstream_hint(response.text)
            message = self._upstream_message(response)
            self._record_error(source, request_id, prompt_estimate, started, params, message, 0)
            raise WorkbenchError(
                message,
                status_code=502 if response.status_code >= 500 else response.status_code,
                code="engine_error",
                hint=hint,
                details=self._safe_body(response),
            )

        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            self._record_error(
                source, request_id, prompt_estimate, started, params, "Malformed vLLM response.", 0
            )
            raise WorkbenchError(
                "vLLM returned a malformed response.",
                status_code=502,
                code="engine_bad_response",
            ) from exc

        usage = data.get("usage") or {}
        completion_tokens = int(usage.get("completion_tokens") or 0)
        latency_ms = (time.perf_counter() - started) * 1000
        finish_reason = None
        try:
            finish_reason = data["choices"][0].get("finish_reason")
        except (KeyError, IndexError, TypeError):
            pass
        self.metrics.record(
            source=source,
            model=self.manager.config.api_model_name,
            stream=False,
            prompt_tokens=int(usage.get("prompt_tokens") or prompt_estimate),
            completion_tokens=completion_tokens,
            ttft_ms=None,
            latency_ms=latency_ms,
            inter_token_ms=None,
            finish_reason=finish_reason,
            status="ok",
            error=None,
            parameters=params,  # type: ignore[arg-type]
        )
        return JSONResponse(
            content=data,
            headers={
                "X-Request-Id": request_id,
                "Cache-Control": "no-store",
            },
        )

    async def _stream(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        source: str,
        request_id: str,
        started: float,
        prompt_estimate: int,
        params: dict[str, Any],
        include_metrics: bool,
    ) -> AsyncIterator[bytes]:
        first_token_at: float | None = None
        last_token_at: float | None = None
        token_gaps: list[float] = []
        chunk_tokens = 0
        usage: dict[str, Any] = {}
        finish_reason: str | None = None
        status = "ok"
        error_message: str | None = None
        finalized = False

        def finalize() -> dict[str, Any]:
            nonlocal finalized
            latency_ms = (time.perf_counter() - started) * 1000
            ttft_ms = (
                (first_token_at - started) * 1000 if first_token_at is not None else None
            )
            completion_tokens = int(usage.get("completion_tokens") or chunk_tokens)
            prompt_tokens = int(usage.get("prompt_tokens") or prompt_estimate)
            inter_token_ms = (
                (sum(token_gaps) / len(token_gaps)) * 1000 if token_gaps else None
            )
            generation_ms = max(latency_ms - (ttft_ms or 0), 1)
            data = {
                "request_id": request_id,
                "ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
                "latency_ms": round(latency_ms, 2),
                "inter_token_ms": (
                    round(inter_token_ms, 2) if inter_token_ms is not None else None
                ),
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "tokens_per_second": (
                    round(completion_tokens / (generation_ms / 1000), 2)
                    if completion_tokens
                    else None
                ),
                "finish_reason": finish_reason,
                "status": status,
            }
            if not finalized:
                finalized = True
                self.metrics.record(
                    source=source,
                    model=self.manager.config.api_model_name,
                    stream=True,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    ttft_ms=ttft_ms,
                    latency_ms=latency_ms,
                    inter_token_ms=inter_token_ms,
                    finish_reason=finish_reason,
                    status=status,
                    error=error_message,
                    parameters=params,  # type: ignore[arg-type]
                )
            return data

        try:
            async with self._client.stream(
                "POST", url, json=payload, timeout=self.settings.request_timeout_s
            ) as upstream:
                if upstream.status_code >= 400:
                    body = (await upstream.aread()).decode("utf-8", errors="replace")
                    message = self._body_message(body)
                    status = "error"
                    error_message = message
                    logger.warning(
                        "vLLM stream rejected (%s): %s", upstream.status_code, message
                    )
                    yield self._sse_error(message, self._upstream_hint(body), request_id)
                    return

                async for line in upstream.aiter_lines():
                    if line == "":
                        yield b"\n"
                        continue
                    if not line.startswith("data:"):
                        yield (line + "\n").encode()
                        continue

                    data = line[5:].strip()
                    if data == "[DONE]":
                        metrics = finalize()
                        if include_metrics:
                            yield self._sse_event("workbench.metrics", metrics)
                        yield b"data: [DONE]\n\n"
                        return

                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        yield (line + "\n").encode()
                        continue

                    if isinstance(parsed, dict):
                        if parsed.get("usage"):
                            usage = parsed["usage"]
                        choices = parsed.get("choices") or []
                        if choices and isinstance(choices[0], dict):
                            delta = choices[0].get("delta") or {}
                            text = delta.get("content") or delta.get("reasoning_content")
                            choice_finish = choices[0].get("finish_reason")
                            if choice_finish:
                                finish_reason = choice_finish
                            if isinstance(text, str) and text:
                                now = time.perf_counter()
                                if first_token_at is None:
                                    first_token_at = now
                                elif last_token_at is not None:
                                    token_gaps.append(now - last_token_at)
                                last_token_at = now
                                chunk_tokens += 1
                        if parsed.get("error"):
                            status = "error"
                            error_message = str(
                                (parsed.get("error") or {}).get("message") or parsed["error"]
                            )
                    yield (line + "\n").encode()

            metrics = finalize()
            if include_metrics:
                yield self._sse_event("workbench.metrics", metrics)
            yield b"data: [DONE]\n\n"
        except asyncio.CancelledError:
            status = status if status == "error" else "aborted"
            finalize()
            raise
        except httpx.HTTPError as exc:
            status = "error"
            error_message = str(exc)
            logger.warning("Streaming proxy error: %s", exc)
            finalize()
            yield self._sse_error(
                "The connection to vLLM was interrupted.",
                "The engine may have crashed. Check the Server page and restart it.",
                request_id,
            )
        except Exception as exc:  # pragma: no cover - defensive
            status = "error"
            error_message = str(exc)
            logger.exception("Unexpected streaming error")
            finalize()
            yield self._sse_error(
                "Streaming failed unexpectedly.", str(exc), request_id
            )
        finally:
            if not finalized:
                finalize()

    # ------------------------------------------------------------------ helpers
    def _record_error(
        self,
        source: str,
        request_id: str,
        prompt_estimate: int,
        started: float,
        params: dict[str, Any],
        message: str,
        completion_tokens: int,
    ) -> None:
        self.metrics.record(
            source=source,
            model=self.manager.config.api_model_name,
            stream=False,
            prompt_tokens=prompt_estimate,
            completion_tokens=completion_tokens,
            ttft_ms=None,
            latency_ms=(time.perf_counter() - started) * 1000,
            inter_token_ms=None,
            finish_reason=None,
            status="error",
            error=message,
            parameters=params,  # type: ignore[arg-type]
        )
        logger.warning("Request %s failed: %s", request_id, message)

    @staticmethod
    def _safe_body(response: httpx.Response) -> Any:
        try:
            body = response.json()
            if isinstance(body, dict):
                return body.get("error", body)
        except (json.JSONDecodeError, ValueError):
            pass
        return response.text[:500]

    def _upstream_message(self, response: httpx.Response) -> str:
        try:
            body = response.json()
            if isinstance(body, dict):
                error = body.get("error")
                if isinstance(error, dict) and error.get("message"):
                    return str(error["message"])
                if body.get("message"):
                    return str(body["message"])
                if isinstance(error, str):
                    return error
            return f"vLLM returned HTTP {response.status_code}."
        except (json.JSONDecodeError, ValueError):
            return self._body_message(response.text)

    @staticmethod
    def _body_message(body: str) -> str:
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                error = parsed.get("error")
                if isinstance(error, dict) and error.get("message"):
                    return str(error["message"])
                if isinstance(error, str):
                    return error
                if parsed.get("message"):
                    return str(parsed["message"])
        except json.JSONDecodeError:
            pass
        text = body.strip().replace("\n", " ")
        return text[:400] if text else "vLLM rejected the request."

    @staticmethod
    def _upstream_hint(body: str) -> str | None:
        lowered = body.lower()
        if any(marker in lowered for marker in _OOM_MARKERS):
            return (
                "The GPU ran out of memory. Lower max tokens, shorten the conversation, or "
                "restart vLLM with a lower GPU memory utilization."
            )
        if "maximum context length" in lowered or "context length" in lowered:
            return (
                "The conversation is longer than the model's context window. Clear the chat or "
                "raise max_model_len and restart the server."
            )
        if "model" in lowered and ("not found" in lowered or "does not exist" in lowered):
            return "The selected model is not loaded. Restart the server with the right model id."
        return None

    @staticmethod
    def _sse_event(event: str, data: dict[str, Any]) -> bytes:
        return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()

    @staticmethod
    def _sse_error(message: str, hint: str | None, request_id: str) -> bytes:
        payload = {
            "error": {
                "message": message,
                "hint": hint,
                "type": "engine_error",
                "request_id": request_id,
            }
        }
        return f"event: error\ndata: {json.dumps(payload)}\n\n".encode()

