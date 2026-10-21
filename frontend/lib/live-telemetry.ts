/**
 * One shared telemetry connection per browser tab.
 *
 * The header strip and the metrics page both need live frames. Opening an
 * `EventSource` per component would double subscriptions and split the
 * connection state, so this store owns a single stream and ref-counts the
 * components that consume it.
 *
 * It mirrors the server's envelope: every frame advances a sequence, carries
 * its sample duration, and is a complete snapshot. The store keeps a short
 * throughput history for the header sparkline and downgrades to `stalled` when
 * an open socket stops delivering frames.
 */

import { API_BASE } from "./api";
import type { MetricsSnapshot } from "./types";

export const STALL_AFTER_MS = 3200;
const MAX_HISTORY = 36;

/**
 * Instant decode rate from vLLM counters, falling back to the last completed
 * request average when the engine has no live counters (mock or idle engine).
 */
export function decodeRate(snapshot: MetricsSnapshot): number {
  const instant = snapshot.vllm.rates.generation_tokens_per_second;
  if (instant !== null && instant > 0) return instant;
  return snapshot.summary.tokens_per_second ?? 0;
}

export type LiveStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stalled"
  | "background";

export interface LiveTelemetrySnapshot {
  status: LiveStatus;
  snapshot: MetricsSnapshot | null;
  received: number;
  lastAt: number | null;
  cadenceMs: number | null;
  /** Decode rate per frame, oldest first — used by the header sparkline. */
  history: number[];
}

const INITIAL: LiveTelemetrySnapshot = {
  status: "idle",
  snapshot: null,
  received: 0,
  lastAt: null,
  cadenceMs: null,
  history: [],
};

class LiveTelemetryStore {
  private state: LiveTelemetrySnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private refs = 0;
  private previousFrameAt: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /**
   * Components call this on mount. The returned function releases their
   * subscription; the socket closes when the last consumer goes away.
   */
  acquire = (): (() => void) => {
    this.refs += 1;
    if (this.refs === 1) {
      this.startWatchdog();
      document.addEventListener("visibilitychange", this.onVisibility);
      this.connect();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs > 0) return;
      this.stopWatchdog();
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.close();
      this.set({ status: "idle" });
    };
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): LiveTelemetrySnapshot => this.state;

  /** Stable identity for SSR/first hydration. */
  getServerState = (): LiveTelemetrySnapshot => INITIAL;

  // ---------------------------------------------------------------- internals
  private set(patch: Partial<LiveTelemetrySnapshot>): void {
    const next = { ...this.state, ...patch };
    const unchanged =
      next.status === this.state.status &&
      next.snapshot === this.state.snapshot &&
      next.received === this.state.received &&
      next.lastAt === this.state.lastAt &&
      next.cadenceMs === this.state.cadenceMs &&
      next.history === this.state.history;
    if (unchanged) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private close(): void {
    this.source?.close();
    this.source = null;
    this.previousFrameAt = null;
  }

  private connect(): void {
    if (typeof window === "undefined") return;
    this.close();
    this.set({ status: this.state.snapshot ? "reconnecting" : "connecting" });

    const source = new EventSource(`${API_BASE}/api/metrics/stream?interval=1`);
    this.source = source;

    source.addEventListener("telemetry", (event) => {
      let snapshot: MetricsSnapshot;
      try {
        snapshot = JSON.parse((event as MessageEvent).data) as MetricsSnapshot;
      } catch {
        return; // a malformed frame must not tear down the channel
      }
      const at = Date.now();
      const delta = this.previousFrameAt === null ? null : at - this.previousFrameAt;
      this.previousFrameAt = at;
      const rate = decodeRate(snapshot);
      const history = [...this.state.history, rate].slice(-MAX_HISTORY);
      this.set({
        status: document.visibilityState === "hidden" ? "background" : "live",
        snapshot,
        received: this.state.received + 1,
        lastAt: at,
        cadenceMs:
          delta === null
            ? this.state.cadenceMs
            : this.state.cadenceMs === null
              ? delta
              : Math.round(this.state.cadenceMs * 0.7 + delta * 0.3),
        history,
      });
    });

    source.onerror = () => {
      // The browser reconnects on its own (the server sends `retry: 2000`).
      this.set({ status: this.state.received > 0 ? "reconnecting" : "connecting" });
    };
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = setInterval(() => {
      const { status, lastAt } = this.state;
      if (status !== "live" && status !== "background") return;
      if (lastAt === null) return;
      if (Date.now() - lastAt > STALL_AFTER_MS) {
        // An open but silent socket is the failure mode `onopen` hides.
        this.set({ status: "stalled" });
      }
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdog === null) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      if (this.source) this.set({ status: "background" });
      return;
    }
    const silentFor = Date.now() - (this.state.lastAt ?? 0);
    if (!this.source || silentFor > STALL_AFTER_MS) {
      this.connect();
      return;
    }
    this.set({ status: "live" });
  };
}

let store: LiveTelemetryStore | null = null;

export function getLiveTelemetryStore(): LiveTelemetryStore {
  store ??= new LiveTelemetryStore();
  return store;
}
