"use client";

import Link from "next/link";
import { ArrowUpRight, CircleAlert, Loader2 } from "lucide-react";

import { cn, formatDuration } from "@/lib/utils";
import { useServerStatus } from "@/hooks/use-server";
import type { ServerState } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const STATE_META: Record<
  ServerState,
  { label: string; dot: string; text: string; border: string; bg: string }
> = {
  running: {
    label: "Engine live",
    dot: "bg-success shadow-[0_0_8px_hsl(var(--success))]",
    text: "text-success",
    border: "border-success/25",
    bg: "bg-success/10",
  },
  starting: {
    label: "Warming up",
    dot: "bg-warning animate-pulse",
    text: "text-warning",
    border: "border-warning/25",
    bg: "bg-warning/10",
  },
  stopping: {
    label: "Stopping",
    dot: "bg-warning animate-pulse",
    text: "text-warning",
    border: "border-warning/25",
    bg: "bg-warning/10",
  },
  error: {
    label: "Engine error",
    dot: "bg-destructive shadow-[0_0_8px_hsl(var(--destructive))]",
    text: "text-destructive",
    border: "border-destructive/30",
    bg: "bg-destructive/10",
  },
  stopped: {
    label: "Engine offline",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    border: "border-border",
    bg: "bg-muted/40",
  },
};

export function StatusDot({ state, className }: { state: ServerState; className?: string }) {
  const meta = STATE_META[state];
  return (
    <span className={cn("relative flex size-2 shrink-0", className)}>
      <span className={cn("absolute inline-flex size-full rounded-full opacity-40", meta.dot)} />
      <span className={cn("relative inline-flex size-2 rounded-full", meta.dot)} />
    </span>
  );
}

export function EnginePill({ className }: { className?: string }) {
  const { data, isLoading, isError } = useServerStatus();
  const state: ServerState = isError ? "error" : (data?.state ?? "stopped");
  const meta = STATE_META[state];

  if (isLoading) {
    return (
      <span
        className={cn(
          "inline-flex h-7 items-center gap-2 rounded-[4px] border border-border/80 bg-card/50 px-2.5 font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="size-3 animate-spin" />
        link
      </span>
    );
  }

  return (
    <Link
      href="/server"
      title={`${meta.label}${data?.api_model_name ? ` · ${data.api_model_name}` : ""}`}
      className={cn(
        "group inline-flex h-7 items-center gap-2 rounded-[4px] border border-border/80 bg-card/45 px-2.5 font-mono text-[9px] uppercase tracking-[0.13em] transition-colors hover:border-border hover:bg-muted/50",
        state === "error" ? "text-destructive" : "text-foreground/80",
        className,
      )}
    >
      <StatusDot state={state} />
      <span>{state === "running" ? "engine live" : state === "starting" ? "warming" : meta.label}</span>
      {state === "running" && data?.api_model_name ? (
        <span className="hidden max-w-[150px] truncate font-mono text-[8px] normal-case tracking-normal text-muted-foreground/45 xl:inline">
          / {data.api_model_name}
        </span>
      ) : null}
    </Link>
  );
}

export function EngineRail() {
  const { data, isError, isLoading } = useServerStatus();
  const state: ServerState = isError ? "error" : (data?.state ?? "stopped");
  const meta = STATE_META[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/server"
          aria-label={`Engine status: ${isLoading ? "connecting" : meta.label}`}
          className={cn(
            "flex size-9 items-center justify-center rounded-lg border transition-colors hover:bg-muted/60",
            meta.border,
            meta.bg,
          )}
        >
          <StatusDot state={state} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        {isLoading ? "Connecting…" : `${meta.label} — open server controls`}
      </TooltipContent>
    </Tooltip>
  );
}

export function EngineDock({ compact = false }: { compact?: boolean }) {
  const { data, isLoading, isError } = useServerStatus();
  const state: ServerState = isError ? "error" : (data?.state ?? "stopped");
  const meta = STATE_META[state];
  const model = data?.api_model_name ?? data?.model ?? "No model loaded";

  const content = (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card/70 p-3 transition-colors hover:bg-card",
        meta.border,
        compact && "p-2",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot state={state} />
        <span className={cn("text-[11px] font-medium", meta.text)}>
          {isLoading ? "Connecting…" : meta.label}
        </span>
        <ArrowUpRight className="ml-auto size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {!compact && (
        <>
          <p className="mt-1.5 truncate font-mono text-[11px] text-foreground/80">{model}</p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {state === "running"
              ? `${data?.pid ? `pid ${data.pid} · ` : ""}up ${formatDuration(data?.uptime_seconds)}`
              : state === "error"
                ? data?.error ?? "Check the server page"
                : state === "starting"
                  ? "Loading weights into GPU memory…"
                  : "Start an engine to begin"}
          </p>
        </>
      )}

      {state === "error" && (
        <CircleAlert className="absolute right-2 top-2 size-3 text-destructive" />
      )}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href="/server" aria-label={`Engine status: ${meta.label}`}>
          {content}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="hidden xl:block">
        Open server controls
      </TooltipContent>
    </Tooltip>
  );
}
