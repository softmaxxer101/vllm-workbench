"""Persisted workbench configuration (survives backend restarts)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

from .schemas import ServerConfig

logger = logging.getLogger("workbench.storage")


class ConfigStore:
    """JSON-backed store for the active ServerConfig.

    Writes are atomic (tmp file + replace) so a crash can never leave a truncated
    config behind. A corrupt file is backed up and replaced with defaults.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()
        self._config = self._read()

    def _read(self) -> ServerConfig:
        if not self._path.exists():
            return ServerConfig()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            return ServerConfig.model_validate(raw)
        except Exception:
            logger.exception("Invalid config at %s; backing it up and using defaults", self._path)
            try:
                shutil.copy2(self._path, self._path.with_suffix(".invalid.json"))
            except OSError:
                pass
            return ServerConfig()

    def get(self) -> ServerConfig:
        return self._config

    async def save(self, config: ServerConfig) -> ServerConfig:
        async with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            payload = json.dumps(config.model_dump(mode="json"), indent=2)
            await asyncio.to_thread(tmp.write_text, payload, encoding="utf-8")
            os.replace(tmp, self._path)
            self._config = config
        logger.info("Saved server configuration", extra={"event": "config_saved"})
        return config
