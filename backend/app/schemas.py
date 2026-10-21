"""Pydantic schemas shared by the API and the vLLM process manager."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ServerState = Literal["stopped", "starting", "running", "stopping", "error"]

_DANGEROUS_ARG = re.compile(r"[\n\r\0;|&`$<>]")


def _validate_extra_args(args: list[str]) -> list[str]:
    cleaned: list[str] = []
    for arg in args:
        arg = arg.strip()
        if not arg:
            continue
        if len(arg) > 512:
            raise ValueError("Each extra argument must be 512 characters or fewer.")
        if _DANGEROUS_ARG.search(arg):
            raise ValueError(f"Argument contains unsupported characters: {arg!r}")
        cleaned.append(arg)
    if cleaned and not cleaned[0].startswith("-"):
        raise ValueError("Extra arguments must begin with a vLLM flag such as '--enable-prefix-caching'.")
    if len(cleaned) > 40:
        raise ValueError("At most 40 extra vLLM arguments are allowed.")
    return cleaned


class ServerConfig(BaseModel):
    """Parameters used to launch the vLLM OpenAI-compatible server."""

    model_config = ConfigDict(extra="forbid")

    model: str = Field(
        default="Qwen/Qwen2.5-1.5B-Instruct",
        min_length=1,
        max_length=512,
        description="Hugging Face model id or absolute path to a local model directory.",
    )
    served_model_name: str | None = Field(
        default=None,
        max_length=128,
        description="Name exposed by the OpenAI API. Defaults to the model id.",
    )
    max_model_len: int = Field(default=4096, ge=256, le=1_048_576)
    gpu_memory_utilization: float = Field(default=0.88, ge=0.05, le=0.99)
    tensor_parallel_size: int = Field(default=1, ge=1, le=16)
    dtype: Literal["auto", "float16", "bfloat16", "float32"] = "auto"
    quantization: Literal[
        "awq", "gptq", "fp8", "bitsandbytes", "gguf", "aqlm", "marlin", "smoothquant"
    ] | None = None
    trust_remote_code: bool = False
    enforce_eager: bool = False
    max_num_seqs: int | None = Field(default=None, ge=1, le=4096)
    extra_args: list[str] = Field(default_factory=list)

    @field_validator("model")
    @classmethod
    def _clean_model(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A model name or path is required.")
        if "://" in value:
            raise ValueError("Use a Hugging Face model id (org/name) or a local path, not a URL.")
        return value

    @field_validator("served_model_name")
    @classmethod
    def _clean_served_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("extra_args")
    @classmethod
    def _clean_extra_args(cls, value: list[str]) -> list[str]:
        return _validate_extra_args(value)

    @model_validator(mode="after")
    def _no_duplicate_core_flags(self) -> ServerConfig:
        reserved = {
            "--model",
            "--host",
            "--port",
            "--max-model-len",
            "--gpu-memory-utilization",
            "--tensor-parallel-size",
            "--dtype",
            "--quantization",
            "--served-model-name",
            "--trust-remote-code",
            "--enforce-eager",
            "--max-num-seqs",
        }
        for arg in self.extra_args:
            flag = arg.split("=", 1)[0]
            if flag in reserved:
                raise ValueError(
                    f"{flag} is managed by the form above; remove it from extra arguments."
                )
        return self

    @property
    def api_model_name(self) -> str:
        """The model id clients should send to the OpenAI API."""
        if self.served_model_name:
            return self.served_model_name
        # Support Hugging Face ids, POSIX paths, and Windows-style local paths.
        name = re.split(r"[/\\]", self.model.rstrip("/\\"))[-1]
        return name or self.model


class ServerStatus(BaseModel):
    state: ServerState
    model: str | None = None
    api_model_name: str | None = None
    base_url: str | None = None
    pid: int | None = None
    started_at: datetime | None = None
    uptime_seconds: float | None = None
    exit_code: int | None = None
    healthy: bool = False
    error: str | None = None
    hint: str | None = None
    log_tail: list[str] = Field(default_factory=list)
    config: ServerConfig | None = None
    mock: bool = False


class LogEntry(BaseModel):
    seq: int
    timestamp: datetime
    stream: Literal["stdout", "stderr", "system"]
    message: str


class LogsResponse(BaseModel):
    entries: list[LogEntry]
    next_seq: int
    dropped: int = 0


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(max_length=200_000)
    name: str | None = Field(default=None, max_length=64)


class SamplingParams(BaseModel):
    """OpenAI-compatible sampling controls, validated for sane local use."""

    model_config = ConfigDict(extra="forbid")

    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, gt=0.0, le=1.0)
    top_k: int = Field(default=-1, ge=-1, le=1000)
    max_tokens: int = Field(default=1024, ge=1, le=131_072)
    repetition_penalty: float = Field(default=1.0, gt=0.0, le=2.0)
    presence_penalty: float = Field(default=0.0, ge=-2.0, le=2.0)
    frequency_penalty: float = Field(default=0.0, ge=-2.0, le=2.0)
    stop: list[str] | None = Field(default=None, max_length=8)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


class ChatRequest(SamplingParams):
    """Request body for the workbench chat proxy (and OpenAI /v1/chat/completions)."""

    messages: list[ChatMessage] = Field(min_length=1, max_length=400)
    model: str | None = None
    stream: bool = True
    source: Literal["playground", "compare", "sweep", "api"] = "playground"

    @field_validator("messages")
    @classmethod
    def _message_sanity(cls, value: list[ChatMessage]) -> list[ChatMessage]:
        if not any(message.role == "user" for message in value):
            raise ValueError("At least one user message is required.")
        return value

    def to_upstream_payload(self, model: str, *, stream: bool) -> dict:
        payload: dict = {
            "model": model,
            "messages": [message.model_dump(exclude_none=True) for message in self.messages],
            "temperature": self.temperature,
            "top_p": self.top_p,
            "max_tokens": self.max_tokens,
            "presence_penalty": self.presence_penalty,
            "frequency_penalty": self.frequency_penalty,
            "stream": stream,
        }
        if self.top_k != -1:
            payload["top_k"] = self.top_k
        if self.repetition_penalty != 1.0:
            payload["repetition_penalty"] = self.repetition_penalty
        if self.stop:
            payload["stop"] = self.stop
        if self.seed is not None:
            payload["seed"] = self.seed
        if stream:
            payload["stream_options"] = {"include_usage": True}
        return payload


SweepParameter = Literal[
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "repetition_penalty",
    "presence_penalty",
    "frequency_penalty",
]


class SweepRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=400)
    parameter: SweepParameter
    values: list[float] = Field(min_length=1, max_length=12)
    runs_per_value: int = Field(default=1, ge=1, le=5)
    concurrency: int = Field(default=2, ge=1, le=8)
    sampling: SamplingParams = Field(default_factory=SamplingParams)

    @field_validator("values")
    @classmethod
    def _unique_values(cls, value: list[float]) -> list[float]:
        deduped: list[float] = []
        for item in value:
            if not any(abs(item - existing) < 1e-9 for existing in deduped):
                deduped.append(item)
        if len(deduped) < 2:
            raise ValueError("Provide at least two distinct parameter values.")
        return deduped


class SweepResult(BaseModel):
    value: float
    run: int
    ok: bool
    output: str = ""
    error: str | None = None
    latency_ms: float = 0.0
    ttft_ms: float | None = None
    completion_tokens: int = 0
    tokens_per_second: float | None = None
    finish_reason: str | None = None


class SweepBucket(BaseModel):
    value: float
    runs: int
    errors: int
    avg_latency_ms: float
    avg_ttft_ms: float | None = None
    avg_tokens_per_second: float | None = None
    avg_completion_tokens: float


class SweepResponse(BaseModel):
    parameter: SweepParameter
    results: list[SweepResult]
    buckets: list[SweepBucket]
    duration_ms: float


class RequestMetric(BaseModel):
    id: str
    created_at: datetime
    source: str
    model: str
    stream: bool
    prompt_tokens: int
    completion_tokens: int
    ttft_ms: float | None = None
    latency_ms: float
    inter_token_ms: float | None = None
    tokens_per_second: float | None = None
    finish_reason: str | None = None
    status: Literal["ok", "error", "aborted"]
    error: str | None = None
    parameters: dict[str, float | int | str | None] = Field(default_factory=dict)


class SeriesPoint(BaseModel):
    timestamp: datetime
    requests: int
    tokens: int
    errors: int
    avg_tokens_per_second: float | None = None
    avg_ttft_ms: float | None = None


class MetricsSummary(BaseModel):
    requests: int
    successes: int
    errors: int
    prompt_tokens: int
    completion_tokens: int
    tokens_per_second: float | None = None
    avg_ttft_ms: float | None = None
    p50_ttft_ms: float | None = None
    p95_ttft_ms: float | None = None
    avg_latency_ms: float | None = None


class VLLMGauges(BaseModel):
    running_requests: int | None = None
    waiting_requests: int | None = None
    kv_cache_usage: float | None = None
    engine_awake: bool | None = None


class VLLMCounterRates(BaseModel):
    generation_tokens_per_second: float | None = None
    prompt_tokens_per_second: float | None = None


class VLLMLatencies(BaseModel):
    ttft_p50_ms: float | None = None
    ttft_p95_ms: float | None = None
    inter_token_p50_ms: float | None = None
    inter_token_p95_ms: float | None = None


class VLLMMetrics(BaseModel):
    available: bool = False
    gauges: VLLMGauges = Field(default_factory=VLLMGauges)
    rates: VLLMCounterRates = Field(default_factory=VLLMCounterRates)
    latencies: VLLMLatencies = Field(default_factory=VLLMLatencies)
    total_prompt_tokens: int | None = None
    total_generation_tokens: int | None = None
    prefix_cache_hit_rate: float | None = None


class GPUMetric(BaseModel):
    index: int
    name: str
    memory_used_mb: float | None = None
    memory_total_mb: float | None = None
    utilization_percent: float | None = None
    temperature_c: float | None = None


class StreamInfo(BaseModel):
    """Metadata about the live stream frame that carried this snapshot."""

    sequence: int
    sample_ms: float
    interval_s: float
    subscribers: int
    dropped: int = 0


class MetricsSnapshot(BaseModel):
    timestamp: datetime
    server: ServerStatus
    vllm: VLLMMetrics
    gpus: list[GPUMetric] = Field(default_factory=list)
    summary: MetricsSummary
    series: list[SeriesPoint] = Field(default_factory=list)
    recent: list[RequestMetric] = Field(default_factory=list)
    stream: StreamInfo | None = None


class ModelSearchHit(BaseModel):
    id: str
    downloads: int = 0
    likes: int = 0
    tags: list[str] = Field(default_factory=list)
    pipeline_tag: str | None = None
    gated: bool = False


class DownloadRequest(BaseModel):
    repo_id: str = Field(min_length=3, max_length=256)
    revision: str | None = Field(default=None, max_length=128)

    @field_validator("repo_id")
    @classmethod
    def _safe_repo_id(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9][\w.\-]*/[A-Za-z0-9][\w.\-]*", value):
            raise ValueError("Expected a repository id such as Qwen/Qwen2.5-1.5B-Instruct.")
        return value


class DownloadJob(BaseModel):
    id: str
    repo_id: str
    revision: str | None = None
    state: Literal["queued", "running", "completed", "error"]
    error: str | None = None
    path: str | None = None
    bytes_downloaded: int = 0
    started_at: datetime
    finished_at: datetime | None = None


class ModelDownloadOptions(BaseModel):
    repo_id: str = "Qwen/Qwen2.5-1.5B-Instruct"
    max_model_len: int = 4096
    gpu_memory_utilization: float = 0.88
    quantization: str | None = None


class LocalModel(BaseModel):
    id: str
    path: str
    size_bytes: int | None = None


class SystemInfo(BaseModel):
    backend_version: str
    python_version: str
    vllm_version: str | None = None
    mock_mode: bool
    data_dir: str
    gpus: list[GPUMetric] = Field(default_factory=list)
    platform: str
    environment_vars: dict[str, str] = Field(default_factory=dict)
