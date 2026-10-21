# Deploying the interface (GitHub Pages) and hosting the backend

## The short answer

**GitHub Pages cannot run this application.** Pages serves static files from a CDN. It cannot run
Python, FastAPI, the vLLM supervisor, a GPU workload, or a long-lived server process. If you publish
this repository to Pages, visitors get the interface and nothing behind it: no engine to start, no
model to chat with, no telemetry.

What Pages *can* do is publish the **frontend** as a static site. That is useful as a UI preview or
portfolio piece. It is not a way to let people use your GPU, and it is not safe to point a public
Pages site at an unauthenticated backend.

| | GitHub Pages | A machine with the GPU |
| --- | --- | --- |
| Serve the Next.js UI | Yes (static export) | Yes |
| Run FastAPI | No | Yes |
| Run vLLM / load a model | No | Yes |
| Stream SSE from your backend | Only if the backend is hosted elsewhere | Yes |
| Real local inference for visitors | No | Yes, for people you give access |

For actual use, install the stack locally: [LOCAL_LLM.md](LOCAL_LLM.md).

---

## Option A — Publish the UI as a static preview (works, with caveats)

### What is included

- [`frontend/next.config.ts`](../frontend/next.config.ts) supports a static export when
  `NEXT_EXPORT=1`, including `basePath` and `trailingSlash` for Pages routing.
