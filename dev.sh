#!/usr/bin/env bash
#
# Start the vLLM Workbench backend and frontend together.
#
#   ./dev.sh                              # API on 8000, UI on 3000
#   WORKBENCH_PORT=8010 WEB_PORT=3010 ./dev.sh
#
# The script installs nothing unless an environment is missing, waits until both
# servers answer, prints the URL, and shuts both down cleanly on Ctrl+C.
# Choosing a model, downloading weights and starting the engine all happen in
# the UI — this is the only terminal command you need per session.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${WORKBENCH_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
API_HOST="${API_HOST:-0.0.0.0}"
WEB_HOST="${WEB_HOST:-0.0.0.0}"
API_TIMEOUT="${API_TIMEOUT:-60}"
WEB_TIMEOUT="${WEB_TIMEOUT:-180}"
LOG_DIR="$ROOT/.dev-logs"
API_PY="$ROOT/backend/.venv/bin/python"
WEB_BIN="$ROOT/frontend/node_modules/.bin/next"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  b=$'\033[1m' d=$'\033[2m' g=$'\033[32m' y=$'\033[33m' r=$'\033[31m' n=$'\033[0m'
else
  b='' d='' g='' y='' r='' n=''
fi

info() { printf '%s›%s %s\n' "$d" "$n" "$*"; }
ok()   { printf '%s✓%s %s\n' "$g" "$n" "$*"; }
warn() { printf '%s!%s %s\n' "$y" "$n" "$*"; }
die()  { printf '%s✗%s %s\n' "$r" "$n" "$*" >&2; exit 1; }

API_PID=''
WEB_PID=''
CLEANED=0

cleanup() {
  local code=$?
  [ "$CLEANED" -eq 1 ] && return
  CLEANED=1
  trap - INT TERM EXIT
  if [ -n "$WEB_PID" ] || [ -n "$API_PID" ]; then
    printf '\n%s›%s stopping…\n' "$d" "$n"
  fi
  # Each child leads its own process group, so signalling the group also stops
  # the grandchildren (`pnpm -> next -> next-server`).
  for pid in $WEB_PID $API_PID; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 40); do
    local alive=0
    for pid in $WEB_PID $API_PID; do
      kill -0 -- "-$pid" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.25
  done
  for pid in $WEB_PID $API_PID; do
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  if [ -n "$WEB_PID" ] || [ -n "$API_PID" ]; then
    printf '%s✓%s stopped\n' "$g" "$n"
  fi
  exit "$code"
}
trap cleanup INT TERM EXIT

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

# Poll until the URL answers, the process group dies, or the timeout expires.
wait_http() { # url pid timeout
  local url=$1 pid=$2 timeout=$3 start=$SECONDS
  while [ $((SECONDS - start)) -lt "$timeout" ]; do
    curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null && return 0
    kill -0 -- "-$pid" 2>/dev/null || return 2
    sleep 1
  done
  return 1
}

tail_log() { [ -f "$1" ] && tail -n 15 "$1" | sed 's/^/    /'; }

command -v curl >/dev/null 2>&1 || die "curl is required (apt install curl)"
cd "$ROOT"

# ---------------------------------------------------------------- prerequisites
if [ ! -x "$API_PY" ]; then
  command -v uv >/dev/null 2>&1 || die "backend/.venv is missing and uv is not installed (https://docs.astral.sh/uv/)"
  info "creating the backend environment (uv sync --dev)…"
  ( cd backend && uv sync --dev ) || die "uv sync failed"
fi

if [ ! -x "$WEB_BIN" ]; then
  command -v pnpm >/dev/null 2>&1 || die "frontend dependencies are missing and pnpm is not installed (npm i -g pnpm@10)"
  info "installing frontend dependencies (pnpm install)…"
  ( cd frontend && pnpm install --frozen-lockfile ) || die "pnpm install failed"
fi

# ------------------------------------------------------------------- ports free
if port_busy "$API_PORT"; then
  die "port $API_PORT is already in use — stop that process, or run: WORKBENCH_PORT=$((API_PORT + 10)) ./dev.sh"
fi
if port_busy "$WEB_PORT"; then
  die "port $WEB_PORT is already in use — stop that process, or run: WEB_PORT=$((WEB_PORT + 10)) ./dev.sh"
fi

# --------------------------------------------------------------- engine settings
export WORKBENCH_VLLM_PORT="${WORKBENCH_VLLM_PORT:-8001}"
export WORKBENCH_CORS_ORIGINS="${WORKBENCH_CORS_ORIGINS:-http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT}"

if [ -n "${WORKBENCH_VLLM_LAUNCH:-}" ]; then
  ok "engine launcher: ${WORKBENCH_VLLM_LAUNCH%% *}"
