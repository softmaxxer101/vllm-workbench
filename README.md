# vLLM Inference Workbench

A local-first studio for running and inspecting your own LLM. It supervises a real
[vLLM](https://docs.vllm.ai) engine on your GPU, streams chat, compares sampling settings,
sweeps parameters, and shows live latency, throughput and hardware telemetry — all from one
interface.

**Stack:** Next.js 15 (App Router) · FastAPI · vLLM · Zustand · React Query · Recharts · Tailwind

New to the interface? The **[User Guide](docs/USER_GUIDE.md)** walks through every screen, setting
and shortcut.

> **Hosting note — read this before deploying anything.** GitHub Pages can only serve static
> files. It cannot run Python, FastAPI, the vLLM process, or any GPU work. This repository
> includes a GitHub Pages workflow, but it publishes **only the interface**; the UI needs a
> separately hosted backend to do anything. For actual LLM use, run the stack on the machine
> with the GPU — see [Running it locally with a local LLM](docs/LOCAL_LLM.md). The Pages path and
> its limits are documented in [Deploying to GitHub Pages](docs/DEPLOYMENT.md).

```
┌────────────────────────────┐          ┌──────────────────────────────────┐
│  Next.js 15 UI (port 3000) │  REST    │  FastAPI supervisor (port 8000)  │
│  chat · compare · sweep    │ ───────► │  lifecycle · proxy · metrics      │
│  metrics · server control  │   SSE    │  OpenAI-compatible /v1 surface    │
└────────────────────────────┘          └───────────────┬──────────────────┘
                                                        │ subprocess
                                              ┌─────────▼──────────┐
                                              │ vLLM OpenAI server │
                                              │     port 8001      │
                                              │  GPU · KV cache    │
                                              └────────────────────┘
```

The browser talks only to FastAPI. FastAPI owns exactly one vLLM subprocess, proxies all
generation traffic (including Server-Sent Events), and scrapes vLLM's Prometheus endpoint for
engine metrics. Nothing is sent to a hosted inference provider.

---

## What it does

**Engine control** — start, stop and restart vLLM; configure model, context length, GPU memory
utilization, tensor parallelism, dtype, quantization and extra flags; watch colour-coded startup
logs stream in; get crash detection with OOM, gated-model and driver hints.

**Playground** — streaming chat with Markdown and syntax highlighting, live sampling controls,
system prompts, regenerate/stop, per-message TTFT and tokens/s, and locally persisted history.

**Compare** — one prompt, two independent parameter sets, streamed side by side.

**Sweep** — run a parameter across up to 12 values with bounded concurrency and compare latency,
throughput and outputs in a chart, table and CSV export.

**Telemetry** — a single 1 Hz sampler fans full snapshots out over SSE to every open tab, with
sequence ids, sample timing and drop counts. The dashboard shows decode rate, TTFT p50/p95, queue
depth, KV-cache occupancy, VRAM and GPU utilization; a compact strip in the shell header shows
throughput and queue depth on every page. Slow clients drop old frames rather than stalling the
sampler, reconnects honour `Last-Event-ID`, and the UI distinguishes live / stalled / reconnecting
/ paused states.

**OpenAI-compatible API** — `POST /v1/chat/completions` (streaming and non-streaming) and
`GET /v1/models`, so other tools can use the same engine. Optional bearer-key protection via
`WORKBENCH_API_KEY`.

**Model helper** — search Hugging Face, check cached models, and download weights in the
background before launching.

---

## Quick start (Docker Compose)

You need an NVIDIA GPU, a recent driver, the NVIDIA Container Toolkit, Docker Compose v2, and
Linux or WSL2 (vLLM does not run natively on Windows or macOS). Roughly 15 GB of disk for the
image plus model weights.

```bash
git clone <your-repo> vllm-workbench
cd vllm-workbench

cp .env.example .env          # optional, but review it
docker compose up --build
```

- UI: <http://localhost:3000>
- API docs: <http://localhost:8000/docs>
- Health: <http://localhost:8000/api/health>

Open **Server → Start engine**. The first launch downloads the default model
(`Qwen/Qwen2.5-1.5B-Instruct`, about 3 GB) and can take several minutes; progress appears in the
live log panel.

> No GPU yet? `WORKBENCH_VLLM_MOCK=1` runs a simulated engine (streaming tokens, fake Prometheus
> metrics) so you can explore the UI. It never loads a model.

The full walkthrough — driver checks, model sizing, gated models, LAN access, tuning and
troubleshooting — is in **[docs/LOCAL_LLM.md](docs/LOCAL_LLM.md)**.

---

## Running it locally with a local LLM

Short version:

1. **Check the GPU** — `nvidia-smi` must work, and
   `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` must print the card.
2. **Start the stack** — `docker compose up -d --build`.
3. **Pick a model** — the default 1.5B model fits 6–8 GB of VRAM. Larger cards can run 7B–32B,
   usually with quantization; the sizing table is in the local guide.
4. **Start the engine** — Server page, review the configuration, press **Start engine**, and watch
   the log until the state is *running*.
5. **Use it** — chat in the Playground, or point any OpenAI SDK at
   `http://localhost:8000/v1` with an arbitrary model name.

Detailed requirements, model-per-VRAM recommendations, quantized options, gated-model tokens,
memory tuning, LAN sharing, data locations and OOM fixes live in
**[docs/LOCAL_LLM.md](docs/LOCAL_LLM.md)**.

---

## Deploying the interface to GitHub Pages

Yes, the frontend can be published as a static site. No, that does not give anyone a working LLM
app: Pages has no backend, no Python and no GPU, and the UI's control plane (`/api`) is not
authenticated, so exposing a real backend publicly is unsafe without extra protection.

The repository ships a workflow at [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
that builds a static export (`NEXT_EXPORT=1`) with the correct base path and publishes it. In
short:

1. Push the repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Optionally set a repository variable `NEXT_PUBLIC_API_URL` (e.g. `https://gpu.example.com`) so
   the published UI knows where a backend lives. Without it, it targets `http://localhost:8000`
   and will show "backend unreachable" for visitors.
4. Run **Actions → Deploy UI to GitHub Pages → Run workflow**. (The workflow is manual so
   repositories without Pages enabled do not get failing runs; add a `push` trigger once it works.)

Project pages are served from `/<repo-name>` (the workflow sets the base path automatically);
`<user>.github.io` repositories and custom domains are served from `/` and need no base path.
Every requirement, the security caveats and the failure modes are documented in
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

To build the static export yourself:

```bash
cd frontend
NEXT_EXPORT=1 NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 pnpm build
# static site in frontend/out/
```

---

## Development

**Backend** — Python 3.11 or 3.12, [uv](https://docs.astral.sh/uv/):

```bash
cd backend
uv sync --dev

# UI work without a GPU: simulated OpenAI + Prometheus engine
WORKBENCH_VLLM_MOCK=1 uv run uvicorn app.main:app --reload --port 8000

# Real engine (Linux + CUDA): install vLLM into the environment first
#   uv pip install vllm==0.32.0
uv run uvicorn app.main:app --reload --port 8000
```

**Frontend** — Node 20.9+, pnpm 10:

```bash
cd frontend
pnpm install
pnpm dev            # http://localhost:3000
pnpm typecheck
pnpm build
```

The browser calls `http://localhost:8000` by default. To point it elsewhere locally, copy
[`frontend/.env.example`](frontend/.env.example) to `frontend/.env.local` and set
`NEXT_PUBLIC_API_URL`. Docker Compose reads the root `.env` instead.

**Tests** — the integration suite starts the mock engine as a real subprocess; no GPU required.

```bash
cd backend
uv run pytest -q
```

---

## Configuration

Backend settings use the `WORKBENCH_` prefix and can live in the root `.env` or `backend/.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKBENCH_API_KEY` | empty | Bearer key for `/v1/*`; empty means open. |
| `WORKBENCH_CORS_ORIGINS` | localhost:3000, 127.0.0.1:3000 | Browser origins allowed to call the API. |
| `WORKBENCH_HOST` / `WORKBENCH_PORT` | `0.0.0.0` / `8000` | FastAPI bind address. |
| `WORKBENCH_VLLM_HOST` / `WORKBENCH_VLLM_PORT` | `127.0.0.1` / `8001` | Internal vLLM address. |
| `WORKBENCH_VLLM_LAUNCH` | `vllm serve` | Launcher command for older images. |
| `WORKBENCH_STARTUP_TIMEOUT_S` | `900` | Seconds to wait for engine health. |
| `WORKBENCH_DATA_DIR` | `backend/data` / `/data` | Config, downloads and HF cache. |
| `WORKBENCH_VLLM_MOCK` | `false` | Simulated engine for UI work and CI. |
| `WORKBENCH_GPU_PROBE` | `true` | Collect `nvidia-smi` hardware metrics. |
| `WORKBENCH_REQUEST_TIMEOUT_S` | `300` | Per-completion timeout. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend at build time. |
| `HF_TOKEN` | empty | Hugging Face token for gated models. |

Every backend setting, plus model sizing and tuning, is covered in the local guide.

---

## OpenAI-compatible API

The backend injects the active model name, so clients may send any model id.

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen2.5-1.5B-Instruct",
    "messages": [{"role": "user", "content": "Explain PagedAttention briefly."}],
    "temperature": 0.4,
    "stream": true
  }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused-unless-set")
stream = client.chat.completions.create(
    model="Qwen2.5-1.5B-Instruct",
    messages=[{"role": "user", "content": "Hello from a local tool"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend liveness and engine state. |
| `GET` | `/api/server/status` | Engine state and configuration. |
| `GET/PUT` | `/api/server/config` | Read/persist launch config (while stopped). |
| `POST` | `/api/server/start` · `/stop` · `/restart` | Lifecycle. |
| `GET` | `/api/server/logs` · `/logs/stream` | Log buffer / SSE tail. |
| `POST` | `/api/chat/completions` | Streaming chat used by the UI. |
| `GET` | `/api/metrics` | Single snapshot: proxy timings, Prometheus, GPU, charts. |
| `GET` | `/api/metrics/stream` | SSE telemetry (1 Hz sampler, reconnect-safe). |
| `GET` | `/api/metrics/stream/stats` | Sampler diagnostics: subscribers, cadence, drops. |
| `POST` | `/api/sweep` | Bounded-concurrency parameter sweep. |
| `GET` | `/api/models/search` · `/local` | Hugging Face search and cached models. |
| `POST` | `/api/models/download` | Background `snapshot_download`. |
| `GET` | `/v1/models` · `POST /v1/chat/completions` | OpenAI-compatible surface. |

The UI-facing `/api/chat/completions` stream adds one `event: workbench.metrics` frame with TTFT,
tokens/s and token counts before `data: [DONE]`. The `/v1` stream is standard OpenAI chunks, safe
with official SDKs.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + Enter` | Send message / run |
| `Ctrl/⌘ + K` or `/` | Focus the composer |
| `Esc` | Stop streaming / close dialogs |
| `Ctrl/⌘ + Shift + K` | Clear the playground conversation |
| `G` then `P / C / S / M / E` | Playground / Compare / Sweep / Metrics / Server |
| `?` | Shortcut reference |

---

## Security

This is a local development tool, not a multi-tenant service.

- The `/v1` endpoints can require a bearer key (`WORKBENCH_API_KEY`); the `/api` control plane does
  **not** have authentication. Anyone who can reach port 8000 can start and stop the engine,
  download models and run sweeps.
- The UI calls `/api` without credentials, so putting HTTP basic auth in front of the backend will
  block the UI unless you also change how requests are made.
- Do not expose ports 8000 or 3000 to the internet. For remote access, use a private network
  (Tailscale/WireGuard) or a reverse proxy you control, and read
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) first.
- Model arguments are passed as an argv array without shell interpolation, but
  `trust_remote_code` executes model code — only enable it for repositories you trust.

---

## Project structure

```
.
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI factory, middleware, lifespan
│   │   ├── manager.py       # vLLM subprocess supervisor
│   │   ├── proxy.py         # SSE/OpenAI proxy + request timing
│   │   ├── metrics.py       # Prometheus parser, GPU poller, history
│   │   ├── telemetry.py     # 1 Hz sampler + SSE fan-out, backpressure
│   │   ├── auth.py          # optional bearer key for /v1
│   │   ├── mock_vllm.py     # simulated engine for development
│   │   ├── routes/          # server, chat, metrics, sweep, models, /v1
│   │   └── schemas.py       # validation contracts
│   ├── tests/               # integration + parser tests
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/
│   ├── app/                 # playground, compare, sweep, metrics, server
│   ├── components/          # shell, chat, telemetry, shadcn primitives
│   ├── hooks/               # shared SSE store, React Query, logs, hotkeys
│   ├── lib/                 # typed API client, store, formatters
│   └── Dockerfile
├── docs/
│   ├── USER_GUIDE.md        # what each screen does and how to use it
│   ├── LOCAL_LLM.md         # run the stack against a real local model
│   └── DEPLOYMENT.md        # GitHub Pages, hosting and security
├── .github/workflows/pages.yml
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Backend unreachable" in the UI | Check `curl localhost:8000/api/health`; confirm `NEXT_PUBLIC_API_URL` and rebuild the frontend after changing it. |
| Engine stuck on *starting* | First launch is downloading weights — watch the log; raise `WORKBENCH_STARTUP_TIMEOUT_S` on slow links. |
| CUDA out of memory | Lower GPU memory utilization or context length, use a quantized checkpoint, or a smaller model. |
| “could not select device driver” | Install the NVIDIA Container Toolkit and test `docker run --rm --gpus all … nvidia-smi`. |
| Metrics show “vLLM internals unavailable” | The engine build lacks `/metrics`, or it is still starting. Proxy timings still work. |
| Port already in use | 3000 = UI, 8000 = API, 8001 = internal vLLM. Change host ports and `NEXT_PUBLIC_API_URL`. |
| Pages shows a blank page or 404 assets | The base path is wrong; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |

---

## Documentation

- **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** — a tour of the interface: first run, every page,
  reading metrics, workflows, shortcuts, troubleshooting.
- **[docs/LOCAL_LLM.md](docs/LOCAL_LLM.md)** — hardware, install, model choice, tuning, LAN access,
  data, troubleshooting.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — GitHub Pages step by step, base paths, backend
  hosting, HTTPS/CORS, security limits.

## License

No license file is included yet. Add one (for example MIT) before publishing or distributing this
project.
