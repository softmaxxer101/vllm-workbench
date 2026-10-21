"""Application errors and consistent JSON error responses."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("workbench.errors")


class WorkbenchError(Exception):
    """Error surfaced to the UI with a human-readable message and optional hint."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 400,
        code: str = "bad_request",
        hint: str | None = None,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.hint = hint
        self.details = details
        self.headers = headers or {}

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status_code,
            content={
                "error": {
                    "message": self.message,
                    "type": self.code,
                    "hint": self.hint,
                    "details": self.details,
                }
            },
            headers={"Cache-Control": "no-store", **self.headers},
        )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(WorkbenchError)
    async def _workbench_error(_: Request, exc: WorkbenchError) -> JSONResponse:
        return exc.to_response()

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        problems: list[dict[str, Any]] = []
        for error in exc.errors()[:8]:
            location = ".".join(str(part) for part in error.get("loc", ()) if part != "body")
            problems.append(
                {
                    "field": location or "request",
                    "message": error.get("msg", "Invalid value"),
                }
            )
        first = problems[0] if problems else None
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "message": (
                        f"Invalid {first['field']}: {first['message']}"
                        if first
                        else "The request did not pass validation."
                    ),
                    "type": "validation_error",
                    "hint": "Check the highlighted fields and try again.",
                    "details": {"problems": problems},
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "message": detail,
                    "type": "http_error",
                    "hint": None,
                    "details": None,
                }
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "message": "The backend hit an unexpected error.",
                    "type": "internal_error",
                    "hint": "Check the backend logs for details, then retry.",
                    "details": None,
                }
            },
        )
