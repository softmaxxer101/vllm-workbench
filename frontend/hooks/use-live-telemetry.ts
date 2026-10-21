"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  getLiveTelemetryStore,
  type LiveTelemetrySnapshot,
} from "@/lib/live-telemetry";

/**
 * Subscribe to the tab-wide telemetry stream.
 *
 * Every consumer shares one `EventSource`; unmounting releases only that
 * consumer. Nothing connects on the server, so hydration renders the initial
 * idle state.
 */
export function useLiveTelemetry(options?: { enabled?: boolean }): LiveTelemetrySnapshot {
  const store = getLiveTelemetryStore();
  const enabled = options?.enabled ?? true;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getServerState);

  useEffect(() => {
    if (!enabled) return;
    return store.acquire();
  }, [enabled, store]);

  return state;
}
