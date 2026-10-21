"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Cpu,
  Database,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Timer,
  Trash2,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLiveMetrics } from "@/hooks/use-server";
import { api } from "@/lib/api";
import { SOURCE_LABELS } from "@/lib/constants";
import { cn, formatMs, formatNumber, formatBytes } from "@/lib/utils";
import type { GPUMetric, MetricsSnapshot, SeriesPoint } from "@/lib/types";

const chartAxis = {
  tick: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
  axisLine: { stroke: "hsl(var(--border))" },
  tickLine: false,
};

function MetricTile({
  icon,
  label,
  value,
  unit,
  detail,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  detail?: React.ReactNode;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <Card className="min-w-0 overflow-hidden p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="truncate font-mono text-[8.5px] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
        <span className="shrink-0 text-muted-foreground/40">{icon}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono text-[24px] font-medium leading-none tracking-[-0.05em] tabular-nums",
            tone === "warning" && "text-warning",
            tone === "success" && "text-success",
          )}
        >
          {value}
        </span>
        {unit ? (
          <span className="truncate font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
            {unit}
          </span>
        ) : null}
      </div>
      <div className="mt-2 h-px w-full bg-border/60" />
      <div className="mt-1.5 min-h-4 truncate font-mono text-[8.5px] text-muted-foreground/60">
        {detail}
      </div>
    </Card>
  );
}

