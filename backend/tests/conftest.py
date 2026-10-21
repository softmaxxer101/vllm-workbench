from __future__ import annotations

import socket
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_running(client: TestClient, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        last = client.get("/api/server/status").json()
        if last["state"] == "running":
            return last
        if last["state"] == "error":
            raise AssertionError(
                f"Engine failed to start: {last.get('error')} :: {last.get('log_tail')}"
            )
        time.sleep(0.2)
    raise AssertionError(f"Engine did not start in time: {last}")


@pytest.fixture(scope="session")
def settings(tmp_path_factory) -> Settings:
    return Settings(
        data_dir=tmp_path_factory.mktemp("workbench-data"),
        vllm_mock=True,
        vllm_port=free_port(),
        startup_timeout_s=30,
        health_interval_s=1,
        stop_timeout_s=5,
        gpu_probe=False,
        api_key="test-secret",
        log_level="WARNING",
        log_format="text",
    )


@pytest.fixture(scope="session")
def client(settings: Settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        test_client.post("/api/server/start")
        wait_for_running(test_client)
        yield test_client


@pytest.fixture()
def idle_app(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        vllm_mock=True,
        vllm_port=free_port(),
        gpu_probe=False,
        log_level="WARNING",
        log_format="text",
    )
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client
