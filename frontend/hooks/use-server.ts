"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { MetricsSnapshot } from "@/lib/types";
import { useLiveTelemetry } from "@/hooks/use-live-telemetry";

export function useServerStatus(options?: { enabled?: boolean; intervalMs?: number }) {
  return useQuery({
    queryKey: ["server", "status"],
    queryFn: api.status,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === "starting" || state === "stopping") return 1200;
      return options?.intervalMs ?? 4000;
    },
    enabled: options?.enabled ?? true,
    retry: 1,
    staleTime: 1000,
  });
}

export function useServerConfig() {
  return useQuery({
    queryKey: ["server", "config"],
    queryFn: api.config,
    staleTime: 15_000,
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useMetrics(options?: { enabled?: boolean; intervalMs?: number | false }) {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: api.metrics,
    refetchInterval: options?.intervalMs ?? 2000,
    enabled: options?.enabled ?? true,
    staleTime: 1000,
    retry: 1,
  });
}

export type LiveStreamState =
  | "live"
  | "connecting"
  | "reconnecting"
  | "stalled"
  | "paused"
  | "background"
  | "idle";

interface FrozenFrame {
  data: MetricsSnapshot | null;
  received: number;
  lastAt: number | null;
}

/**
 * Real-time telemetry over SSE.
 *
 * Frames come from the tab-wide `useLiveTelemetry` store, so the header strip
 * and this page share one socket. Pausing freezes the page's view without
 * cutting the shell's live indicator; polling only seeds the first paint or
 * covers a dropped stream.
 */
export function useLiveMetrics(options?: { enabled?: boolean; paused?: boolean }) {
  const queryClient = useQueryClient();
  const paused = options?.paused ?? false;
  const enabled = options?.enabled ?? true;
  const query = useMetrics({
    enabled,
    intervalMs: paused ? 12_000 : 30_000,
  });
  const telemetry = useLiveTelemetry({ enabled });
  const [frozen, setFrozen] = useState<FrozenFrame | null>(null);

  useEffect(() => {
    if (!paused) {
      setFrozen(null);
      return;
    }
    // Capture the frame that was on screen when pause was pressed.
    setFrozen((current) => current ?? {
      data: telemetry.snapshot,
      received: telemetry.received,
      lastAt: telemetry.lastAt,
    });
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (paused || !telemetry.snapshot) return;
    queryClient.setQueryData(["metrics"], telemetry.snapshot);
  }, [paused, telemetry.snapshot, queryClient]);

  const data = paused
    ? (frozen?.data ?? query.data ?? null)
    : (telemetry.snapshot ?? query.data ?? null);
  const state: LiveStreamState = paused ? "paused" : telemetry.status;

  return {
    ...query,
    data,
    connected:
      telemetry.status === "live" ||
      telemetry.status === "stalled" ||
      telemetry.status === "background",
    received: paused ? (frozen?.received ?? telemetry.received) : telemetry.received,
    lastAt: paused ? (frozen?.lastAt ?? telemetry.lastAt) : telemetry.lastAt,
    cadenceMs: telemetry.cadenceMs,
    state,
    stalled: telemetry.status === "stalled",
  };
}
