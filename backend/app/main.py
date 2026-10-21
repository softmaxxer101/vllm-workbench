"""FastAPI application factory and entrypoint."""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import Settings, get_settings
from .errors import install_error_handlers
from .hf import HuggingFaceService
from .logging_setup import configure_logging, request_id_var
from .manager import VLLMProcessManager
from .metrics import MetricsService
from .proxy import EngineProxy
from .routes import chat, metrics, models, openai, server, sweep, system
from .storage import ConfigStore
from .telemetry import TelemetryHub

logger = logging.getLogger("workbench.main")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.ensure_dirs()
        store = ConfigStore(settings.config_file)
        manager = VLLMProcessManager(settings, store)
        metrics_service = MetricsService(settings)
        proxy = EngineProxy(settings, manager, metrics_service)
        hf = HuggingFaceService(settings)
        telemetry = TelemetryHub(metrics_service, manager, interval=1.0)
        metrics_service.start()

        app.state.settings = settings
        app.state.manager = manager
        app.state.metrics = metrics_service
        app.state.proxy = proxy
        app.state.hf = hf
        app.state.telemetry = telemetry

        logger.info(
            "vLLM Workbench backend ready",
            extra={
                "event": "startup",
                "path": str(settings.data_dir),
                "status_code": None,
            },
        )
        if not settings.api_key:
            logger.warning(
                "No WORKBENCH_API_KEY set: /v1 endpoints are open. Set one before exposing "
                "this backend beyond localhost.",
                extra={"event": "auth_disabled"},
            )
        if settings.vllm_mock:
            logger.warning(
                "Mock vLLM mode is enabled (WORKBENCH_VLLM_MOCK=1). Responses are simulated.",
                extra={"event": "mock_mode"},
            )
        try:
            yield
        finally:
            logger.info("Shutting down vLLM Workbench", extra={"event": "shutdown"})
            await telemetry.close()
            await manager.shutdown()
            await proxy.close()
            await metrics_service.close()
            await hf.close()

    docs = "/docs" if settings.docs_enabled else None
    app = FastAPI(
        title="vLLM Inference Workbench",
        version=__version__,
        description=(
            "Local LLM workbench: manages a vLLM process, proxies streaming chat, "
            "collects metrics and exposes an OpenAI-compatible endpoint."
        ),
        docs_url=docs,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-Id"],
        max_age=600,
    )

    install_error_handlers(app)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "Unhandled request failure",
                extra={"method": request.method, "path": request.url.path},
            )
            request_id_var.reset(token)
            raise

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        quiet = request.url.path in {"/api/health", "/health", "/api/metrics/live"}
        logger.log(
            logging.DEBUG if quiet else logging.INFO,
            "%s %s -> %s",
            request.method,
            request.url.path,
            response.status_code,
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        request_id_var.reset(token)
        return response

    api_prefix = "/api"
    app.include_router(system.router, prefix=api_prefix)
    app.include_router(server.router, prefix=api_prefix)
    app.include_router(chat.router, prefix=api_prefix)
    app.include_router(metrics.router, prefix=api_prefix)
    app.include_router(sweep.router, prefix=api_prefix)
    app.include_router(models.router, prefix=api_prefix)
    app.include_router(openai.router)

    @app.get("/health", include_in_schema=False)
    async def health() -> dict:
        manager: VLLMProcessManager = app.state.manager
        return {"status": "ok", "version": __version__, "server": manager.state}

    @app.get("/", include_in_schema=False)
    async def root() -> JSONResponse:
        return JSONResponse(
            {
                "name": "vLLM Inference Workbench",
                "version": __version__,
                "docs": "/docs" if settings.docs_enabled else None,
                "health": "/api/health",
                "openai_compatible": "/v1/chat/completions",
            }
        )

    return app


app = create_app()


if __name__ == "__main__":
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_config=None,
        reload=False,
    )
