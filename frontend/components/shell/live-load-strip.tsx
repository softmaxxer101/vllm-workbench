"use client";

import { useId } from "react";
import Link from "next/link";

import { useLiveTelemetry } from "@/hooks/use-live-telemetry";
import { decodeRate } from "@/lib/live-telemetry";
import { cn, formatNumber } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const WIDTH = 58;
const HEIGHT = 18;

type Tone = "live" | "warn" | "idle";

const TONE_STROKE: Record<Tone, string> = {
  live: "hsl(var(--primary))",
  warn: "hsl(var(--warning))",
  idle: "hsl(var(--muted-foreground) / 0.45)",
};

function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  const gradientId = useId().replace(/:/g, "");
  // A single sample has no shape; mirror it so the strip reads as a flat line.
  const samples = values.length > 1 ? values : values.length === 1 ? [values[0], values[0]] : [0, 0];
  const max = Math.max(...samples, 1);
  const step = WIDTH / (samples.length - 1);
  const points = samples.map((value, index) => {
    const x = index * step;
    const y = HEIGHT - 2 - (Math.max(0, value) / max) * (HEIGHT - 5);
    return [x, y] as const;
  });
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const stroke = TONE_STROKE[tone];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {tone === "live" ? (
        <circle cx={last[0]} cy={last[1]} r={1.7} fill={stroke} className="animate-pulse" />
      ) : null}
    </svg>
  );
}

/**
 * The shell's live load readout: decode rate, queued requests, and a rolling
 * sparkline fed by the same SSE stream as the telemetry page.
 */
export function LiveLoadStrip({ className }: { className?: string }) {
  const { status, snapshot, history, cadenceMs } = useLiveTelemetry();

  const running = snapshot?.server.state === "running";
  const rate = snapshot ? decodeRate(snapshot) : null;
  const queued = snapshot?.vllm.gauges.waiting_requests ?? 0;
  const inFlight = snapshot?.vllm.gauges.running_requests ?? 0;
  const kv = snapshot?.vllm.gauges.kv_cache_usage;
  const sampleMs = snapshot?.stream?.sample_ms;

  const tone: Tone = !running
    ? "idle"
    : status === "stalled" || status === "reconnecting"
      ? "warn"
      : "live";

  const engineState = snapshot?.server.state ?? "stopped";
  const label = !running
    ? engineState === "starting"
      ? "Engine warming up"
      : engineState === "stopping"
        ? "Engine stopping"
        : engineState === "error"
          ? "Engine error"
          : "Engine stopped"
    : status === "stalled"
      ? "Telemetry stalled"
      : status === "background"
        ? "Telemetry running in the background"
        : "Live engine load";
  const summary = running
    ? `${rate === null ? "no rate" : `${Math.round(rate)} tokens per second`}, ${queued} queued`
    : "no active engine";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/metrics"
          aria-label={`${label}: ${summary}. Open telemetry.`}
          className={cn(
            "group hidden h-7 items-center gap-2.5 rounded-[4px] border border-border/70 bg-card/35 px-2.5 transition-colors hover:border-border hover:bg-card/70 xl:flex",
            className,
          )}
        >
          <Sparkline values={history} tone={tone} />
          <span className="flex items-baseline gap-1">
            <span
              className={cn(
                "font-mono text-[13px] leading-none tabular-nums",
                running ? "text-foreground/90" : "text-muted-foreground/60",
              )}
            >
              {running && rate !== null ? formatNumber(rate, 0) : "—"}
            </span>
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground/60">
              tok/s
            </span>
          </span>
          <span className="h-3.5 w-px bg-border/60" />
          <span className="flex items-baseline gap-1">
            <span
              className={cn(
                "font-mono text-[13px] leading-none tabular-nums",
                queued > 0 ? "text-warning" : running ? "text-foreground/90" : "text-muted-foreground/60",
              )}
            >
              {running ? queued : "—"}
            </span>
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground/60">
              queued
            </span>
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="w-[228px]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            {label}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/60">
            {status}
          </span>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
          <span>
            <span className="text-foreground/80">{inFlight}</span> in flight
          </span>
          <span>
            <span className="text-foreground/80">{queued}</span> queued
          </span>
          <span>
            kv <span className="text-foreground/80">{kv === null || kv === undefined ? "—" : `${Math.round(kv * 100)}%`}</span>
          </span>
          <span>
            <span className="text-foreground/80">{sampleMs !== undefined ? `${Math.round(sampleMs)}ms` : "—"}</span> sample
          </span>
          <span className="col-span-2 text-muted-foreground/60">
            {cadenceMs !== null ? `${(cadenceMs / 1000).toFixed(1)}s frame cadence · ` : ""}
            open telemetry
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
