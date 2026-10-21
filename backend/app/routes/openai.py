"""OpenAI-compatible surface backed by the managed vLLM instance."""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, Depends, Request
from starlette.responses import Response

from ..auth import require_api_key
from ..errors import WorkbenchError
from ..manager import VLLMProcessManager
from ..proxy import EngineProxy
from .deps import enforce_body_limit, get_manager, get_proxy

router = APIRouter(prefix="/v1", tags=["openai"], dependencies=[Depends(require_api_key)])


@router.get("/models")
async def list_models(manager: VLLMProcessManager = Depends(get_manager)) -> dict:
    model = manager.config.api_model_name
    return {
        "object": "list",
        "data": [
            {
                "id": model,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "vllm-workbench",
                "root": manager.config.model,
            }
        ],
    }


@router.get("/models/{model_id}")
async def get_model(
    model_id: str, manager: VLLMProcessManager = Depends(get_manager)
) -> dict:
    model = manager.config.api_model_name
    if model_id not in {model, manager.config.model}:
        raise WorkbenchError(
            f"The model `{model_id}` is not loaded.",
            status_code=404,
            code="model_not_found",
            hint=f"The active model is `{model}`. Requests are routed to it automatically.",
        )
    return {
        "id": model,
        "object": "model",
        "created": int(time.time()),
        "owned_by": "vllm-workbench",
        "root": manager.config.model,
    }


@router.post("/chat/completions")
async def openai_chat_completions(
    request: Request,
    proxy: EngineProxy = Depends(get_proxy),
) -> Response:
    await enforce_body_limit(request)
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise WorkbenchError(
            "Request body must be valid JSON.",
            status_code=400,
            code="invalid_json",
        ) from exc
    if not isinstance(payload, dict):
        raise WorkbenchError(
            "Request body must be a JSON object.",
            status_code=400,
            code="invalid_body",
        )
    return await proxy.chat_raw(payload, source="api")
