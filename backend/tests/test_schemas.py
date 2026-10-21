from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import ServerConfig


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("Qwen/Qwen2.5-1.5B-Instruct", "Qwen2.5-1.5B-Instruct"),
        ("/mnt/models/Qwen2.5-1.5B-Instruct", "Qwen2.5-1.5B-Instruct"),
        ("/mnt/models/Qwen2.5-1.5B-Instruct/", "Qwen2.5-1.5B-Instruct"),
        (r"C:\models\Qwen2.5-1.5B-Instruct", "Qwen2.5-1.5B-Instruct"),
    ],
)
def test_api_model_name_handles_repo_ids_and_local_paths(model: str, expected: str) -> None:
    assert ServerConfig(model=model).api_model_name == expected


def test_served_model_name_wins() -> None:
    config = ServerConfig(model="Qwen/Qwen2.5-1.5B-Instruct", served_model_name="local-qwen")
    assert config.api_model_name == "local-qwen"


def test_reserved_and_malformed_extra_args_are_rejected() -> None:
    with pytest.raises(ValidationError, match="managed by the form"):
        ServerConfig(extra_args=["--port", "9000"])

    with pytest.raises(ValidationError):
        ServerConfig(extra_args=["not-a-flag"])

    with pytest.raises(ValidationError):
        ServerConfig(extra_args=["--enable-prefix-caching\n--port=9000"])


def test_config_rejects_urls_and_out_of_range_values() -> None:
    with pytest.raises(ValidationError, match="not a URL"):
        ServerConfig(model="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct")

    with pytest.raises(ValidationError):
        ServerConfig(gpu_memory_utilization=0.995)

    with pytest.raises(ValidationError):
        ServerConfig(max_model_len=128)
