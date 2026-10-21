"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Request

from ..config import Settings
from ..errors import WorkbenchError
from ..hf import HuggingFaceService
from ..manager import VLLMProcessManager
from ..metrics import MetricsService
from ..proxy import EngineProxy
from ..telemetry import TelemetryHub


def get_manager(request: Request) -> VLLMProcessManager:
    return request.app.state.manager


def get_metrics(request: Request) -> MetricsService:
    return request.app.state.metrics


def get_proxy(request: Request) -> EngineProxy:
    return request.app.state.proxy


def get_hub(request: Request) -> TelemetryHub:
    return request.app.state.telemetry


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_hf(request: Request) -> HuggingFaceService:
    return request.app.state.hf


async def enforce_body_limit(request: Request, limit_mb: int = 8) -> None:
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > limit_mb * 1024 * 1024:
                raise WorkbenchError(
                    f"Request body is larger than {limit_mb} MB.",
                    status_code=413,
                    code="payload_too_large",
                    hint="Shorten the conversation or reduce attached content.",
                )
        except ValueError:
            raise WorkbenchError(
                "Invalid Content-Length header.", status_code=400, code="bad_request"
            ) from None
