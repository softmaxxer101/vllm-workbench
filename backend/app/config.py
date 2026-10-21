"""Application settings, loaded from environment variables / .env files."""

from __future__ import annotations

import shlex
from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    """All runtime configuration. Every field can be overridden with WORKBENCH_* env vars."""

    model_config = SettingsConfigDict(
        env_prefix="WORKBENCH_",
        env_file=(PROJECT_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- HTTP server -------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"
    log_format: str = "json"  # json | text
    docs_enabled: bool = True
    cors_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:3001,http://127.0.0.1:3001"
    )

    # --- Security ----------------------------------------------------------
    # When set, /v1/* requires `Authorization: Bearer <key>`. The UI's own /api
    # routes stay open (they only ever talk to the local machine by default).
    api_key: str = ""
    # Accept the conventional HF_TOKEN alias in addition to WORKBENCH_HF_TOKEN.
    hf_token: str = Field(
        default="",
        validation_alias=AliasChoices("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "WORKBENCH_HF_TOKEN"),
    )

    # --- Storage -----------------------------------------------------------
    data_dir: Path = BACKEND_DIR / "data"

    # --- vLLM engine -------------------------------------------------------
    vllm_host: str = "127.0.0.1"
    vllm_port: int = Field(default=8001, ge=1, le=65535)
    # Official launcher. Older images can use:
    #   WORKBENCH_VLLM_LAUNCH="python -m vllm.entrypoints.openai.api_server"
    vllm_launch: str = "vllm serve"
    startup_timeout_s: int = Field(default=900, ge=30, le=7200)
    stop_timeout_s: int = Field(default=25, ge=3, le=180)
    health_interval_s: float = Field(default=4.0, ge=1.0, le=60.0)
    log_buffer_lines: int = Field(default=3000, ge=100, le=50_000)
    # Mock engine for demos, CI and UI work on machines without a GPU.
    vllm_mock: bool = False

    # --- Metrics -----------------------------------------------------------
    gpu_probe: bool = True
    metrics_retention: int = Field(default=600, ge=50, le=10_000)
    metrics_scrape_timeout_s: float = Field(default=2.5, ge=0.5, le=15.0)

    # --- Limits ------------------------------------------------------------
    max_sweep_runs: int = Field(default=60, ge=4, le=500)
    max_concurrent_sweeps: int = Field(default=4, ge=1, le=8)
    request_timeout_s: int = Field(default=300, ge=10, le=3600)

    @field_validator("log_level")
    @classmethod
    def _upper_level(cls, value: str) -> str:
        value = value.upper()
        if value not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("log_level must be DEBUG, INFO, WARNING, ERROR or CRITICAL")
        return value

    @field_validator("log_format")
    @classmethod
    def _log_format(cls, value: str) -> str:
        value = value.lower()
        if value not in {"json", "text"}:
            raise ValueError("log_format must be 'json' or 'text'")
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def vllm_base_url(self) -> str:
        return f"http://{self.vllm_host}:{self.vllm_port}"

    @property
    def launcher(self) -> list[str]:
        return shlex.split(self.vllm_launch, posix=False)

    @property
    def config_file(self) -> Path:
        return self.data_dir / "server-config.json"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
