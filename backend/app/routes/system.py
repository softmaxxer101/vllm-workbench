"""Health and system information."""

from __future__ import annotations

import importlib.metadata
import platform
import sys

from fastapi import APIRouter, Depends

from .. import __version__
from ..config import Settings
from ..manager import VLLMProcessManager
from ..metrics import MetricsService
from ..schemas import SystemInfo
from .deps import get_manager, get_metrics, get_settings

router = APIRouter(tags=["system"])


@router.get("/health")
async def health(manager: VLLMProcessManager = Depends(get_manager)) -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "server": manager.state,
    }


@router.get("/version")
async def version() -> dict:
    return {"version": __version__}


@router.get("/system", response_model=SystemInfo)
async def system_info(
    settings: Settings = Depends(get_settings),
    manager: VLLMProcessManager = Depends(get_manager),
    metrics: MetricsService = Depends(get_metrics),
) -> SystemInfo:
    try:
        vllm_version = importlib.metadata.version("vllm")
    except importlib.metadata.PackageNotFoundError:
        vllm_version = None

    return SystemInfo(
        backend_version=__version__,
        python_version=platform.python_version(),
        vllm_version=vllm_version,
        mock_mode=settings.vllm_mock,
        data_dir=str(settings.data_dir),
        gpus=await metrics.gpus(),
        platform=platform.platform(),
        environment_vars={
            "launcher": settings.vllm_launch,
            "engine_url": settings.vllm_base_url,
            "startup_timeout_s": str(settings.startup_timeout_s),
            "model": manager.config.model,
            "python": sys.executable,
        },
    )
