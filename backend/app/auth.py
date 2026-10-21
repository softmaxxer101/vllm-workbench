"""Optional API-key protection for the OpenAI-compatible endpoints."""

from __future__ import annotations

import hmac

from fastapi import Header, Request

from .errors import WorkbenchError


async def require_api_key(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    configured = request.app.state.settings.api_key
    if not configured:
        return

    token = x_api_key
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            token = value.strip()

    if not token or not hmac.compare_digest(token, configured):
        raise WorkbenchError(
            "Invalid or missing API key.",
            status_code=401,
            code="invalid_api_key",
            hint="Send `Authorization: Bearer <WORKBENCH_API_KEY>` or set X-API-Key.",
            headers={"WWW-Authenticate": "Bearer"},
        )
