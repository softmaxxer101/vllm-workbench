"""UI-facing chat completion proxy."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from starlette.responses import Response

from ..proxy import EngineProxy
from ..schemas import ChatRequest
from .deps import enforce_body_limit, get_proxy

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/completions")
async def chat_completions(
    request: Request,
    payload: ChatRequest,
    proxy: EngineProxy = Depends(get_proxy),
) -> Response:
    await enforce_body_limit(request)
    source = payload.source if payload.source != "api" else "playground"
    return await proxy.chat_request(payload, source=source)
