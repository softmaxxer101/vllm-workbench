# vLLM Workbench — User Guide

This guide is for people **using** the workbench: starting an engine, chatting with a local model,
comparing settings, running sweeps and reading telemetry. It assumes the stack is already installed
and running. If it is not, start with [LOCAL_LLM.md](LOCAL_LLM.md) (real GPU setup) or the
[README](../README.md) quick start.

---

## 1. What this is

The vLLM Workbench is a control room for a local language model. Instead of a terminal full of
flags, you get:

- a **Server** page that launches and supervises a vLLM engine on your GPU;
- a **Playground** for streaming chat with live sampling controls;
- **Compare** to run one prompt against two configurations at once;
- **Sweep** to measure a parameter across several values;
- **Metrics** for throughput, latency, queueing and hardware telemetry.

Everything runs on your machine. Prompts and completions never leave it. The only network calls are
to Hugging Face, and only when you search for or download a model.

```
Your browser  ──►  FastAPI (port 8000)  ──►  vLLM (port 8001)  ──►  your GPU
                        │
                        └─ starts, stops, proxies and measures the engine
```

The UI is only a client. Closing the browser does not stop the engine; stopping the engine from the
Server page does release the GPU memory.

---

## 2. Before your first session

You need:

- the stack running (Docker Compose or a native install) — see [LOCAL_LLM.md](LOCAL_LLM.md);
- an NVIDIA GPU with enough VRAM for the model you want;
- the UI open at <http://localhost:3000>.

If you do not have a GPU handy, the backend can run a **mock engine**
(`WORKBENCH_VLLM_MOCK=1`). Everything in the interface works, but responses are simulated and no
model is loaded — useful for learning the layout.

---

## 3. First run, in five steps

1. **Open the Server page.** The engine starts in the `stopped` state, so chat pages will ask you to
   start it.
2. **Check the model.** The default is `Qwen/Qwen2.5-1.5B-Instruct`, which fits a 6–8 GB card. Type
   another Hugging Face id, or use the model search to pick one.
