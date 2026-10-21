"""The vLLM child process must inherit the launcher's environment on PATH.

vLLM shells out to helper binaries installed beside its own interpreter (for
example `ninja` for flashinfer's JIT kernels). WORKBENCH_VLLM_LAUNCH can be an
absolute path into a different virtualenv, so the manager has to surface that
directory explicitly instead of relying on the backend's own PATH.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from app.config import Settings
from app.manager import VLLMProcessManager
from app.storage import ConfigStore


def _manager(tmp_path: Path, **overrides) -> VLLMProcessManager:
    settings = Settings(data_dir=tmp_path, gpu_probe=False, **overrides)
    return VLLMProcessManager(settings, ConfigStore(tmp_path / "server-config.json"))


def test_launcher_directory_is_prepended_to_path(tmp_path: Path) -> None:
    launcher_dir = tmp_path / "vllm-venv" / "bin"
    launcher_dir.mkdir(parents=True)
    launcher = launcher_dir / "vllm"

    manager = _manager(tmp_path, vllm_launch=f"{launcher} serve")
    env = manager._build_env()

    entries = env["PATH"].split(os.pathsep)
    assert entries[0] == str(launcher_dir)
    assert entries[1:] == os.environ.get("PATH", "").split(os.pathsep)


def test_mock_mode_leaves_path_untouched(tmp_path: Path) -> None:
    # The mock engine runs on the backend's own interpreter, so no other
    # virtualenv should be injected in front of PATH.
    manager = _manager(tmp_path, vllm_mock=True, vllm_launch="/nonexistent/bin/vllm serve")
    env = manager._build_env()

    assert env["PATH"] == os.environ.get("PATH", "")


def test_missing_launcher_directory_does_not_break_path(tmp_path: Path) -> None:
    manager = _manager(tmp_path, vllm_launch="/nonexistent/bin/vllm serve")
    env = manager._build_env()

    assert env["PATH"] == os.environ.get("PATH", "")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX PATH semantics")
def test_hf_token_is_forwarded(tmp_path: Path) -> None:
    manager = _manager(tmp_path, hf_token="hf_test")
    env = manager._build_env()

    assert env["HF_TOKEN"] == "hf_test"