elif command -v vllm >/dev/null 2>&1; then
  ok "engine launcher: $(command -v vllm) (from PATH)"
elif [ -x "$HOME/vllm-env/bin/vllm" ]; then
  export WORKBENCH_VLLM_LAUNCH="$HOME/vllm-env/bin/vllm serve"
  ok "engine launcher: $HOME/vllm-env/bin/vllm"
else
  warn "no vllm found — the UI will run, but Start engine needs"
  warn "WORKBENCH_VLLM_LAUNCH=/path/to/venv/bin/vllm\\ serve"
fi

# The browser bundle is built from NEXT_PUBLIC_API_URL, so it must match the API.
export NEXT_PUBLIC_API_URL="http://localhost:$API_PORT"
WANT_ENV="NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL"
if [ ! -f frontend/.env.local ]; then
  printf '%s\n' "$WANT_ENV" >frontend/.env.local
  info "created frontend/.env.local"
elif ! grep -qxF "$WANT_ENV" frontend/.env.local; then
  warn "frontend/.env.local disagrees with this run; $WANT_ENV wins"
fi

# --------------------------------------------------------------------- commands
if [ -n "${DEV_BACKEND_CMD:-}" ]; then
  read -r -a API_CMD <<<"$DEV_BACKEND_CMD"
  API_CWD="$ROOT"
else
  API_CMD=("$API_PY" -m uvicorn app.main:app --host "$API_HOST" --port "$API_PORT")
  API_CWD="$ROOT/backend"
fi

if [ -n "${DEV_FRONTEND_CMD:-}" ]; then
  read -r -a WEB_CMD <<<"$DEV_FRONTEND_CMD"
  WEB_CWD="$ROOT"
else
  WEB_CMD=("$WEB_BIN" dev -p "$WEB_PORT" -H "$WEB_HOST")
  WEB_CWD="$ROOT/frontend"
fi

# ------------------------------------------------------------------------ start
mkdir -p "$LOG_DIR"
: >"$LOG_DIR/backend.log"
: >"$LOG_DIR/frontend.log"

# Job control gives each background job its own process group, so cleanup can
# signal a whole server tree instead of just its parent.
set -m
( cd "$API_CWD" && exec "${API_CMD[@]}" ) >"$LOG_DIR/backend.log" 2>&1 &
API_PID=$!
( cd "$WEB_CWD" && exec "${WEB_CMD[@]}" ) >"$LOG_DIR/frontend.log" 2>&1 &
WEB_PID=$!
set +m

info "waiting for the API on :$API_PORT (pid $API_PID)…"
wait_http "http://127.0.0.1:$API_PORT/api/health" "$API_PID" "$API_TIMEOUT"
case $? in
  0) ok "API ready" ;;
  2) tail_log "$LOG_DIR/backend.log"; die "the backend exited during startup (see .dev-logs/backend.log)" ;;
  *) tail_log "$LOG_DIR/backend.log"; die "the API did not answer within ${API_TIMEOUT}s" ;;
esac

info "waiting for the UI on :$WEB_PORT (first compile can take a minute)…"
wait_http "http://127.0.0.1:$WEB_PORT/" "$WEB_PID" "$WEB_TIMEOUT"
case $? in
  0) ok "UI ready" ;;
  2) tail_log "$LOG_DIR/frontend.log"; die "the frontend exited during startup (see .dev-logs/frontend.log)" ;;
  *) tail_log "$LOG_DIR/frontend.log"; die "the UI did not answer within ${WEB_TIMEOUT}s" ;;
esac

printf '\n%s  vLLM Workbench is up%s\n' "$b" "$n"
printf '  UI       %shttp://localhost:%s%s\n' "$b" "$WEB_PORT" "$n"
printf '  API      http://localhost:%s   %s(/docs for OpenAPI)%s\n' "$API_PORT" "$d" "$n"
printf '  Engine   http://127.0.0.1:%s   %s(start it from the UI)%s\n' "$WORKBENCH_VLLM_PORT" "$d" "$n"
printf '  Logs     %s\n' "$LOG_DIR"
printf '\n  Open the UI, go to %sServer%s and press %sStart engine%s.\n' "$b" "$n" "$b" "$n"
printf '  %sCtrl+C stops both servers.%s\n\n' "$d" "$n"

# ----------------------------------------------------------------------- watch
while :; do
  if ! kill -0 -- "-$API_PID" 2>/dev/null; then
    warn "the backend stopped"
    tail_log "$LOG_DIR/backend.log"
    exit 1
  fi
  if ! kill -0 -- "-$WEB_PID" 2>/dev/null; then
    warn "the frontend stopped"
    tail_log "$LOG_DIR/frontend.log"
    exit 1
  fi
  sleep 1
done
