import type {
  ChatRequestPayload,
  DownloadJob,
  GenerationMetrics,
  LocalModel,
  LogEntry,
  MetricsSnapshot,
  ModelSearchHit,
  SamplingParams,
  ServerConfig,
  ServerStatus,
  SweepResponse,
  SystemInfo,
} from "./types";

// Kept deterministic between server and browser to avoid hydration mismatches.
// Remote/LAN deployments should set NEXT_PUBLIC_API_URL at build time.
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  status: number;
  code: string;
  hint: string | null;
  details: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      hint?: string | null;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "client_error";
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

interface BackendErrorBody {
  error?: {
    message?: string;
    type?: string;
    hint?: string | null;
    details?: unknown;
  };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new ApiError("The request was cancelled.", {
        code: "aborted",
        hint: null,
      });
    }
    throw new ApiError(
      `Cannot reach the workbench backend at ${API_BASE}.`,
      {
        code: "network_error",
        hint: "Make sure the FastAPI backend is running (uvicorn app.main:app --port 8000), then retry.",
      },
    );
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", onAbort);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = parsed as BackendErrorBody | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      {
        status: response.status,
        code: body?.error?.type ?? "http_error",
        hint: body?.error?.hint ?? null,
        details: body?.error?.details ?? null,
      },
    );
  }

  return parsed as T;
}

export const api = {
  status: () => request<ServerStatus>("/api/server/status"),
  config: () => request<ServerConfig>("/api/server/config"),
  updateConfig: (config: ServerConfig) =>
    request<ServerConfig>("/api/server/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  start: (config?: ServerConfig) =>
    request<ServerStatus>("/api/server/start", {
      method: "POST",
      body: JSON.stringify(config ? { config } : {}),
    }),
  stop: () => request<ServerStatus>("/api/server/stop", { method: "POST" }),
  restart: (config?: ServerConfig) =>
    request<ServerStatus>("/api/server/restart", {
      method: "POST",
      body: JSON.stringify(config ? { config } : {}),
    }),
  logs: (afterSeq = 0, limit = 500) =>
    request<{ entries: LogEntry[]; next_seq: number; dropped: number }>(
      `/api/server/logs?after_seq=${afterSeq}&limit=${limit}`,
    ),
  clearLogs: () =>
    request<void>("/api/server/logs", { method: "DELETE" }),
  metrics: () => request<MetricsSnapshot>("/api/metrics", {}, 12_000),
  clearMetrics: () => request<void>("/api/metrics", { method: "DELETE" }),
  system: () => request<SystemInfo>("/api/system"),
  searchModels: (query: string) =>
    request<ModelSearchHit[]>(
      `/api/models/search?q=${encodeURIComponent(query)}&limit=12`,
    ),
  localModels: () => request<LocalModel[]>("/api/models/local"),
  listDownloads: () => request<DownloadJob[]>("/api/models/downloads"),
  downloadModel: (repoId: string) =>
    request<DownloadJob>("/api/models/download", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId }),
    }),
  downloadStatus: (jobId: string) =>
    request<DownloadJob>(`/api/models/downloads/${jobId}`),
  sweep: (payload: SweepRequest) =>
    request<SweepResponse>(
      "/api/sweep",
      { method: "POST", body: JSON.stringify(payload) },
      180_000,
    ),
};

export interface SweepRequest {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  parameter: string;
  values: number[];
  runs_per_value: number;
  concurrency: number;
  sampling: SamplingParams;
}

/* ---------------------------- streaming chat ----------------------------- */

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "metrics"; metrics: GenerationMetrics }
  | { type: "error"; message: string; hint: string | null }
  | { type: "aborted" }
  | { type: "done" };

interface SSEBlock {
  event: string;
  data: string;
}

function parseBlock(block: string): SSEBlock {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join("\n") };
}

export async function* streamChat(
  payload: ChatRequestPayload,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      yield { type: "aborted" };
      return;
    }
    throw new ApiError(`Cannot reach the workbench backend at ${API_BASE}.`, {
      code: "network_error",
      hint: "Check that the backend is running, then try again.",
    });
  }

  if (!response.ok) {
    const text = await response.text();
    let parsed: BackendErrorBody | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    throw new ApiError(
      parsed?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      {
        status: response.status,
        code: parsed?.error?.type ?? "http_error",
        hint: parsed?.error?.hint ?? null,
        details: parsed?.error?.details ?? null,
      },
    );
  }

  if (!payload.stream) {
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (content) yield { type: "delta", text: String(content) };
    yield { type: "done" };
    return;
  }

  if (!response.body) {
    throw new ApiError("The backend returned an empty stream.", {
      code: "empty_stream",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          yield { type: "aborted" };
          return;
        }
        throw new ApiError("The connection to the backend was interrupted.", {
          code: "stream_interrupted",
          hint: "The model may have crashed. Check the Server page and restart it.",
        });
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim() || block.trimStart().startsWith(":")) continue;
        const { event, data } = parseBlock(block);
        if (!data) continue;

        if (event === "workbench.metrics") {
          try {
            yield { type: "metrics", metrics: JSON.parse(data) as GenerationMetrics };
          } catch {
            // Metrics are best-effort; never break the content stream.
          }
          continue;
        }
        if (event === "error") {
          try {
            const parsed = JSON.parse(data);
            yield {
              type: "error",
              message:
                parsed?.error?.message ?? "The model returned an error.",
              hint: parsed?.error?.hint ?? null,
            };
          } catch {
            yield { type: "error", message: "The model returned an error.", hint: null };
          }
          continue;
        }
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed?.choices?.[0];
          const text =
            choice?.delta?.content ??
            choice?.delta?.reasoning_content ??
            null;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "delta", text };
          }
        } catch {
          // Ignore malformed keepalives / vendor extensions.
        }
      }
    }
    yield { type: "done" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
