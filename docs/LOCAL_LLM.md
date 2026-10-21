# Running it locally with your own LLM

This is the guide for using the workbench as an actual local inference tool: your GPU, your
weights, no hosted API. It covers the hardware you need, the two install paths, choosing a model
that fits your VRAM, starting the engine, connecting other tools, tuning and troubleshooting.

If you only want to click around the interface without a GPU, jump to
[Exploring without a GPU](#exploring-without-a-gpu).

---

## What you are running

```
Browser ──► FastAPI (8000) ──► vLLM (8001) ──► your GPU
              │
              └── starts, stops, proxies and measures the engine
```

The FastAPI process is a supervisor, not the model server. It launches exactly one `vllm serve`
subprocess, proxies streaming responses, and scrapes Prometheus metrics from it. When you press
**Stop**, the GPU memory is released.

---

## 1. Hardware and operating system

| Requirement | What you need |
| --- | --- |
| GPU | An NVIDIA GPU with enough VRAM for your model. 6–8 GB runs 1–3B models; 16–24 GB runs 7–14B; 48 GB+ runs 32B. |
| Driver | A driver current enough for CUDA 12. `nvidia-smi` must work and report your card. |
| OS | Linux, or Windows with WSL2. vLLM does not run natively on Windows or macOS. |
| Docker | Docker Engine/Desktop with Compose v2. |
| NVIDIA Container Toolkit | Required for GPU passthrough into containers. |
| Disk | ~10 GB for the vLLM image plus model weights (1–2 GB for small models, 15–50 GB+ for large or unquantized ones). |
| RAM | 16 GB is a practical minimum; large models need more for loading and the page cache. |

CPU-only inference is not supported by this stack. An Apple Silicon Mac cannot run vLLM; use the
mock engine for UI work, or run a small model on a Linux/WSL2 machine with an NVIDIA card.

### Verify the GPU before anything else

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

The second command must print the same GPU table from inside a container. If it fails with
`could not select device driver`, install the NVIDIA Container Toolkit and restart Docker.

---

## 2. Install the stack

```bash
git clone <your-repo> vllm-workbench
cd vllm-workbench
```

Create the environment file (optional, but review it):

```bash
cp .env.example .env
```

Start the two services:

```bash
docker compose up --build
```

This builds:

- `backend` — the official `vllm/vllm-openai` image plus the FastAPI supervisor, published on
  port 8000, with the GPU and a persistent `/data` volume;
- `frontend` — the Next.js UI, published on port 3000, with the backend URL baked into the bundle
  at build time.

Open:

- UI — <http://localhost:3000>
- API documentation — <http://localhost:8000/docs>
- Health — <http://localhost:8000/api/health>

The first build pulls several gigabytes. Run it detached if you prefer:

```bash
docker compose up -d --build
docker compose logs -f backend
```

---

## 3. Choose a model that fits

The workbench starts with `Qwen/Qwen2.5-1.5B-Instruct` so a first run works on modest hardware.
Change the model on the **Server** page, either by typing a Hugging Face id or using the model
search. You can also download weights ahead of time from the same page.

Sizing guide for weights **plus** KV cache at 4k–8k context, leaving 5–10% VRAM headroom:

| GPU VRAM | Suggested model | Notes |
| --- | --- | --- |
| 6–8 GB | `Qwen/Qwen2.5-1.5B-Instruct` | Default; comfortable fit. |
| 6–8 GB | `meta-llama/Llama-3.2-1B-Instruct` | Gated; requires `HF_TOKEN`. |
| 8 GB | `Qwen/Qwen2.5-3B-Instruct` | `gpu_memory_utilization=0.9`, 4k context. |
| 8–12 GB | `Qwen/Qwen2.5-7B-Instruct-AWQ` | Set quantization to `awq`. |
| 16–24 GB | `Qwen/Qwen2.5-7B-Instruct` | bfloat16, 8k context. |
| 24 GB | `meta-llama/Llama-3.1-8B-Instruct` | 8k context. |
| 24 GB | `Qwen/Qwen2.5-14B-Instruct-AWQ` | AWQ, 8k context. |
| 48 GB+ | `Qwen/Qwen2.5-32B-Instruct-AWQ` | AWQ; tensor parallel optional. |

Rules of thumb:

- **Quantized checkpoints are the cheapest upgrade.** AWQ/GPTQ/FP8 weights roughly halve or quarter
  memory versus bfloat16 with a small quality cost.
- **Context length costs memory per sequence.** `max_model_len` sizes the KV cache; halving it from
  8192 to 4096 can let you fit a larger model.
- **`gpu_memory_utilization` is a preallocation fraction.** vLLM reserves that share of VRAM for
  weights and cache. Lower it if other applications need the GPU.
- Model licenses differ. Check the model card before commercial use.

### Gated models

Llama, some Mistral models and a few others require you to accept the license on Hugging Face.
Create a read token and put it in `.env`:

```bash
HF_TOKEN=hf_...
```

Then restart the backend. Downloads are cached in the `workbench-data` volume and reused.

---

## 4. Start the engine

1. Open the **Server** page.
2. Review the configuration: model id, `max_model_len`, GPU memory utilization, tensor parallel
   size, dtype, quantization, `max_num_seqs`, trust remote code, enforce eager, extra flags.
3. Press **Start engine**.
4. Watch the streaming log. The state moves through `starting` to `running`. The first run
   downloads weights, which can take minutes.
5. Open **Playground** and send a prompt. Tokens stream from your GPU.

Useful behaviours:

- The configuration is read-only while the engine runs. Stop it to change settings.
- **Restart** reapplies the saved configuration.
- On backend shutdown the engine is stopped deliberately, so GPU memory is released.
- If startup fails, the Server page shows the error plus the tail of the vLLM log and a hint for
  common causes (OOM, gated repository, missing driver).

---

## 5. Use the model from other tools

Both the UI and external clients share the same running engine.

**OpenAI SDK:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="unused-unless-WORKBENCH_API_KEY-is-set",
)
stream = client.chat.completions.create(
    model="Qwen2.5-1.5B-Instruct",   # any name works; the backend injects the active model
    messages=[{"role": "user", "content": "Summarise PagedAttention in one sentence."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**curl:**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen2.5-1.5B-Instruct","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

**Protect `/v1` before sharing access:**

```bash
# .env
WORKBENCH_API_KEY=$(openssl rand -hex 32)
```

```bash
docker compose up -d
curl http://localhost:8000/v1/models -H "Authorization: Bearer $WORKBENCH_API_KEY"
```

The key protects `/v1/*` only. The `/api` control plane remains open — see
[Security](#security).

Anything that accepts an OpenAI-compatible base URL works: editor extensions, chat clients, agent
frameworks, evaluation harnesses. Point them at `http://<host>:8000/v1`.

---

## 6. Share the UI on your LAN

The browser connects to the backend directly, so the backend URL must be reachable **from the
browser**, not just from the container.

```bash
# .env
NEXT_PUBLIC_API_URL=http://192.168.1.20:8000
WORKBENCH_CORS_ORIGINS=http://192.168.1.20:3000
```

```bash
docker compose build frontend
docker compose up -d
```

Then open `http://192.168.1.20:3000` from another device on the same network. Notes:

- `NEXT_PUBLIC_API_URL` is compiled into the frontend at build time; changing `.env` requires a
  frontend rebuild.
- CORS must list the exact origin you type in the browser (scheme, host and port).
- Open the firewall for 3000 and 8000 only on trusted networks. Both ports expose an unauthenticated
  control plane.
- For access outside your LAN, prefer a VPN such as Tailscale or WireGuard over port forwarding.

---

## 7. Tuning

The Server form maps to these vLLM arguments:

```
--model <id>
--host <WORKBENCH_VLLM_HOST> --port <WORKBENCH_VLLM_PORT>
--served-model-name <name>
--max-model-len <n>
--gpu-memory-utilization <0.05–0.99>
--tensor-parallel-size <n>
--dtype <auto|float16|bfloat16|float32>
[--quantization <method>] [--trust-remote-code] [--enforce-eager]
[--max-num-seqs <n>] [...extra flags]
```

| Setting | What it changes |
| --- | --- |
| `gpu_memory_utilization` | Fraction of VRAM preallocated for weights + KV cache. 0.88–0.92 is a good desktop default. |
| `max_model_len` | Context window and KV-cache size per sequence. Cannot exceed the model's limit. |
| `max_num_seqs` | Cap on concurrently batched sequences; lower it if long prompts OOM. |
| `dtype` | `auto` follows the checkpoint. `bfloat16` is a good explicit choice on Ampere or newer. |
| `enforce_eager` | Disables CUDA graphs: slower, but useful on constrained or unstable setups. |
| `tensor_parallel_size` | Shards the model across GPUs. Must divide the attention-head count; start at 1. |
| `trust_remote_code` | Runs modelling code from the repository. Only for repositories you trust. |

Extra flags are appended verbatim as process arguments; the form-managed flags take precedence.

For observability, keep **GPU probe** enabled (`WORKBENCH_GPU_PROBE=true`) so the metrics page can
read `nvidia-smi` inside the container. Some vLLM builds expose `/metrics`; when they do, the
dashboard adds KV-cache occupancy, prefix-cache hit rate and engine-side TTFT percentiles. When they
do not, per-request timings measured by the proxy still work.

---

## 8. Configuration reference

All backend settings use the `WORKBENCH_` prefix and can be set in `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKBENCH_API_KEY` | empty | Bearer key for `/v1/*`. Empty = open. |
| `WORKBENCH_CORS_ORIGINS` | localhost:3000, 127.0.0.1:3000 | Comma-separated browser origins. |
| `WORKBENCH_HOST` / `WORKBENCH_PORT` | `0.0.0.0` / `8000` | FastAPI bind address. |
| `WORKBENCH_VLLM_HOST` / `WORKBENCH_VLLM_PORT` | `127.0.0.1` / `8001` | Internal engine address. |
| `WORKBENCH_VLLM_LAUNCH` | `vllm serve` | Launcher command; older images can use `python -m vllm.entrypoints.openai.api_server`. |
| `WORKBENCH_STARTUP_TIMEOUT_S` | `900` | Seconds to wait for engine health. |
| `WORKBENCH_STOP_TIMEOUT_S` | `25` | Graceful shutdown window before SIGKILL. |
| `WORKBENCH_HEALTH_INTERVAL_S` | `4.0` | Engine health poll interval. |
| `WORKBENCH_LOG_BUFFER_LINES` | `3000` | In-memory log lines available to the UI. |
| `WORKBENCH_DATA_DIR` | `/data` in Docker | Config, downloads and caches. |
| `WORKBENCH_VLLM_MOCK` | `false` | Simulated engine for UI work and CI. |
| `WORKBENCH_GPU_PROBE` | `true` | Enable `nvidia-smi` hardware metrics. |
| `WORKBENCH_METRICS_RETENTION` | `600` | Requests kept for charts. |
| `WORKBENCH_REQUEST_TIMEOUT_S` | `300` | Per-completion timeout. |
| `WORKBENCH_MAX_SWEEP_RUNS` | `60` | Sweep size ceiling. |
| `HF_TOKEN` | empty | Hugging Face token for gated models. |
| `HF_HOME` | `/data/hf` in Docker | Hugging Face cache directory. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend build. |
| `VLLM_VERSION` | `0.32.0` | vLLM image tag used by the backend build. |

---

## 9. Native install (no Docker)

Useful when you already maintain a CUDA Python environment. Requirements: Linux, Python 3.11 or
3.12, CUDA-capable PyTorch, and vLLM.

```bash
# Backend
cd backend
uv sync --dev
uv pip install vllm==0.32.0          # match the version you intend to run
uv run uvicorn app.main:app --port 8000

# Frontend (second terminal)
cd frontend
pnpm install
pnpm dev
```

Open <http://localhost:3000>. The backend launches `vllm serve` from the same environment, so the
`vllm` executable must be on `PATH`. If you use a different launcher (older versions), set
`WORKBENCH_VLLM_LAUNCH`.

The backend intentionally runs a single worker: multiple workers would each try to own a vLLM
process.

---

## 10. Data, updates and removal

| What | Where |
| --- | --- |
| Engine configuration | `workbench-data` volume → `/data/server-config.json` |
| Downloaded weights / HF cache | `workbench-data` volume → `/data/hf` |
| Downloaded models | `workbench-data` volume → `/data/models` |
| Request metrics | Memory only; cleared on backend restart |

```bash
docker compose down            # stop, keep data
docker compose up -d --build   # update after git pull
docker compose down -v         # stop and delete the volume (models and config)
```

The UI rebuild is required when `NEXT_PUBLIC_API_URL` changes, because the URL is compiled into the
browser bundle.

---

## 11. Troubleshooting

**`nvidia-smi` works on the host but not in Docker.** Install the NVIDIA Container Toolkit,
restart Docker, and test with the `docker run --rm --gpus all …` command above.

**Startup hangs on “starting”.** Weights are downloading. Watch the log panel; raise
`WORKBENCH_STARTUP_TIMEOUT_S` on slow connections. If the model is gated, the log shows a 401/403
from Hugging Face — set `HF_TOKEN` and restart.

**CUDA out of memory at startup.** Lower `gpu_memory_utilization` (0.80), reduce `max_model_len`
(8192 → 4096), use a quantized checkpoint, or move to a smaller model.

**OOM during generation.** Shorten conversations, lower `max_num_seqs`, or reduce context. The KV
cache grows with sequence length and concurrency.

**Requests fail while the state says running.** Some models fail on the first real generation
(e.g. unsupported quantization kernels). Check the log tail on the Server page.

**Metrics page shows no GPU data.** `nvidia-smi` must exist inside the backend container. Custom
images without it, or `WORKBENCH_GPU_PROBE=false`, leave the hardware card empty.

**The UI cannot reach the backend after changing hosts.** Rebuild the frontend
(`docker compose build frontend && docker compose up -d`) and confirm `WORKBENCH_CORS_ORIGINS`
contains the exact browser origin.

**Port conflicts.** 3000 = UI, 8000 = API, 8001 = internal engine. Change the published ports in
`docker-compose.yml` and set `NEXT_PUBLIC_API_URL` accordingly.

---

## 12. Exploring without a GPU

UI and API development works on any machine:

```bash
cd backend
WORKBENCH_VLLM_MOCK=1 uv run uvicorn app.main:app --reload --port 8000

cd frontend
pnpm dev
```

The mock engine simulates token streaming and Prometheus counters; it never loads weights. It is
also what the test suite uses, so `uv run pytest -q` runs without a GPU.

---

## Security

The workbench is a local tool. Keep it that way.

- `/api` — engine control, model downloads, sweeps — has **no authentication**. Anyone who can
  reach port 8000 can start or stop your engine and download models.
- `/v1` can require `WORKBENCH_API_KEY`. Set it before letting other devices use the inference
  endpoint.
- The UI calls `/api` without credentials, so generic proxy authentication in front of the backend
  breaks the UI. If you need remote access, use a private network or a proxy that authenticates
  without changing request semantics, and read
  [DEPLOYMENT.md](DEPLOYMENT.md#security-requirements-before-exposing-anything).
- Model arguments are passed as an argv array (no shell interpolation). `trust_remote_code`
  executes model repository code — enable it only for sources you trust.