- [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds that export, adds a
  `.nojekyll` file, and deploys it with the official Pages actions.

### Steps

1. **Push the repository to GitHub.** Pages on the Free plan requires a public repository.
2. **Enable Pages:** repository **Settings → Pages → Build and deployment → Source: GitHub
   Actions**.
3. **Point the UI at a backend (optional but usually necessary):** **Settings → Secrets and
   variables → Actions → Variables → New repository variable**

   ```
   Name:  NEXT_PUBLIC_API_URL
   Value: https://your-backend.example.com
   ```

   Without this variable the build keeps `http://localhost:8000`, so every visitor's browser looks
   for a backend on *their own* machine and the UI shows "backend unreachable". The variable is
   public by design — never put secrets in `NEXT_PUBLIC_*`.
4. **Run the workflow:** **Actions → Deploy UI to GitHub Pages → Run workflow**. It is manual by
   default so a repository without Pages enabled does not accumulate failing runs; once it succeeds
   you can add a `push` trigger for automatic deploys.
5. Open `https://<user>.github.io/<repo>/`.

Base path handling is automatic:

- a project repository (`github.com/user/vllm-workbench`) is served at `/vllm-workbench/`, and the
  workflow sets `NEXT_PUBLIC_BASE_PATH` to match;
- a user site (`github.com/user/user.github.io`) or a custom domain is served at `/` with no base
  path.

### Build the export locally

```bash
cd frontend
NEXT_EXPORT=1 NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 pnpm build
# output: frontend/out/
```

Serve it with any static server, for example:

```bash
cd frontend/out && python -m http.server 3000
```

To reproduce the project-page layout locally:

```bash
cd frontend
NEXT_EXPORT=1 \
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 \
NEXT_PUBLIC_BASE_PATH=/vllm-workbench \
pnpm build

mkdir -p /tmp/pages/vllm-workbench
cp -r out/. /tmp/pages/vllm-workbench/
cd /tmp/pages && python -m http.server 4010
# open http://127.0.0.1:4010/vllm-workbench/
```

### Custom domain

Add the domain in **Settings → Pages**, create the DNS records GitHub shows, and drop the
`NEXT_PUBLIC_BASE_PATH` value (custom domains are served from `/`). If you keep the workflow's
automatic base path, override it with a repository variable set to an empty string.

### What visitors will and will not see

Without a backend: the shell, navigation and empty/error states. Starting the engine, chatting,
sweeping and telemetry all require `/api` to answer. If you host a backend, its URL must be
reachable over **HTTPS**, allow the Pages origin in CORS, and be safe to expose — see the next
section.

---

## Option B — Host the whole stack (recommended for real remote use)

Run the backend and frontend together on the GPU machine, exactly as in
[LOCAL_LLM.md](LOCAL_LLM.md), and reach it over a private network.

- **Trusted LAN:** set `NEXT_PUBLIC_API_URL` to the machine's LAN address and add the UI origin to
  `WORKBENCH_CORS_ORIGINS`, then rebuild the frontend.
- **Remote but private:** install [Tailscale](https://tailscale.com) (or WireGuard) on the GPU
  machine and your laptop, and use the tailnet address. No ports are exposed to the internet.
- **Public host with a domain:** put a TLS reverse proxy in front of both services, keep the UI and
  API on the **same origin** (for example `https://workbench.example.com` → frontend, with `/api`
  and `/v1` proxied to FastAPI), and add authentication at that layer.

The same-origin layout matters: the frontend calls `/api` with plain `fetch` and no credentials or
custom headers, so cross-origin cookie auth or generic HTTP basic auth will not work from a Pages
site. Same-origin proxying plus a session cookie or an SSO gateway in front of **everything** is the
workable pattern.

Reverse proxies must not buffer Server-Sent Events. The backend already sends
`X-Accel-Buffering: no` and `Cache-Control: no-transform`; make sure your proxy honours them (for
nginx, `proxy_buffering off;` and `proxy_read_timeout` above your longest generation).

---

## Security requirements before exposing anything

Read this before pointing a public URL at port 8000.

1. **`/api` has no authentication.** It can start and stop the engine, download models from Hugging
   Face, and run sweeps. A public backend is a public GPU control panel for anyone who finds it.
2. **`WORKBENCH_API_KEY` protects `/v1` only.** It does not protect the control plane, and the
   frontend does not send it.
3. **Do not rely on CORS as security.** It stops other websites from reading responses, not
   scripts or curl from talking to your API.
4. **CORS must list the exact frontend origin.** For Pages that is
   `https://<user>.github.io` (the origin has no path):

   ```bash
   WORKBENCH_CORS_ORIGINS=https://your-user.github.io
   ```

5. **HTTPS everywhere.** A Pages site is served over HTTPS; browsers may block calls to an
   `http://` API as mixed content. Use TLS on the backend or a tunnel that terminates it.
6. **Do not expose model downloads or `trust_remote_code` to untrusted users.** Downloads fill the
   disk; remote code executes model repository code.

If you cannot put authentication in front of the API, publish the Pages site as a UI preview only,
without a live backend.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Blank page, or assets return 404 | Base path mismatch. Project pages need `/repo`; user sites and custom domains need `/`. Re-run the workflow after changing repository settings. |
| Page loads but every request fails | `NEXT_PUBLIC_API_URL` is missing or points at localhost. Set the repository variable and re-run the workflow. |
| CORS error in the console | Add the exact Pages origin to `WORKBENCH_CORS_ORIGINS` and restart the backend. Include the scheme; no trailing slash. |
| Mixed-content or `ERR_BLOCKED_BY_CLIENT` | The Pages site is HTTPS and the API is HTTP. Serve the API over HTTPS (reverse proxy or tunnel). |
| Telemetry freezes after a while | A proxy is buffering SSE or timing out. Disable buffering and raise read timeouts. |
| Workflow fails on `pnpm install` | `pnpm-lock.yaml` is out of date with `package.json`; run `pnpm install` locally and commit the lockfile. |
| Pages deployment never appears | Pages source is not set to **GitHub Actions**, or the `pages` environment rejected the run. Check the workflow run log. |

Unpublishing is done from **Settings → Pages**; deleting the workflow run artifacts or the `out/`
directory has no effect on the published site.

---

## Summary

- GitHub Pages = static UI only. This repository can publish that, and the workflow is included.
- The UI is useless without a backend; a backend needs a GPU machine, HTTPS, CORS and real access
  control.
- For actual local LLM use, run `docker compose up --build` on the GPU machine and follow
  [LOCAL_LLM.md](LOCAL_LLM.md).
