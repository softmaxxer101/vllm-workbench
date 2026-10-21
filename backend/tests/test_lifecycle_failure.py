from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.conftest import free_port


def test_missing_launcher_surfaces_actionable_error(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        vllm_mock=False,
        vllm_launch="workbench-launcher-that-does-not-exist",
        vllm_port=free_port(),
        startup_timeout_s=30,
        health_interval_s=1,
        stop_timeout_s=5,
        gpu_probe=False,
        log_level="WARNING",
        log_format="text",
    )

    with TestClient(create_app(settings)) as client:
        response = client.post("/api/server/start")
        assert response.status_code == 202
        # A missing executable can fail before the 50 ms start response is built.
        assert response.json()["state"] in {"starting", "error"}

        deadline = time.monotonic() + 10
        status = response.json()
        while time.monotonic() < deadline:
            status = client.get("/api/server/status").json()
            if status["state"] == "error":
                break
            if status["state"] == "running":
                pytest.fail("The missing launcher unexpectedly started")
            time.sleep(0.1)

        assert status["state"] == "error"
        assert status["healthy"] is False
        assert status["error"] == "The vLLM launcher could not be found."
        assert "Install vLLM" in (status["hint"] or "")

        logs = client.get("/api/server/logs?limit=100").json()["entries"]
        messages = "\n".join(entry["message"] for entry in logs)
        assert "Launching:" in messages
        assert "workbench-launcher-that-does-not-exist" in messages
