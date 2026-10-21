"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE } from "@/lib/api";
import type { LogEntry } from "@/lib/types";

const MAX_LINES = 3000;

export function useLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/server/logs/stream?after_seq=0`);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    const onLog = (event: MessageEvent) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry;
        const key = `${entry.seq}|${entry.timestamp}|${entry.message}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > MAX_LINES * 2) {
          seen.current = new Set(Array.from(seen.current).slice(-MAX_LINES));
        }
        setEntries((previous) => [...previous, entry].slice(-MAX_LINES));
      } catch {
        // Ignore malformed frames; EventSource reconnects automatically.
      }
    };

    source.addEventListener("log", onLog as EventListener);

    return () => {
      source.removeEventListener("log", onLog as EventListener);
      source.close();
      sourceRef.current = null;
    };
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    seen.current.clear();
  }, []);

  return { entries, connected, clear, reconnect: () => sourceRef.current?.close() };
}
