export type ServerState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ServerConfig {
  model: string;
  served_model_name: string | null;
  max_model_len: number;
  gpu_memory_utilization: number;
  tensor_parallel_size: number;
  dtype: "auto" | "float16" | "bfloat16" | "float32";
  quantization:
    | "awq"
    | "gptq"
    | "fp8"
    | "bitsandbytes"
    | "gguf"
    | "aqlm"
    | "marlin"
    | "smoothquant"
    | null;
  trust_remote_code: boolean;
  enforce_eager: boolean;
  max_num_seqs: number | null;
  extra_args: string[];
}

export interface ServerStatus {
  state: ServerState;
  model: string | null;
  api_model_name: string | null;
  base_url: string | null;
  pid: number | null;
  started_at: string | null;
  uptime_seconds: number | null;
  exit_code: number | null;
  healthy: boolean;
  error: string | null;
  hint: string | null;
  log_tail: string[];
  config: ServerConfig | null;
  mock: boolean;
}

export interface LogEntry {
  seq: number;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface SamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  repetition_penalty: number;
  presence_penalty: number;
  frequency_penalty: number;
}

export interface ChatRequestPayload extends SamplingParams {
  messages: ChatMessageInput[];
  stream: boolean;
  source?: "playground" | "compare" | "sweep" | "api";
  seed?: number | null;
}

export interface GenerationMetrics {
  request_id: string;
  ttft_ms: number | null;
  latency_ms: number;
  inter_token_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  tokens_per_second: number | null;
  finish_reason: string | null;
  status: "ok" | "error" | "aborted";
}

export interface RequestMetric {
  id: string;
  created_at: string;
  source: string;
  model: string;
  stream: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  ttft_ms: number | null;
  latency_ms: number;
  inter_token_ms: number | null;
  tokens_per_second: number | null;
  finish_reason: string | null;
  status: "ok" | "error" | "aborted";
  error: string | null;
  parameters: Record<string, string | number | null>;
}

export interface SeriesPoint {
  timestamp: string;
  requests: number;
  tokens: number;
  errors: number;
  avg_tokens_per_second: number | null;
  avg_ttft_ms: number | null;
}

export interface StreamInfo {
  sequence: number;
  sample_ms: number;
  interval_s: number;
  subscribers: number;
  dropped: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  server: ServerStatus;
  vllm: {
    available: boolean;
    gauges: {
      running_requests: number | null;
      waiting_requests: number | null;
      kv_cache_usage: number | null;
      engine_awake: boolean | null;
    };
    rates: {
      generation_tokens_per_second: number | null;
      prompt_tokens_per_second: number | null;
    };
    latencies: {
      ttft_p50_ms: number | null;
      ttft_p95_ms: number | null;
      inter_token_p50_ms: number | null;
      inter_token_p95_ms: number | null;
    };
    total_prompt_tokens: number | null;
    total_generation_tokens: number | null;
    prefix_cache_hit_rate: number | null;
  };
  gpus: GPUMetric[];
  summary: {
    requests: number;
    successes: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    tokens_per_second: number | null;
    avg_ttft_ms: number | null;
    p50_ttft_ms: number | null;
    p95_ttft_ms: number | null;
    avg_latency_ms: number | null;
  };
  series: SeriesPoint[];
  recent: RequestMetric[];
  /** Present only on frames pushed over the SSE stream. */
  stream?: StreamInfo | null;
}

export interface GPUMetric {
  index: number;
  name: string;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  utilization_percent: number | null;
  temperature_c: number | null;
}

export interface SystemInfo {
  backend_version: string;
  python_version: string;
  vllm_version: string | null;
  mock_mode: boolean;
  data_dir: string;
  gpus: GPUMetric[];
  platform: string;
  environment_vars: Record<string, string>;
}

export interface ModelSearchHit {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
  pipeline_tag: string | null;
  gated: boolean;
}

export interface LocalModel {
  id: string;
  path: string;
  size_bytes: number | null;
}

export interface DownloadJob {
  id: string;
  repo_id: string;
  revision: string | null;
  state: "queued" | "running" | "completed" | "error";
  error: string | null;
  path: string | null;
  bytes_downloaded: number;
  started_at: string;
  finished_at: string | null;
}

export type SweepParameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "max_tokens"
  | "repetition_penalty"
  | "presence_penalty"
  | "frequency_penalty";

export interface SweepResult {
  value: number;
  run: number;
  ok: boolean;
  output: string;
  error: string | null;
  latency_ms: number;
  ttft_ms: number | null;
  completion_tokens: number;
  tokens_per_second: number | null;
  finish_reason: string | null;
}

export interface SweepBucket {
  value: number;
  runs: number;
  errors: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  avg_tokens_per_second: number | null;
  avg_completion_tokens: number;
}

export interface SweepResponse {
  parameter: SweepParameter;
  results: SweepResult[];
  buckets: SweepBucket[];
  duration_ms: number;
}

/* ------------------------------- UI state -------------------------------- */

export interface ChatMetricMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metrics?: GenerationMetrics | null;
  error?: string | null;
  hint?: string | null;
  stopped?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  systemPrompt: string;
  params: SamplingParams;
  messages: ChatMetricMessage[];
}

export interface ComparePaneState {
  params: SamplingParams;
  output: string;
  metrics: GenerationMetrics | null;
  error: string | null;
  hint: string | null;
  status: "idle" | "streaming" | "done" | "error" | "stopped";
}

export interface PromptHistoryItem {
  id: string;
  prompt: string;
  createdAt: string;
}
