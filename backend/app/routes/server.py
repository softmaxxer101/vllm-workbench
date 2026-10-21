"""Server management endpoints: lifecycle, config, logs."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from ..errors import WorkbenchError
from ..manager import VLLMProcessManager
from ..schemas import LogsResponse, ServerConfig, ServerStatus
from .deps import get_manager, get_settings

logger = logging.getLogger("workbench.api.server")
router = APIRouter(prefix="/server", tags=["server"])


class StartRequest(BaseModel):
    config: ServerConfig | None = None


@router.get("/status", response_model=ServerStatus)
async def server_status(manager: VLLMProcessManager = Depends(get_manager)) -> ServerStatus:
    return manager.status()


@router.get("/config", response_model=ServerConfig)
async def get_config(manager: VLLMProcessManager = Depends(get_manager)) -> ServerConfig:
    return manager.config


@router.put("/config", response_model=ServerConfig)
async def update_config(
    config: ServerConfig,
    manager: VLLMProcessManager = Depends(get_manager),
) -> ServerConfig:
    if manager.state in {"running", "starting", "stopping"}:
        raise WorkbenchError(
            "Stop the server before changing its configuration.",
            status_code=409,
            code="server_busy",
            hint="The new configuration is applied the next time the server starts.",
        )
    return await manager.save_config(config)


@router.post("/start", response_model=ServerStatus, status_code=202)
async def start_server(
    payload: StartRequest | None = None,
    manager: VLLMProcessManager = Depends(get_manager),
) -> ServerStatus:
    return await manager.start(payload.config if payload else None)


@router.post("/stop", response_model=ServerStatus)
async def stop_server(manager: VLLMProcessManager = Depends(get_manager)) -> ServerStatus:
    return await manager.stop()


@router.post("/restart", response_model=ServerStatus, status_code=202)
async def restart_server(
    payload: StartRequest | None = None,
    manager: VLLMProcessManager = Depends(get_manager),
) -> ServerStatus:
    return await manager.restart(payload.config if payload else None)


@router.get("/logs", response_model=LogsResponse)
async def get_logs(
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2000),
    manager: VLLMProcessManager = Depends(get_manager),
) -> LogsResponse:
    entries, dropped = manager.logs_after(after_seq, limit)
    return LogsResponse(
        entries=entries,
        next_seq=entries[-1].seq if entries else after_seq,
        dropped=dropped,
    )


@router.delete("/logs", status_code=204)
async def clear_logs(manager: VLLMProcessManager = Depends(get_manager)) -> None:
    manager.clear_logs()


@router.get("/logs/stream")
async def stream_logs(
    request: Request,
    after_seq: int = Query(default=0, ge=0),
    manager: VLLMProcessManager = Depends(get_manager),
) -> StreamingResponse:
    settings = get_settings(request)

    async def events() -> AsyncIterator[bytes]:
        queue = manager.subscribe()
        try:
            entries, dropped = manager.logs_after(after_seq, 300)
            last_seq = after_seq
            if dropped:
                yield _event(
                    "log.dropped",
                    {"dropped": dropped, "message": f"{dropped} earlier lines were dropped."},
                )
            for entry in entries:
                last_seq = max(last_seq, entry.seq)
                yield _event("log", entry.model_dump(mode="json"))
            while True:
                if await request.is_disconnected():
                    break
                try:
                    entry = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                if entry.seq <= last_seq:
                    continue
                last_seq = entry.seq
                yield _event("log", entry.model_dump(mode="json"))
        except asyncio.CancelledError:
            raise
        finally:
            manager.unsubscribe(queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Log-Buffer": str(settings.log_buffer_lines),
        },
    )


@router.get("/health")
async def engine_health(
    manager: VLLMProcessManager = Depends(get_manager),
) -> dict[str, object]:
    return {
        "state": manager.state,
        "healthy": manager.status().healthy,
        "model": manager.config.api_model_name,
    }


def _event(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()
