from __future__ import annotations

import json

from fastapi.testclient import TestClient


def test_health_and_status(client: TestClient) -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["server"] == "running"

    status = client.get("/api/server/status").json()
    assert status["state"] == "running"
    assert status["healthy"] is True
    assert status["config"]["model"] == "Qwen/Qwen2.5-1.5B-Instruct"
    assert status["mock"] is True


def test_logs_capture_startup(client: TestClient) -> None:
    response = client.get("/api/server/logs?limit=1000")
    assert response.status_code == 200
    messages = " ".join(entry["message"] for entry in response.json()["entries"])
    assert "Launching:" in messages
    assert "ready" in messages.lower()


def test_config_conflict_and_validation(client: TestClient) -> None:
    current = client.get("/api/server/config").json()
    conflict = client.put("/api/server/config", json=current)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["type"] == "server_busy"

    invalid = dict(current)
    invalid["gpu_memory_utilization"] = 2.5
    response = client.put("/api/server/config", json=invalid)
    assert response.status_code == 422
    assert response.json()["error"]["type"] == "validation_error"

    reserved = dict(current)
    reserved["extra_args"] = ["--port", "9999"]
    response = client.put("/api/server/config", json=reserved)
    assert response.status_code == 422
    assert "managed by the form" in response.json()["error"]["message"]


def test_streaming_chat_reports_metrics(client: TestClient) -> None:
    payload = {
        "messages": [
            {"role": "system", "content": "You are concise."},
            {"role": "user", "content": "Stream a short explanation of vLLM."},
        ],
        "temperature": 0.4,
        "max_tokens": 48,
        "stream": True,
    }
    content: list[str] = []
    metrics: dict | None = None
    with client.stream("POST", "/api/chat/completions", json=payload) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                parsed = json.loads(data)
                if event == "workbench.metrics":
                    metrics = parsed
                elif event == "error":
                    raise AssertionError(parsed)
                elif parsed.get("choices"):
                    delta = parsed["choices"][0].get("delta") or {}
                    if delta.get("content"):
                        content.append(delta["content"])
        assert metrics is not None
        assert metrics["completion_tokens"] > 0
        assert metrics["ttft_ms"] is not None and metrics["ttft_ms"] >= 0
        assert metrics["tokens_per_second"] > 0

    text = "".join(content)
    assert "simulated" in text.lower() or "vllm" in text.lower()

    snapshot = client.get("/api/metrics").json()
    assert snapshot["summary"]["requests"] >= 1
    assert snapshot["vllm"]["available"] is True
    assert snapshot["vllm"]["gauges"]["kv_cache_usage"] is not None
    assert any(item["source"] == "playground" for item in snapshot["recent"])


def test_openai_endpoint_requires_key_and_proxies(client: TestClient) -> None:
    unauthorized = client.get("/v1/models")
    assert unauthorized.status_code == 401
    assert unauthorized.headers.get("www-authenticate") == "Bearer"

    headers = {"Authorization": "Bearer test-secret"}
    models = client.get("/v1/models", headers=headers)
    assert models.status_code == 200
    model_id = models.json()["data"][0]["id"]

    response = client.post(
        "/v1/chat/completions",
        headers=headers,
        json={
            "model": "any-model-name",
            "messages": [{"role": "user", "content": "Hello from an external client"}],
            "temperature": 0.2,
            "max_tokens": 20,
            "stream": False,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["model"] == model_id
    assert data["choices"][0]["message"]["content"]
    assert data["usage"]["completion_tokens"] > 0


def test_openai_stream_is_protocol_compatible(client: TestClient) -> None:
    """External SDKs must only receive OpenAI chunk objects and [DONE]."""
    chunks: list[dict] = []
    with client.stream(
        "POST",
        "/v1/chat/completions",
        headers={"Authorization": "Bearer test-secret"},
        json={
            "model": "whatever",
            "messages": [{"role": "user", "content": "Stream hello."}],
            "max_tokens": 16,
            "stream": True,
        },
    ) as response:
        assert response.status_code == 200
        event = None
        saw_done = False
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
                if data == "[DONE]":
                    saw_done = True
                    break
                assert event != "workbench.metrics"
                chunk = json.loads(data)
                assert chunk["object"] == "chat.completion.chunk"
                assert isinstance(chunk.get("choices"), list)
                chunks.append(chunk)
        assert saw_done is True
        assert chunks
        assert any(chunk["choices"][0]["delta"].get("content") for chunk in chunks)


def test_sweep_returns_buckets(client: TestClient) -> None:
    response = client.post(
        "/api/sweep",
        json={
            "messages": [{"role": "user", "content": "Say hello."}],
            "parameter": "temperature",
            "values": [0.0, 0.7, 1.2],
            "runs_per_value": 1,
            "concurrency": 3,
            "sampling": {"max_tokens": 16},
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["results"]) == 3
    assert len(data["buckets"]) == 3
    assert all(item["ok"] for item in data["results"])
    assert all(bucket["avg_latency_ms"] > 0 for bucket in data["buckets"])


def test_sweep_rejects_duplicate_values(client: TestClient) -> None:
    response = client.post(
        "/api/sweep",
        json={
            "messages": [{"role": "user", "content": "Hello"}],
            "parameter": "temperature",
            "values": [0.5, 0.5],
        },
    )
    assert response.status_code == 422


def test_chat_when_stopped_and_restart(client: TestClient) -> None:
    stopped = client.post("/api/server/stop")
    assert stopped.status_code == 200
    assert stopped.json()["state"] == "stopped"

    chat = client.post(
        "/api/chat/completions",
        json={"messages": [{"role": "user", "content": "Hi"}], "stream": False},
    )
    assert chat.status_code == 503
    assert chat.json()["error"]["type"] == "engine_stopped"

    from tests.conftest import wait_for_running

    client.post("/api/server/start")
    wait_for_running(client)


def test_metrics_stream_pushes_snapshots(client: TestClient) -> None:
    with client.stream("GET", "/api/metrics/stream?interval=0.5") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        event = None
        snapshot = None
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event == "telemetry":
                snapshot = json.loads(line[5:].strip())
                break

        assert event == "telemetry"
        assert snapshot is not None
        assert snapshot["server"]["state"] == "running"
        assert snapshot["summary"]["requests"] >= 0
        assert len(snapshot["series"]) == 60
        # Every frame is stamped by the shared sampler, so clients can detect
        # stalls and dropped frames without guessing.
        assert snapshot["stream"]["sequence"] >= 1
        assert snapshot["stream"]["subscribers"] == 1
        assert snapshot["stream"]["sample_ms"] >= 0

    # Leaving the stream must release the sampler instead of leaking a task.
    stats = client.get("/api/metrics/stream/stats").json()
    assert stats["subscribers"] == 0
    assert stats["running"] is False


def test_metrics_clear(client: TestClient) -> None:
    assert client.delete("/api/metrics").status_code == 204
    assert client.get("/api/metrics").json()["summary"]["requests"] == 0