function PulseLine({ values, active }: { values: number[]; active: boolean }) {
  const width = 300;
  const height = 46;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? width : (index / (values.length - 1)) * width;
    const y = height - 4 - (Math.max(0, value) / max) * (height - 10);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <div className="relative mt-4 h-12 w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#pulseFill)" />
        {points.length > 1 ? (
          <path
            d={line}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {active && points.length ? (
        <span
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]"
          style={{
            left: `${(points[points.length - 1][0] / width) * 100}%`,
            top: `${(points[points.length - 1][1] / height) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}

function chartData(series: SeriesPoint[]) {
  return series.map((point) => ({
    ...point,
    label: new Date(point.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));
}

function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-lg border border-dashed bg-card/70 px-3 py-2 text-center text-[10px] text-muted-foreground backdrop-blur-sm">
        {children}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [paused, setPaused] = useState(false);
  const {
    data,
    isLoading,
    isError,
    isFetching,
    refetch,
    received,
    lastAt,
    state,
  } = useLiveMetrics({ paused });
  const queryClient = useQueryClient();

  const clearMutation = useMutation({
    mutationFn: api.clearMetrics,
    onSuccess: () => {
      toast.success("Workbench request metrics cleared");
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
    onError: () => toast.error("Could not clear metrics"),
  });

  const points = useMemo(() => (data ? chartData(data.series) : []), [data]);
  const hasThroughput = points.some((point) => point.avg_tokens_per_second !== null);
  const hasLatency = points.some((point) => point.avg_ttft_ms !== null);
  const pulseValues = useMemo(
    () => points.slice(-36).map((point) => point.avg_tokens_per_second ?? 0),
    [points],
  );

  if (isError && !data) {
    return (
      <div>
        <PageHeader index="04" eyebrow="Telemetry" title="Live from the engine" />
        <Alert variant="error" title="Backend unreachable">
          The dashboard cannot reach the FastAPI backend. Start it and refresh this page.
        </Alert>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-[320px] w-full" />
      </div>
    );
  }

  const { vllm, summary, gpus } = data;
  const live = data.server.state === "running";
  const primaryGpu = gpus[0];
  const liveRate =
    (vllm.rates.generation_tokens_per_second ?? 0) > 0
      ? vllm.rates.generation_tokens_per_second
      : summary.tokens_per_second;
  const streamIntervalS = data.stream?.interval_s ?? 1;
  const streamHz = streamIntervalS > 0 ? Math.round(1 / streamIntervalS) : 1;
  const sampleMs = data.stream?.sample_ms;
  const streamLabel =
    state === "live"
      ? `SSE · ${streamHz} Hz`
      : state === "stalled"
        ? `stalled ${lastAt ? Math.max(1, Math.round((Date.now() - lastAt) / 1000)) : "?"}s`
        : state === "background"
          ? "tab hidden"
          : state === "paused"
          ? "paused"
          : state === "reconnecting"
            ? "reconnecting"
            : "connecting";
  const lastFrame = lastAt
    ? new Date(lastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const dropped = data.stream?.dropped ?? 0;
  const cachePercent =
    vllm.gauges.kv_cache_usage !== null ? Math.round(vllm.gauges.kv_cache_usage * 100) : null;
  const vramPercent =
    primaryGpu?.memory_used_mb && primaryGpu.memory_total_mb
      ? (primaryGpu.memory_used_mb / primaryGpu.memory_total_mb) * 100
      : null;

  return (
    <div>
      <PageHeader
        index="04"
        eyebrow="Telemetry"
        title={
          <>
            Live from the <em className="text-primary">engine</em>
          </>
        }
        description="Engine-level metrics from vLLM's Prometheus endpoint, paired with per-request timings measured by the workbench — pushed over SSE every second."
        actions={
          <>
            <span className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-border/80 bg-card/50 px-2.5 font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  state === "live"
                    ? "bg-signal shadow-[0_0_8px_hsl(var(--signal))]"
                    : state === "stalled"
                      ? "animate-pulse bg-warning shadow-[0_0_8px_hsl(var(--warning))]"
                      : state === "reconnecting"
                        ? "animate-pulse bg-warning"
                        : "bg-muted-foreground/50",
                )}
              />
              {streamLabel}
              <span className="text-muted-foreground/50">{lastFrame}</span>
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setPaused((value) => !value)}
                  aria-label={paused ? "Resume live telemetry" : "Pause live telemetry"}
                  aria-pressed={paused}
                >
                  {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{paused ? "Resume stream" : "Pause stream"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" onClick={() => void refetch()} aria-label="Refresh metrics">
                  <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh now</TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending || summary.requests === 0}
            >
              <Trash2 className="size-3.5" />
              Clear
            </Button>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,2fr)]">
        <Card className="panel-featured min-w-0 overflow-hidden p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-muted-foreground">
              decode / now
            </span>
            <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground/55">
              {!live
                ? "engine idle"
                : state === "live"
                  ? "streaming"
                  : state === "stalled"
                    ? "no frames"
                    : state === "background"
                      ? "background"
                      : state === "paused"
                        ? "paused"
                        : state === "connecting"
                          ? "connecting"
                          : "reconnecting"}
            </span>
          </div>
          <div className="mt-3 flex items-end gap-2">
            <span className="font-display text-[64px] leading-[0.78] tracking-[-0.02em] tabular-nums sm:text-[72px]">
              {formatNumber(liveRate, 1)}
            </span>
            <span className="pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/70">
              tok/s
            </span>
          </div>
          <PulseLine values={pulseValues} active={state === "live"} />
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-2 font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground/55">
            <span className="truncate">
              {(vllm.rates.generation_tokens_per_second ?? 0) > 0
                ? "instant rate from vLLM counters"
                : summary.tokens_per_second !== null
                  ? "last request average"
                  : "awaiting generated tokens"}
            </span>
            <span className="shrink-0 tabular-nums">
              {received > 0 ? `${received} frames` : "no frame"}
              {sampleMs !== undefined ? ` · ${Math.round(sampleMs)} ms sample` : ""}
              {dropped > 0 ? ` · ${dropped} dropped` : ""}
            </span>
          </div>
        </Card>

        <div className="grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile
          icon={<Timer className="size-3" />}
          label="TTFT p95"
          value={formatMs(vllm.latencies.ttft_p95_ms ?? summary.p95_ttft_ms)}
          detail={
            vllm.latencies.ttft_p50_ms
              ? `p50 ${formatMs(vllm.latencies.ttft_p50_ms)}`
              : `avg ${formatMs(summary.avg_ttft_ms)}`
          }
        />
        <MetricTile
          icon={<Activity className="size-3" />}
          label="In flight"
          value={String(vllm.gauges.running_requests ?? 0)}
          unit="requests"
          detail={`${vllm.gauges.waiting_requests ?? 0} queued · ${summary.requests} total`}
          tone={(vllm.gauges.waiting_requests ?? 0) > 0 ? "warning" : "default"}
        />
        <MetricTile
          icon={<Database className="size-3" />}
          label="KV cache"
          value={cachePercent !== null ? String(cachePercent) : "—"}
          unit="%"
          detail={
            vllm.total_generation_tokens !== null
              ? `${formatNumber(vllm.total_generation_tokens)} tokens generated`
              : "vLLM gauge unavailable"
          }
        />
        <MetricTile
          icon={<Cpu className="size-3" />}
          label="GPU memory"
          value={
            primaryGpu?.memory_used_mb != null ? String(Math.round(primaryGpu.memory_used_mb)) : "—"
          }
          unit={primaryGpu?.memory_total_mb ? `/ ${Math.round(primaryGpu.memory_total_mb)} MB` : "MB"}
          detail={
            primaryGpu
              ? `${Math.round(vramPercent ?? 0)}% used · ${primaryGpu.utilization_percent ?? 0}% util`
              : "No NVIDIA GPU detected"
          }
          tone={vramPercent && vramPercent > 92 ? "warning" : "default"}
        />
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <div className="grid min-w-0 gap-3 xl:grid-cols-2">
            <Card className="min-w-0 overflow-hidden p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <p className="label-caps">throughput / 30s</p>
                  <h2 className="mt-1 font-display text-[25px] leading-none">Decode rate</h2>
                </div>
                <span className="mt-1 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground/50">
                  tok/s
                </span>
              </div>
              <div className="relative h-[210px] w-full min-w-0 overflow-hidden">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tpsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" {...chartAxis} interval="preserveStartEnd" minTickGap={40} />
                    <YAxis {...chartAxis} axisLine={false} width={46} />
                    <ChartTooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                      formatter={(value) => [`${formatNumber(Number(value), 1)} tok/s`, "Throughput"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="avg_tokens_per_second"
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={1.8}
                      fill="url(#tpsFill)"
                      dot={{ r: 2.5, fill: "hsl(var(--chart-1))", strokeWidth: 0 }}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                {!hasThroughput ? <ChartEmpty>Send a prompt to measure throughput</ChartEmpty> : null}
              </div>
            </Card>

            <Card className="min-w-0 overflow-hidden p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="label-caps">latency / 30s</p>
                  <h2 className="mt-1 truncate font-display text-[25px] leading-none">
                    Time to first token
                  </h2>
                </div>
                <span className="mt-1 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground/50">
                  ms
                </span>
              </div>
              <div className="relative h-[210px] w-full min-w-0 overflow-hidden">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" {...chartAxis} interval="preserveStartEnd" minTickGap={40} />
                    <YAxis {...chartAxis} axisLine={false} width={46} unit="ms" />
                    <ChartTooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                      formatter={(value) => [`${formatNumber(Number(value), 0)} ms`, "TTFT"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="avg_ttft_ms"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={1.8}
                      dot={{ r: 2.5, fill: "hsl(var(--chart-2))", strokeWidth: 0 }}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
                {!hasLatency ? <ChartEmpty>TTFT appears after the first stream</ChartEmpty> : null}
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <p className="label-caps">request ledger</p>
                <h2 className="mt-1 font-display text-[25px] leading-none">Recent requests</h2>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Latest {Math.min(data.recent.length, 100)} generations · measured end to end
                </p>
              </div>
              <div className="flex items-center gap-3 font-mono text-[9px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <ArrowUpRight className="size-3 text-success" />
                  {formatNumber(summary.successes)} ok
                </span>
                <span className="inline-flex items-center gap-1">
                  <ArrowDownRight className="size-3 text-destructive" />
                  {formatNumber(summary.errors)} errors
                </span>
                <span>{formatNumber(summary.completion_tokens)} tokens</span>
              </div>
            </div>
            {data.recent.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <Activity className="size-5 text-muted-foreground/40" />
                <p className="mt-2 text-xs font-medium">No requests yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Chat, compare or sweep — every generation shows up here.
                </p>
              </div>
            ) : (
              <div className="max-h-[360px] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Prompt</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">TTFT</TableHead>
                      <TableHead className="text-right">tok/s</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent.map((request) => (
                      <TableRow key={request.id}>
                        <TableCell className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                          {new Date(request.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </TableCell>
                        <TableCell>
                          <Badge variant="muted" className="text-[9px]">
                            {SOURCE_LABELS[request.source] ?? request.source}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-[10px] tabular-nums">
                          {request.prompt_tokens}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[10px] tabular-nums">
                          {request.completion_tokens}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[10px] tabular-nums">
                          {formatMs(request.ttft_ms)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[10px] tabular-nums">
                          {request.tokens_per_second ? formatNumber(request.tokens_per_second, 1) : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[10px] tabular-nums">
                          {formatMs(request.latency_ms)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant={
                              request.status === "ok"
                                ? "success"
                                : request.status === "aborted"
                                  ? "warning"
                                  : "destructive"
                            }
                            className="text-[9px]"
                          >
                            {request.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          <EngineCard data={data} />
          <GpuCard gpus={gpus} />
          <Card className="p-4">
            <p className="label-caps">engine internals</p>
            <h2 className="mt-1 font-display text-[24px] leading-none">vLLM counters</h2>
            <div className="mt-4 space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">KV cache occupancy</span>
                  <span className="font-mono">{cachePercent !== null ? `${cachePercent}%` : "—"}</span>
                </div>
                <Progress
                  value={cachePercent ?? 0}
                  indicatorClassName={cn(
                    cachePercent && cachePercent > 90 ? "bg-warning" : "bg-primary",
                  )}
                />
              </div>
              <Separator />
              <InfoRow
                label="Prefix cache hit rate"
                value={
                  vllm.prefix_cache_hit_rate !== null
                    ? `${Math.round(vllm.prefix_cache_hit_rate * 100)}%`
                    : "—"
                }
              />
              <InfoRow
                label="Prompt tokens processed"
                value={formatNumber(vllm.total_prompt_tokens)}
              />
              <InfoRow
                label="Generation tokens"
                value={formatNumber(vllm.total_generation_tokens)}
              />
              <InfoRow
                label="Inter-token latency"
                value={formatMs(vllm.latencies.inter_token_p50_ms)}
              />
              <InfoRow
                label="Engine state"
                value={vllm.available ? (vllm.gauges.engine_awake === false ? "sleeping" : "awake") : "unavailable"}
              />
            </div>
          </Card>
          {!vllm.available ? (
            <Alert variant="warning" title="Engine metrics unavailable">
              {live
                ? "vLLM isn't exposing /metrics yet. Request-level timings below still work."
                : "Start the engine to collect GPU and KV-cache telemetry."}
            </Alert>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EngineCard({ data }: { data: MetricsSnapshot }) {
  const config = data.server.config;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-caps">loaded model</p>
          <h2 className="mt-1 font-display text-[24px] leading-none">Active engine</h2>
        </div>
        <Link
          href="/server"
          className="font-mono text-[9px] uppercase tracking-[0.12em] text-primary hover:underline"
        >
          Manage ↗
        </Link>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-lg border",
            data.server.state === "running"
              ? "border-success/20 bg-success/10 text-success"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          <Layers className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px]">
            {data.server.api_model_name ?? (config?.model.split("/").pop() || "No model")}
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {config?.model ?? "Start an engine to load a model"}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3">
        <InfoRow label="Context" value={config ? formatNumber(config.max_model_len) : "—"} />
        <InfoRow label="GPU util" value={config ? `${Math.round(config.gpu_memory_utilization * 100)}%` : "—"} />
        <InfoRow label="Tensor parallel" value={config ? String(config.tensor_parallel_size) : "—"} />
        <InfoRow label="dtype" value={config?.dtype ?? "—"} />
        <InfoRow label="Quantization" value={config?.quantization ?? "none"} />
        <InfoRow
          label="Uptime"
          value={
            data.server.uptime_seconds !== null
              ? `${Math.floor(data.server.uptime_seconds / 60)}m`
              : "—"
          }
        />
      </div>
      {data.server.hint && data.server.state !== "running" ? (
        <p className="mt-3 rounded-md border border-warning/20 bg-warning/10 p-2 text-[10px] text-muted-foreground">
          {data.server.hint}
        </p>
      ) : null}
    </Card>
  );
}

function GpuCard({ gpus }: { gpus: GPUMetric[] }) {
  return (
    <Card className="p-4">
      <div>
        <p className="label-caps">physical device</p>
        <h2 className="mt-1 font-display text-[24px] leading-none">Hardware</h2>
      </div>
      {gpus.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-[10px] leading-relaxed text-muted-foreground">
          No NVIDIA GPU detected by nvidia-smi. In Docker, pass through the GPU with the NVIDIA
          container runtime.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {gpus.map((gpu) => {
            const memoryPercent =
              gpu.memory_used_mb && gpu.memory_total_mb
                ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100
                : 0;
            return (
              <div key={gpu.index}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[10px] font-medium">GPU {gpu.index} · {gpu.name}</p>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                    {gpu.temperature_c !== null ? `${gpu.temperature_c}°C` : ""}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  <div>
                    <div className="mb-1 flex justify-between font-mono text-[9px] text-muted-foreground">
                      <span>VRAM</span>
                      <span>
                        {formatBytes((gpu.memory_used_mb ?? 0) * 1024 * 1024)} /{" "}
                        {formatBytes((gpu.memory_total_mb ?? 0) * 1024 * 1024)}
                      </span>
                    </div>
                    <Progress value={memoryPercent} indicatorClassName="bg-primary" />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between font-mono text-[9px] text-muted-foreground">
                      <span>Utilization</span>
                      <span>{gpu.utilization_percent ?? 0}%</span>
                    </div>
                    <Progress value={gpu.utilization_percent ?? 0} indicatorClassName="bg-signal" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-[10px] tabular-nums text-foreground/90">{value}</span>
    </div>
  );
}
