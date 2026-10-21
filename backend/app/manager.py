"""vLLM server process lifecycle management.

The manager owns exactly one vLLM OpenAI-compatible server. It streams the
process' stdout/stderr into a bounded ring buffer, waits for the HTTP health
endpoint during startup, watches for crashes, and shuts the process (and any
worker children) down gracefully.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import shlex
import signal
import socket
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .config import BACKEND_DIR, Settings
from .errors import WorkbenchError
from .schemas import LogEntry, ServerConfig, ServerState, ServerStatus
from .storage import ConfigStore

logger = logging.getLogger("workbench.manager")

_OOM_MARKERS = (
    "cuda out of memory",
    "torch.outofmemoryerror",
    "out of memory",
    "no available memory for the cache blocks",
    "cuda error: out of memory",
)
_MODEL_MARKERS = (
    "is not a valid model",
    "does not appear to have a file named config.json",
    "no such file or directory",
    "oserror:",
    "repository not found",
)
_AUTH_MARKERS = ("gated repo", "401 client error", "403 client error", "unauthorized")
_DRIVER_MARKERS = ("cuda driver", "nvidia driver", "no cuda gpus", "cuda is not available")
_PORT_MARKERS = ("address already in use", "errno 98", "errno 10048")
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class _StartupAborted(Exception):
    """Raised when a stop arrives while the engine is still warming up."""


class VLLMProcessManager:
    def __init__(self, settings: Settings, store: ConfigStore) -> None:
        self.settings = settings
        self.store = store
        self._config: ServerConfig = store.get()
        self._state: ServerState = "stopped"
        self._proc: asyncio.subprocess.Process | None = None
        self._supervisor: asyncio.Task[None] | None = None
        self._log_task: asyncio.Task[None] | None = None
        self._lifecycle_lock = asyncio.Lock()

        self._logs: deque[LogEntry] = deque(maxlen=settings.log_buffer_lines)
        self._seq = 0
        self._subscribers: set[asyncio.Queue[LogEntry]] = set()
        self._started_at: datetime | None = None
        self._error: str | None = None
        self._hint: str | None = None
        self._exit_code: int | None = None
        self._healthy = False

        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=2.0),
            trust_env=False,
            headers={"User-Agent": "vllm-workbench/1.0"},
        )

    # ------------------------------------------------------------------ state
    @property
    def config(self) -> ServerConfig:
        return self._config

    @property
    def state(self) -> ServerState:
        return self._state

    @property
    def base_url(self) -> str:
        return self.settings.vllm_base_url

    def status(self) -> ServerStatus:
        proc = self._proc
        running_states = {"running", "starting", "stopping"}
        pid = proc.pid if proc is not None and self._state in running_states else None
        uptime: float | None = None
        if self._started_at and self._state in {"running", "stopping"}:
            uptime = max(0.0, (datetime.now(timezone.utc) - self._started_at).total_seconds())

        tail: list[str] = []
        if self._state in {"error", "starting"}:
            count = 30 if self._state == "error" else 8
            tail = [entry.message for entry in list(self._logs)[-count:]]

        config = self._config
        return ServerStatus(
            state=self._state,
            model=config.model,
            api_model_name=config.api_model_name,
            base_url=self.base_url if self._state == "running" else None,
            pid=pid,
            started_at=self._started_at,
            uptime_seconds=uptime,
            exit_code=self._exit_code,
            healthy=self._healthy,
            error=self._error,
            hint=self._hint,
            log_tail=tail,
            config=config,
            mock=self.settings.vllm_mock,
        )

    # ---------------------------------------------------------------- lifecycle
    async def start(self, config: ServerConfig | None = None) -> ServerStatus:
        async with self._lifecycle_lock:
            if self._state in {"running", "starting", "stopping"}:
                raise WorkbenchError(
                    f"The server is {self._state}. Stop it before starting a new one.",
                    status_code=409,
                    code="server_busy",
                )
            # A crashed supervisor may still be reaping its process and clearing
            # state. Let it finish so a fast retry cannot have its fresh process
            # reference clobbered by the old supervisor's cleanup.
            previous = self._supervisor
            if previous is not None and not previous.done():
                try:
                    await asyncio.wait_for(asyncio.shield(previous), timeout=15)
                except asyncio.TimeoutError:
                    raise WorkbenchError(
                        "The previous engine process is still shutting down.",
                        status_code=409,
                        code="server_busy",
                        hint="Wait a few seconds and retry the start.",
                    ) from None
                except Exception:
                    pass
            if config is not None:
                self._config = await self.store.save(config)
            else:
                config = self._config

            self._state = "starting"
            self._error = None
            self._hint = None
            self._exit_code = None
            self._healthy = False
            self._started_at = None
            self._supervisor = asyncio.create_task(
                self._supervise(config), name="vllm-supervisor"
            )
        logger.info("Starting vLLM", extra={"event": "server_start", "model": config.model})
        await asyncio.sleep(0.05)
        return self.status()

    async def stop(self) -> ServerStatus:
        async with self._lifecycle_lock:
            if self._state == "stopped" and self._proc is None:
                self._error = None
                self._hint = None
                return self.status()

            self._state = "stopping"
            proc = self._proc
            if proc is not None and proc.returncode is None:
                self._append_log("system", "Stopping vLLM server…")
                await self._terminate(proc)

            supervisor = self._supervisor
            if supervisor is not None and not supervisor.done():
                try:
                    await asyncio.wait_for(asyncio.shield(supervisor), timeout=10)
                except asyncio.TimeoutError:
                    supervisor.cancel()
                    with contextlib.suppress(BaseException):
                        await supervisor
                except Exception:
                    logger.exception("Supervisor failed while stopping vLLM")

            self._proc = None
            self._state = "stopped"
            self._healthy = False
            self._started_at = None
            self._error = None
            self._hint = None
            self._exit_code = None
            self._append_log("system", "Server stopped.")
        logger.info("vLLM stopped", extra={"event": "server_stop"})
        return self.status()

    async def restart(self, config: ServerConfig | None = None) -> ServerStatus:
        await self.stop()
        return await self.start(config)

    async def save_config(self, config: ServerConfig) -> ServerConfig:
        """Persist a config for the next launch while keeping the manager in sync."""
        self._config = await self.store.save(config)
        return self._config

    async def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            await self.stop()
        await self._client.aclose()

    # -------------------------------------------------------------- supervisor
    async def _supervise(self, config: ServerConfig) -> None:
        proc: asyncio.subprocess.Process | None = None
        try:
            if self._state != "starting":
                return
            cmd = self._build_command(config)
            self._append_log("system", f"Launching: {shlex.join(cmd)}")
            env = self._build_env()
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL,
                env=env,
                cwd=str(BACKEND_DIR),
                start_new_session=os.name != "nt",
                creationflags=0,
            )
            self._proc = proc
            self._append_log("system", f"Process started (pid {proc.pid}). Waiting for health…")
            self._log_task = asyncio.create_task(self._pump_logs(proc), name="vllm-log-pump")

            ready = await self._wait_until_ready(proc)
            if not ready:
                return

            self._state = "running"
            self._healthy = True
            self._started_at = datetime.now(timezone.utc)
            self._append_log(
                "system",
                f"vLLM is ready at {self.base_url} "
                f"(model: {config.api_model_name}, pid {proc.pid}).",
            )
            logger.info(
                "vLLM is ready",
                extra={"event": "server_ready", "model": config.model, "pid": proc.pid},
            )

            await self._monitor(proc)

            if self._state == "running":
                code = proc.returncode
                self._exit_code = code
                message, hint = self._classify_failure(
                    f"vLLM exited unexpectedly (exit code {code})."
                )
                self._error = message
                self._hint = hint
                self._state = "error"
                self._healthy = False
                self._append_log("system", f"{message} {hint}")
                logger.error(
                    "vLLM process exited",
                    extra={"event": "server_crash", "status_code": code},
                )
            elif self._state == "stopping":
                self._state = "stopped"
                self._healthy = False
        except _StartupAborted:
            self._state = "stopping"
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                await self._terminate(proc)
            raise
        except FileNotFoundError:
            self._error = "The vLLM launcher could not be found."
            self._hint = (
                "Install vLLM in this environment (`uv sync`), use the Docker image, or set "
                "WORKBENCH_VLLM_LAUNCH to the correct command."
            )
            self._state = "error"
            self._append_log("system", self._error)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("vLLM supervisor crashed")
            self._error = f"Could not start vLLM: {exc}"
            self._hint = "Check the server logs below for the underlying error."
            self._state = "error"
        finally:
            task = self._log_task
            if task is not None and not task.done():
                with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
                    await asyncio.wait_for(asyncio.shield(task), timeout=2)
                if not task.done():
                    task.cancel()
            self._log_task = None

            if proc is not None and proc.returncode is None:
                await self._terminate(proc)
            if proc is not None:
                self._exit_code = proc.returncode

            if self._state == "stopping":
                self._state = "stopped"
                self._healthy = False
            elif self._state in {"starting", "running"}:
                self._state = "error"
                self._healthy = False
                if not self._error:
                    self._error, self._hint = self._classify_failure(
                        "vLLM stopped before it was ready."
                    )
            self._proc = None
            if self._state == "stopped":
                self._started_at = None
            self._supervisor = None

    async def _wait_until_ready(self, proc: asyncio.subprocess.Process) -> bool:
        deadline = time.monotonic() + self.settings.startup_timeout_s
        last_probe = 0.0
        while time.monotonic() < deadline:
            if self._state in {"stopping", "stopped"}:
                raise _StartupAborted
            if proc.returncode is not None:
                self._exit_code = proc.returncode
                self._error, self._hint = self._classify_failure(
                    f"vLLM failed to start (exit code {proc.returncode})."
                )
                self._state = "error"
                return False
            now = time.monotonic()
            if now - last_probe >= 1.0:
                last_probe = now
                if await self._probe_health():
                    return True
            await asyncio.sleep(0.5)

        self._error = (
            "vLLM did not become healthy within "
            f"{self.settings.startup_timeout_s}s and was stopped."
        )
        self._hint = (
            "The first launch downloads weights, so it can take a long time. Check the logs; "
            "you can raise WORKBENCH_STARTUP_TIMEOUT_S or pick a smaller model."
        )
        self._state = "error"
        self._append_log("system", self._error)
        await self._terminate(proc)
        return False

    async def _monitor(self, proc: asyncio.subprocess.Process) -> None:
        consecutive_failures = 0
        while self._state in {"running", "stopping"}:
            if proc.returncode is not None:
                return
            try:
                await asyncio.wait_for(
                    asyncio.shield(proc.wait()), timeout=self.settings.health_interval_s
                )
                return
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                raise

            if self._state != "running":
                return
            healthy = await self._probe_health()
            self._healthy = healthy
            consecutive_failures = 0 if healthy else consecutive_failures + 1
            if consecutive_failures == 3:
                self._append_log(
                    "system",
                    "Health probe failed 3 times; the process is still running and will be "
                    "monitored. Check the logs for stalled requests.",
                )

    # ------------------------------------------------------------------ process
    def _build_command(self, config: ServerConfig) -> list[str]:
        port = str(self.settings.vllm_port)
        if self.settings.vllm_mock:
            return [
                sys.executable,
                "-m",
                "app.mock_vllm",
                "--model",
                config.model,
                "--port",
                port,
                "--max-model-len",
                str(config.max_model_len),
                "--served-model-name",
                config.api_model_name,
            ]

        cmd = list(self.settings.launcher)
        cmd += [
            "--model",
            config.model,
            "--host",
            self.settings.vllm_host,
            "--port",
            port,
            "--served-model-name",
            config.api_model_name,
            "--max-model-len",
            str(config.max_model_len),
            "--gpu-memory-utilization",
            f"{config.gpu_memory_utilization:.2f}",
            "--tensor-parallel-size",
            str(config.tensor_parallel_size),
            "--dtype",
            config.dtype,
        ]
        if config.quantization:
            cmd += ["--quantization", config.quantization]
        if config.trust_remote_code:
            cmd.append("--trust-remote-code")
        if config.enforce_eager:
            cmd.append("--enforce-eager")
        if config.max_num_seqs:
            cmd += ["--max-num-seqs", str(config.max_num_seqs)]
        cmd += config.extra_args
        return cmd

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env.setdefault("VLLM_LOGGING_LEVEL", "INFO")
        # vLLM shells out to helpers installed next to its own interpreter (for
        # example `ninja` for flashinfer's JIT kernels). WORKBENCH_VLLM_LAUNCH
        # may be an absolute path pointing at a different virtualenv, which is
        # not on PATH, so prepend the launcher's bin directory.
        launcher = self.settings.launcher
        if not self.settings.vllm_mock and launcher:
            launcher_dir = os.path.dirname(os.path.abspath(launcher[0]))
            if os.path.isdir(launcher_dir):
                env["PATH"] = launcher_dir + os.pathsep + env.get("PATH", "")
        if self.settings.hf_token:
            env["HF_TOKEN"] = self.settings.hf_token
        # Avoid inheriting a stale proxy for loopback calls from model tooling.
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
            env.pop(key, None)
        return env

    async def _pump_logs(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        while True:
            try:
                raw = await proc.stdout.readline()
            except (asyncio.LimitOverrunError, ValueError):
                self._append_log("stderr", "[workbench] log line exceeded buffer; truncated")
                continue
            except asyncio.CancelledError:
                raise
            if not raw:
                break
            # vLLM colorizes its output even when attached to a pipe; strip
            # escape sequences so the log console and downloads stay readable.
            text = _ANSI_RE.sub("", raw.decode("utf-8", errors="replace")).rstrip("\r\n")
            if text:
                self._append_log("stdout", text)

    async def _terminate(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        try:
            if os.name == "nt":
                proc.terminate()
            else:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            return
        except Exception:
            with contextlib.suppress(Exception):
                proc.terminate()

        try:
            await asyncio.wait_for(proc.wait(), timeout=self.settings.stop_timeout_s)
            return
        except asyncio.TimeoutError:
            self._append_log("system", "Graceful shutdown timed out; forcing termination.")
        try:
            if os.name == "nt":
                proc.kill()
            else:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
        except Exception:
            with contextlib.suppress(Exception):
                proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)

    async def _probe_health(self) -> bool:
        try:
            response = await self._client.get(f"{self.base_url}/health", timeout=2.0)
            return response.status_code == 200
        except (httpx.HTTPError, OSError):
            return False

    # --------------------------------------------------------------------- logs
    def _append_log(self, stream: str, message: str) -> None:
        self._seq += 1
        entry = LogEntry(
            seq=self._seq,
            timestamp=datetime.now(timezone.utc),
            stream=stream,  # type: ignore[arg-type]
            message=message,
        )
        self._logs.append(entry)
        for queue in tuple(self._subscribers):
            try:
                queue.put_nowait(entry)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(entry)

    def logs_after(self, after_seq: int, limit: int = 500) -> tuple[list[LogEntry], int]:
        entries = [entry for entry in self._logs if entry.seq > after_seq]
        dropped = 0
        if entries and after_seq + 1 < entries[0].seq:
            dropped = entries[0].seq - after_seq - 1
        elif not entries and self._seq > after_seq and after_seq < self._seq - len(self._logs):
            dropped = self._seq - len(self._logs) - after_seq
        return entries[-limit:], max(0, dropped)

    def clear_logs(self) -> None:
        self._logs.clear()
        self._append_log("system", "Logs cleared.")

    def subscribe(self) -> asyncio.Queue[LogEntry]:
        queue: asyncio.Queue[LogEntry] = asyncio.Queue(maxsize=2000)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[LogEntry]) -> None:
        self._subscribers.discard(queue)

    # ------------------------------------------------------------------ helpers
    def _classify_failure(self, message: str) -> tuple[str, str]:
        recent = "\n".join(entry.message for entry in list(self._logs)[-80:]).lower()
        if any(marker in recent for marker in _OOM_MARKERS):
            return (
                message,
                "GPU memory ran out. Lower GPU memory utilization, reduce max model length, "
                "choose a smaller model, or use a quantized checkpoint.",
            )
        if any(marker in recent for marker in _AUTH_MARKERS):
            return (
                message,
                "The model may be gated. Accept its license on Hugging Face and set HF_TOKEN "
                "for the backend, then restart.",
            )
        if any(marker in recent for marker in _DRIVER_MARKERS):
            return (
                message,
                "No usable CUDA device was found. Check the NVIDIA driver and pass the GPU "
                "through to Docker with `--gpus all` (Compose already does).",
            )
        if any(marker in recent for marker in _PORT_MARKERS):
            return (
                message,
                f"Port {self.settings.vllm_port} is already in use. Stop the other process or "
                "change WORKBENCH_VLLM_PORT.",
            )
        if any(marker in recent for marker in _MODEL_MARKERS):
            return (
                message,
                "The model could not be loaded. Verify the Hugging Face id or local path, and "
                "make sure it fits in available GPU memory.",
            )
        if "did not become healthy" in message.lower():
            return message, (
                "Check the startup logs for download or CUDA errors. Large models can take "
                "several minutes to load on first run."
            )
        return (
            message,
            "Inspect the vLLM logs below for the root cause, adjust the configuration, and "
            "start the server again.",
        )

    @staticmethod
    def find_free_port(preferred: int) -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", preferred))
                return preferred
            except OSError:
                pass
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])


def default_model_path() -> Path:
    return BACKEND_DIR / "data"