3. **Review the launch configuration.** Defaults are sensible: `max_model_len` 4096,
   GPU memory utilization 0.88, tensor parallel 1, dtype auto. Adjust only if you know your hardware
   (see [Choosing settings](#9-choosing-settings)).
4. **Press Start engine.** The state moves `starting → running`. The first launch downloads weights,
   which can take minutes; the log panel shows progress. On failure you get the tail of the vLLM log
   plus a hint (out of memory, gated repository, driver problem).
5. **Head to the Playground** and send a prompt. Tokens should stream in. Turn to **Metrics** and
   watch throughput and TTFT move as you chat.

The engine keeps running while you move between pages. Use **Stop** on the Server page when you are
done for the day.

---

## 4. Getting around

The top bar is the same on every page:

- **01–05** — Playground, Compare, Sweep, Metrics, Server. The current page is underlined.
- **Engine pill** — live state: engine live, warming, stopping, error or offline. Click it to open
  the Server page.
- **Load strip** (on screens 1280 px and wider) — decode rate and queued requests, with a rolling
  sparkline. Hover for in-flight requests, KV-cache use and sampler timing. Click to open Metrics.
- **Book icon** — the backend's API documentation.
- **Keyboard icon** — the shortcut reference.
- **Sun/moon** — light and dark themes.

On phones and tablets, navigation moves to a bottom bar and the load strip hides; the engine pill
still shows status.

---

## 5. Playground

The main chat screen.

**Sending prompts**
- Type in the composer and press `Ctrl/⌘ + Enter` (or the arrow button).
- While a response streams, the send button becomes **Stop** (or press `Esc`).
- The composer shows an approximate token count for your draft and a **history** button with recent
  prompts you can reuse.
- **New chat** clears the conversation. **Export** saves it as Markdown or JSON.

**Sampling parameters**
Open **Parameters** (a side panel on desktop, a sheet on phones):

| Control | What it does | Typical range |
| --- | --- | --- |
| Temperature | Randomness. Low is focused, high is inventive. | 0.1–1.2 |
| Top-p | Nucleus sampling; trims the tail of the distribution. | 0.8–1.0 |
| Top-k | Limits choices to the k most likely tokens. | 20–100 |
| Max tokens | Upper bound on the response length. | 128–2048 |
| Repetition penalty | Penalises tokens already used. | 1.0–1.2 |
| Presence penalty | Encourages new topics. | 0–1 |
| Frequency penalty | Penalises repeated tokens proportionally. | 0–1 |

There is an **optional system prompt** field below the sliders. Use it to set tone, format or
constraints for the whole conversation.

Settings apply to the next message; the conversation keeps its existing turns. **Reset** returns the
sliders to defaults.

**Reading a response**
Each assistant message shows how it was produced: first-token latency, decode speed and token
counts. **Copy** puts the raw text on your clipboard, and the last response can be **regenerated**
with the current parameters. Markdown, code blocks and tables are rendered; long code blocks scroll
horizontally.

**Chat history** lives in your browser, so it survives reloads on the same device. It is not sent to
the backend for storage.

---

## 6. Compare

Use this when you want to answer “does temperature 0.2 or 0.9 read better?” with the same prompt.

1. Enter one **shared prompt**.
2. Optionally add a system prompt (shared as well).
3. Adjust the parameter panel on each side independently.
4. Press **Run both**.

Both streams start together and run concurrently, so the comparison is fair. Each pane reports its
own latency and throughput, and you can copy either response. Both panes use the model currently
loaded in the engine — Compare varies sampling settings, not models.

---

## 7. Sweep

Sweep runs the same prompt across several values of one parameter and summarises the results.

1. Enter the **prompt** (and an optional system prompt).
2. Choose a **parameter** — temperature, top-p, top-k, max tokens, or a penalty.
3. Enter **values** as a comma-separated list, for example `0.1, 0.4, 0.7, 1.0`. Up to 12 values.
4. Set **runs per value** (more runs smooth out randomness) and **concurrency** (1–4 parallel
   generations).
5. Press **Run N generations**.

The page shows progress, a latency/throughput chart and a table with each run's output and timings.
**CSV** downloads the results for a spreadsheet. A sweep consumes real GPU time: `values × runs`
generations, and concurrency above 1 increases VRAM pressure.

Useful sweeps:

- **Temperature** across 0.1–1.3 to find the style you like.
- **Top-p** across 0.7–1.0 at a fixed temperature.
- **Max tokens** to see where responses get truncated.
- **Repetition penalty** on models that loop.

---

## 8. Metrics

This page answers “what is the GPU actually doing?”. It receives one snapshot per second over a
single server-side sampler, so several open tabs do not multiply the work.

**Headline card** — decode rate right now, with a pulse line and the source of the number (instant
vLLM counters or the last-request average).

**Tiles** — TTFT p95 (with p50 or average beneath), in-flight requests and queue depth, KV-cache
occupancy, GPU memory used versus total, plus utilization.

**Charts** — decode rate and time-to-first-token over the last 30 minutes, bucketed every 30
seconds. Empty buckets mean no traffic, not zero performance.

**Request ledger** — the latest generations with source page, prompt/completion tokens, TTFT,
tokens/s, total latency and status. Clear it with **Clear**; it is stored in memory and resets when
the backend restarts.

**Right column** — the active engine (model, context, tensor parallel, dtype, quantization, uptime),
the physical GPU, and vLLM internals (KV cache, prefix-cache hit rate, token totals, inter-token
latency). Some of these require the engine to expose `/metrics`; when it does not, the card says so
and the proxy-measured numbers still work.

**Live controls**
- The status pill reads `SSE · 1 Hz` when frames are arriving, `stalled` if the socket is silent,
  `reconnecting` after a drop, `paused` when you pause, and `tab hidden` when the browser is
  backgrounded.
- **Pause** freezes this page's view (the shell strip keeps updating). **Resume** catches up on the
  next frame.
- **Refresh** fetches a snapshot immediately.
- The footer shows frames received, sampler duration and any dropped frames.

**What the numbers mean**

| Metric | Reading it |
| --- | --- |
| TTFT | Time from request to first token. Dominated by prompt length and queueing. Lower is snappier. |
| Decode rate (tok/s) | Tokens per second while generating. Rises with batching, falls with long contexts. |
| In flight / queued | Requests currently generating / waiting for a slot. A persistent queue means you are saturating the engine. |
| KV cache | Share of the preallocated cache in use. Near 100% means new requests may wait or be rejected. |
| GPU memory | Weights plus cache allocated by vLLM. It stays high while the engine runs; that is expected. |

---

## 9. Server

The engine's control panel.

**State and actions** — the header shows the state and offers **Start engine**, **Stop**, and
**Restart** (restart is available when running or errored). Stopping releases GPU memory; restarting
reapplies the saved configuration.

**Launch configuration** — model id, max model length, tensor parallel size, GPU memory utilization,
dtype, quantization, served model name, max concurrent sequences, trust remote code, enforce eager,
and extra vLLM flags. The form is read-only while the engine runs: stop it to edit, then start
again. **Save configuration** persists the values for the next launch even without starting.

| Field | Guidance |
| --- | --- |
| Model | Hugging Face id (`org/name`) or a local path. Use the search to find and download weights. |
| Max model length | Context window. Larger costs KV-cache memory per sequence. |
| GPU memory utilization | Fraction of VRAM vLLM preallocates. 0.88–0.92 is a good desktop default. |
| Tensor parallel size | Number of GPUs to shard across; 1 for a single card. |
| dtype | `auto` follows the checkpoint; `bfloat16` is a good explicit choice on newer cards. |
| Quantization | Match the checkpoint: `awq`, `gptq`, `fp8`, etc. Wrong values fail at load. |
| Served model name | The name external clients see. Defaults to the model's last path segment. |
| Max concurrent sequences | Caps batching; lower it if long prompts run out of memory. |
| Extra vLLM flags | Appended verbatim, e.g. `--enable-prefix-caching`. Managed flags above cannot be repeated. |

**Logs** — streamed from the engine with a filter box, pause/resume, auto-scroll toggle, copy,
download and clear. Startup problems almost always explain themselves here.

**Hardware & runtime** — GPU model, backend version and mock-mode status.

**Model presets** — quick configurations for common model sizes. They fill the form; review before
starting.

**OpenAI-compatible API** — the base URL to give other tools, plus an example payload.

---

## 10. Choosing settings

Start conservative, then trade memory for capability:

- **Fit the model first.** 6–8 GB runs 1–3B models; 16–24 GB runs 7–14B. Quantized checkpoints
  (AWQ/GPTQ) roughly halve memory needs.
- **Lower `gpu_memory_utilization`** to 0.80 if other applications need VRAM, and raise it towards
  0.92 if vLLM is alone on the card.
- **Reduce `max_model_len`** (8192 → 4096) when you hit out-of-memory errors or want more concurrent
  sequences.
- **Lower `max_num_seqs`** if long prompts cause OOM during generation.
- **Leave `dtype` on auto** unless you have a reason; `float32` is rarely worth the memory.
- **Enable prefix caching** (`--enable-prefix-caching`) when you repeatedly send a long shared
  system prompt; the Metrics page shows the hit rate.

A full sizing table and tuning notes are in [LOCAL_LLM.md](LOCAL_LLM.md).

---

## 11. Using the model from other apps

The engine is OpenAI-compatible, so anything that accepts a custom base URL can use it:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused-unless-set")
response = client.chat.completions.create(
    model="Qwen2.5-1.5B-Instruct",   # the backend injects the loaded model anyway
    messages=[{"role": "user", "content": "Summarise this changelog: ..."}],
)
print(response.choices[0].message.content)
```

- Base URL: `http://localhost:8000/v1` (or the host other devices use).
- Streaming works the same way (`stream=True`).
- If `WORKBENCH_API_KEY` is set, send `Authorization: Bearer <key>`.
- The model is whatever the Server page loaded; clients can send any model name.

---

## 12. Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + Enter` | Send message / run |
| `Ctrl/⌘ + K` or `/` | Focus the composer |
| `Esc` | Stop streaming / close dialogs |
| `Ctrl/⌘ + Shift + K` | Clear the playground conversation |
| `G` then `P` | Playground |
| `G` then `C` | Compare |
| `G` then `S` | Sweep |
| `G` then `M` | Metrics |
| `G` then `E` | Server |
| `?` | Shortcut reference |

Press `?` anywhere to see this list.

---

## 13. Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| “Backend unreachable” | The browser cannot reach the API URL | Check `curl localhost:8000/api/health`; confirm `NEXT_PUBLIC_API_URL`; rebuild the frontend if it changed. |
| Engine pill says offline | No engine is running | Open Server and press **Start engine**. |
| Stuck on “starting” | Weights are downloading, or startup is slow | Watch the logs; raise `WORKBENCH_STARTUP_TIMEOUT_S` on slow connections. |
| Error about `401`/`403` from Hugging Face | Gated model | Accept the license and set `HF_TOKEN`, then restart. |
| CUDA out of memory | Model/context too large for the card | Lower GPU memory utilization or context, use a quantized model, or pick a smaller one. |
| Metrics show “vLLM internals unavailable” | The engine does not expose `/metrics` | Proxy timings still work; hardware data needs `nvidia-smi` in the backend container. |
| Chat stops mid-response | You pressed `Esc`, a proxy timed out, or the engine crashed | Check Server logs; retry; raise request timeout if using a proxy. |
| Load strip is missing | Screen narrower than 1280 px | Intentional; the engine pill and Metrics page carry the same information. |
| Static/Pages build shows a blank page | Wrong base path for the hosting layout | See [DEPLOYMENT.md](DEPLOYMENT.md). |

More environment-specific fixes (drivers, Docker GPU passthrough, ports) are in
[LOCAL_LLM.md](LOCAL_LLM.md#11-troubleshooting).

---

## 14. Data, privacy and limits

**Where things live**

| Data | Location | Cleared by |
| --- | --- | --- |
| Conversations and prompt history | Browser storage | Clear chat / site data |
| Engine configuration | `server-config.json` in the data volume | Editing and saving, or deleting the volume |
| Model weights | Hugging Face cache (inside the data volume when using Docker) | Deleting the volume or the cache |
| Request metrics | Backend memory | **Clear**, or a backend restart |

No analytics or telemetry are sent anywhere. Model downloads and searches contact Hugging Face.

**Limits**

- One engine and one model at a time per deployment.
- Token counts in the composer are estimates; metrics use engine/proxy measurements.
- Metrics history is in memory and resets on restart.
- The UI is a local tool: `/api` has no authentication. Do not expose it to untrusted networks;
  `/v1` can be protected with `WORKBENCH_API_KEY`. See the README's security section.

---

## 15. Where to go next

- [LOCAL_LLM.md](LOCAL_LLM.md) — install, model sizing, tuning, LAN access, deep troubleshooting.
- [DEPLOYMENT.md](DEPLOYMENT.md) — publishing the interface and hosting the backend safely.
- [README](../README.md) — features, architecture, API reference.
