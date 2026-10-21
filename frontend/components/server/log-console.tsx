"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  Copy,
  Pause,
  Play,
  Search,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLogs } from "@/hooks/use-logs";
import { api } from "@/lib/api";
import { cn, copyText, downloadFile } from "@/lib/utils";
import type { LogEntry } from "@/lib/types";

function severity(entry: LogEntry): "error" | "warning" | "system" | "normal" {
  const lowered = entry.message.toLowerCase();
  if (
    lowered.includes("error") ||
    lowered.includes("traceback") ||
    lowered.includes("out of memory") ||
    lowered.includes("failed")
  ) {
    return "error";
  }
  if (lowered.includes("warn")) return "warning";
  if (entry.stream === "system") return "system";
  return "normal";
}

export function LogConsole({ state }: { state: string }) {
  const { entries, connected, clear } = useLogs();
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const frozenRef = useRef<LogEntry[]>([]);

  // Pausing freezes the rendered snapshot without dropping the stream.
  if (!paused) frozenRef.current = entries;
  const visibleSource = paused ? frozenRef.current : entries;

  const filtered = useMemo(() => {
    if (!query.trim()) return visibleSource;
    const needle = query.toLowerCase();
    return visibleSource.filter((entry) => entry.message.toLowerCase().includes(needle));
  }, [visibleSource, query]);

  useEffect(() => {
    if (!autoScroll || paused || !open) return;
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [filtered.length, autoScroll, paused, open]);

  const handleClear = async () => {
    try {
      await api.clearLogs();
      clear();
      toast.success("Server logs cleared");
    } catch {
      toast.error("Could not clear logs");
    }
  };

  const handleDownload = () => {
    const text = visibleSource
      .map((entry) => `${entry.timestamp} [${entry.stream}] ${entry.message}`)
      .join("\n");
    downloadFile("vllm-server.log", text, "text/plain");
  };

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-2 text-xs font-medium"
          aria-expanded={open}
        >
          <Terminal className="size-3.5 text-muted-foreground" />
          Engine logs
          <ChevronDown
            className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-success" : state === "stopped" ? "bg-muted-foreground/40" : "bg-warning",
            )}
          />
          {connected ? "live" : "reconnecting"}
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/60">
          {entries.length} lines
        </span>

        {open ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter logs…"
                className="h-7 w-36 pl-7 text-[10px] sm:w-44"
                aria-label="Filter logs"
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPaused((value) => !value)}
                  aria-label={paused ? "Resume logs" : "Pause logs"}
                >
                  {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{paused ? "Resume" : "Pause"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setAutoScroll((value) => !value)}
                  aria-label="Toggle auto-scroll"
                  className={cn(autoScroll && "text-primary")}
                >
                  <ArrowDownToLine className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Auto-scroll {autoScroll ? "on" : "off"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    void copyText(filtered.map((entry) => entry.message).join("\n")).then(() =>
                      toast.success("Logs copied"),
                    );
                  }}
                  disabled={filtered.length === 0}
                  aria-label="Copy logs"
                >
                  <Copy className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy visible logs</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleDownload}
                  disabled={visibleSource.length === 0}
                  aria-label="Download logs"
                >
                  <ArrowDownToLine className="size-3.5 rotate-180" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download .log</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void handleClear()}
                  aria-label="Clear logs"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear buffer</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>

      {open ? (
        <div
          ref={containerRef}
          className="h-[320px] overflow-auto bg-[#080a0f] px-3 py-2 font-mono text-[10.5px] leading-[1.65] text-[#9aa7bd]"
        >
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-[10px] text-muted-foreground">
              {entries.length === 0
                ? state === "starting"
                  ? "Waiting for vLLM output… weights are loading."
                  : "No log output yet. Start the engine to see its logs."
                : "No lines match this filter."}
            </div>
          ) : (
            filtered.map((entry) => {
              const level = severity(entry);
              return (
                <div
                  key={`${entry.seq}-${entry.timestamp}`}
                  className={cn(
                    "whitespace-pre-wrap break-words border-l-2 border-transparent pl-2 hover:bg-white/[0.03]",
                    level === "error" && "border-destructive/70 bg-destructive/5 text-[#ff9daa]",
                    level === "warning" && "border-warning/60 text-[#ffd28a]",
                    level === "system" && "border-primary/50 text-[#a9b8ff]",
                  )}
                >
                  <span className="mr-2 select-none text-[#4b5567]">{entry.seq}</span>
                  {entry.message}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
