"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  Check,
  ClipboardCopy,
  Gauge,
  Loader2,
  Play,
  Sparkles,
  Table2,
  Timer,
  Wand2,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useServerStatus } from "@/hooks/use-server";
import { api, ApiError } from "@/lib/api";
import { SWEEP_PARAMETERS } from "@/lib/constants";
import { DEFAULT_PARAMS } from "@/lib/store";
import type { SweepBucket, SweepResult, SweepResponse } from "@/lib/types";
import { cn, downloadFile, formatMs, formatNumber } from "@/lib/utils";

const DEFAULT_PROMPT =
  "Explain in three concise bullet points why KV-cache reuse matters for LLM serving. Avoid jargon where possible.";

function parseValues(raw: string): { values: number[]; error: string | null } {
  const pieces = raw
    .split(/[,\n]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length < 2) {
    return { values: [], error: "Enter at least two comma-separated values." };
  }
  if (pieces.length > 12) {
    return { values: [], error: "Use at most 12 values per sweep." };
  }
  const values: number[] = [];
  for (const piece of pieces) {
    const value = Number(piece);
    if (!Number.isFinite(value)) {
      return { values: [], error: `"${piece}" is not a number.` };
    }
    if (values.some((existing) => Math.abs(existing - value) < 1e-9)) {
      return { values: [], error: `${value} appears more than once.` };
    }
    values.push(value);
  }
  return { values, error: null };
}

export default function SweepPage() {
  const { data: server } = useServerStatus();
  const engineReady = server?.state === "running";
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [parameter, setParameter] = useState<string>("temperature");
  const [valuesInput, setValuesInput] = useState("0.1, 0.4, 0.7, 1.0, 1.3");
  const [runsPerValue, setRunsPerValue] = useState(1);
  const [concurrency, setConcurrency] = useState(2);
  const [maxTokens, setMaxTokens] = useState(160);
  const [result, setResult] = useState<SweepResponse | null>(null);
  const [selectedResult, setSelectedResult] = useState<SweepResult | null>(null);

  const parameterMeta = SWEEP_PARAMETERS.find((item) => item.value === parameter)!;
  const parsed = useMemo(() => parseValues(valuesInput), [valuesInput]);
  const rangeError = useMemo(() => {
    if (parsed.error) return parsed.error;
    const outOfRange = parsed.values.find(
      (value) => value < parameterMeta.min || value > parameterMeta.max,
    );
    if (outOfRange !== undefined) {
      return `${parameterMeta.label} must be between ${parameterMeta.min} and ${parameterMeta.max}.`;
    }
    if ((parameter === "top_k" || parameter === "max_tokens") && parsed.values.some((value) => !Number.isInteger(value))) {
      return `${parameterMeta.label} needs whole numbers.`;
    }
    return null;
  }, [parsed, parameter, parameterMeta]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!engineReady) throw new ApiError("The engine is not running.");
      if (!prompt.trim()) throw new ApiError("Add a prompt to sweep.");
      if (rangeError) throw new ApiError(rangeError);
      return api.sweep({
        messages: [
          ...(systemPrompt.trim()
            ? [{ role: "system" as const, content: systemPrompt.trim() }]
            : []),
          { role: "user" as const, content: prompt.trim() },
        ],
        parameter,
        values: parsed.values,
        runs_per_value: runsPerValue,
        concurrency,
        sampling: {
          ...DEFAULT_PARAMS,
          max_tokens: maxTokens,
          temperature: parameter === "temperature" ? parsed.values[0] : DEFAULT_PARAMS.temperature,
          top_p: parameter === "top_p" ? parsed.values[0] : DEFAULT_PARAMS.top_p,
          top_k: parameter === "top_k" ? Math.round(parsed.values[0]) : -1,
        },
      });
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success(`Sweep finished in ${(data.duration_ms / 1000).toFixed(1)}s`, {
        description: `${data.results.length} generations across ${data.buckets.length} values.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
    onError: (error) => {
      toast.error("Sweep failed", {
        description:
          error instanceof ApiError
            ? error.hint ?? error.message
            : error instanceof Error
              ? error.message
              : "Unexpected error.",
      });
    },
  });

  const handleParameterChange = (value: string) => {
    const next = SWEEP_PARAMETERS.find((item) => item.value === value);
    setParameter(value);
    if (next) setValuesInput(next.default);
  };

  const fastest = useMemo(() => {
    if (!result) return null;
    return [...result.buckets]
      .filter((bucket) => bucket.avg_tokens_per_second !== null)
      .sort(
        (a, b) =>
          (b.avg_tokens_per_second ?? 0) - (a.avg_tokens_per_second ?? 0),
      )[0] ?? null;
  }, [result]);

  const lowestTtft = useMemo(() => {
    if (!result) return null;
    return [...result.buckets]
      .filter((bucket) => bucket.avg_ttft_ms !== null)
      .sort((a, b) => (a.avg_ttft_ms ?? 0) - (b.avg_ttft_ms ?? 0))[0] ?? null;
  }, [result]);

  const handleCsv = () => {
    if (!result) return;
    const header = "value,run,ok,ttft_ms,latency_ms,completion_tokens,tokens_per_second,finish_reason,output\n";
    const rows = result.results
      .map((item) =>
        [
          item.value,
          item.run,
          item.ok,
          item.ttft_ms ?? "",
          item.latency_ms,
          item.completion_tokens,
          item.tokens_per_second ?? "",
          item.finish_reason ?? "",
          `"${(item.output || item.error || "").replace(/"/g, '""')}"`,
        ].join(","),
      )
      .join("\n");
    downloadFile(`sweep-${result.parameter}.csv`, header + rows, "text/csv");
    toast.success("Sweep CSV downloaded");
  };

  return (
    <div>
      <PageHeader
        index="03"
        eyebrow="Parameter sweep"
        title={
          <>
            Map the <em className="text-primary">sampling space</em>
          </>
        }
        description="Run one prompt across a range of values and compare latency, throughput and output quality in a single pass."
        actions={
          <>
            {result ? (
              <Button variant="outline" size="sm" onClick={handleCsv}>
                <ClipboardCopy className="size-3.5" />
                CSV
              </Button>
            ) : null}
            <Button
              variant="gradient"
              size="sm"
              disabled={!engineReady || mutation.isPending || Boolean(rangeError) || !prompt.trim()}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {mutation.isPending ? "Sweeping…" : "Run sweep"}
            </Button>
          </>
        }
      />

      {!engineReady ? (
        <Alert
          variant="info"
          title="Start the engine before sweeping"
          className="mb-4"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/server">Server</Link>
            </Button>
          }
        >
          The sweep runs real generations on the active model.
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-fit p-4 xl:sticky xl:top-7">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
              <Wand2 className="size-3.5" />
            </span>
            <div>
              <h2 className="text-xs font-semibold">Sweep setup</h2>
              <p className="text-[10px] text-muted-foreground">One prompt, many configurations</p>
            </div>
          </div>

          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="sweep-prompt">Prompt</Label>
              <Textarea
                id="sweep-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="min-h-[110px] text-xs leading-relaxed"
                placeholder="Prompt sent to every run…"
              />
              <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
                <span>{prompt.length} chars</span>
                <span>~{Math.round(prompt.length / 3.8)} tokens</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Parameter</Label>
              <Select value={parameter} onValueChange={handleParameterChange}>
                <SelectTrigger aria-label="Sweep parameter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SWEEP_PARAMETERS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="sweep-values">Values</Label>
                <span className="font-mono text-[9px] text-muted-foreground/60">
                  {parameterMeta.min} – {parameterMeta.max}
                </span>
              </div>
              <Input
                id="sweep-values"
                value={valuesInput}
                onChange={(event) => setValuesInput(event.target.value)}
                className={cn(
                  "font-mono text-xs",
                  rangeError && "border-destructive/50 focus-visible:ring-destructive/20",
                )}
                placeholder="0.2, 0.5, 0.8"
              />
              {rangeError ? (
                <p className="text-[10px] text-destructive">{rangeError}</p>
              ) : (
                <p className="text-[10px] text-muted-foreground/60">
                  {parsed.values.length} values · {parsed.values.length * runsPerValue} generations
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sweep-runs">Runs / value</Label>
                <Input
                  id="sweep-runs"
                  type="number"
                  min={1}
                  max={5}
                  value={runsPerValue}
                  onChange={(event) =>
                    setRunsPerValue(Math.max(1, Math.min(5, Number(event.target.value) || 1)))
                  }
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sweep-concurrency">Concurrency</Label>
                <Input
                  id="sweep-concurrency"
                  type="number"
                  min={1}
                  max={4}
                  value={concurrency}
                  onChange={(event) =>
                    setConcurrency(Math.max(1, Math.min(4, Number(event.target.value) || 1)))
                  }
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sweep-max-tokens">Max tokens</Label>
              <Input
                id="sweep-max-tokens"
                type="number"
                min={8}
                max={4096}
                value={maxTokens}
                onChange={(event) =>
                  setMaxTokens(Math.max(8, Math.min(4096, Number(event.target.value) || 8)))
                }
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sweep-system">System prompt (optional)</Label>
              <Textarea
                id="sweep-system"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="min-h-[56px] text-[11px]"
                placeholder="Shared system instructions…"
              />
            </div>

            <Button
              className="w-full"
              variant="gradient"
              disabled={!engineReady || mutation.isPending || Boolean(rangeError) || !prompt.trim()}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {mutation.isPending ? "Running sweep…" : `Run ${parsed.values.length * runsPerValue} generations`}
            </Button>
            <p className="text-center text-[9px] text-muted-foreground/60">
              Each run is measured end to end through the workbench proxy.
            </p>
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {mutation.isPending ? (
            <Card className="p-6">
              <div className="flex items-center gap-3">
                <Loader2 className="size-4 animate-spin text-primary" />
                <div>
                  <p className="text-xs font-medium">Sweeping {parameterMeta.label.toLowerCase()}…</p>
                  <p className="text-[10px] text-muted-foreground">
                    {parsed.values.length} values × {runsPerValue} run{runsPerValue > 1 ? "s" : ""} · concurrency {concurrency}
                  </p>
                </div>
              </div>
              <div className="mt-5 space-y-2">
                {parsed.values.map((value) => (
                  <Skeleton key={value} className="h-9 w-full" />
                ))}
              </div>
            </Card>
          ) : result ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryTile
                  icon={<Activity className="size-3.5" />}
                  label="Duration"
                  value={`${(result.duration_ms / 1000).toFixed(1)}s`}
                />
                <SummaryTile
                  icon={<Gauge className="size-3.5" />}
                  label="Best throughput"
                  value={
                    fastest?.avg_tokens_per_second
                      ? `${formatNumber(fastest.avg_tokens_per_second, 1)} tok/s`
                      : "—"
                  }
                  detail={fastest ? `${formatNumber(fastest.value, 2)}` : undefined}
                />
                <SummaryTile
                  icon={<Timer className="size-3.5" />}
                  label="Lowest TTFT"
                  value={lowestTtft?.avg_ttft_ms ? formatMs(lowestTtft.avg_ttft_ms) : "—"}
                  detail={lowestTtft ? `${formatNumber(lowestTtft.value, 2)}` : undefined}
                />
                <SummaryTile
                  icon={<Check className="size-3.5" />}
                  label="Successful"
                  value={`${result.results.filter((item) => item.ok).length}/${result.results.length}`}
                />
              </div>

              <Card className="min-w-0 overflow-hidden p-4">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <BarChart3 className="size-3.5 text-primary" />
                    <h2 className="text-xs font-semibold">Throughput vs latency</h2>
                  </div>
                  <span className="rounded border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {result.parameter}
                  </span>
                </div>
                <div className="h-[260px] w-full min-w-0 overflow-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={result.buckets} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="value"
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={{ stroke: "hsl(var(--border))" }}
                        tickLine={false}
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        unit="ms"
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <ChartTooltip
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 11,
                          color: "hsl(var(--popover-foreground))",
                        }}
                        formatter={(value, name) => [
                          typeof value === "number" ? formatNumber(value, 1) : value,
                          name === "avg_latency_ms" ? "Latency (ms)" : "Throughput (tok/s)",
                        ]}
                        labelFormatter={(value) => `${result.parameter}: ${value}`}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 10, paddingTop: 6 }}
                        formatter={(value) =>
                          value === "avg_latency_ms" ? "Avg latency" : "Avg throughput"
                        }
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="avg_latency_ms"
                        fill="#9b87ff"
                        opacity={0.3}
                        radius={[4, 4, 0, 0]}
                        maxBarSize={44}
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avg_tokens_per_second"
                        stroke="#2dd4a7"
                        strokeWidth={2}
                        dot={{ r: 3, fill: "#2dd4a7" }}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                  <Table2 className="size-3.5 text-muted-foreground" />
                  <h2 className="text-xs font-semibold">Runs</h2>
                  <span className="text-[10px] text-muted-foreground">
                    {result.results.length} generations · click a row for the full output
                  </span>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow>
                        <TableHead>{result.parameter}</TableHead>
                        <TableHead className="text-right">TTFT</TableHead>
                        <TableHead className="text-right">tok/s</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead>Output</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.results.map((item) => (
                        <TableRow
                          key={`${item.value}-${item.run}`}
                          className="cursor-pointer"
                          tabIndex={0}
                          role="button"
                          onClick={() => setSelectedResult(item)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedResult(item);
                            }
                          }}
                        >
                          <TableCell className="font-mono text-[11px]">
                            {formatNumber(item.value, 2)}
                            {result.results.filter((row) => row.value === item.value).length > 1 ? (
                              <span className="ml-1 text-[9px] text-muted-foreground">#{item.run}</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[10px] tabular-nums">
                            {formatMs(item.ttft_ms)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[10px] tabular-nums">
                            {item.tokens_per_second ? formatNumber(item.tokens_per_second, 1) : "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[10px] tabular-nums">
                            {item.completion_tokens}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[10px] tabular-nums">
                            {formatMs(item.latency_ms)}
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            {item.ok ? (
                              <span className="line-clamp-1 text-[10px] text-muted-foreground">
                                {item.output || "—"}
                              </span>
                            ) : (
                              <span className="line-clamp-1 text-[10px] text-destructive">
                                {item.error}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </>
          ) : (
            <Card className="flex min-h-[520px] flex-col items-center justify-center p-8 text-center">
              <div className="relative">
                <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-2xl" />
                <div className="relative flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-card text-primary">
                  <Sparkles className="size-5" />
                </div>
              </div>
              <h2 className="mt-4 text-base font-semibold">Awaiting a sweep</h2>
              <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Pick a parameter, enter values, and every run streams through the measured proxy.
                You&apos;ll get a latency/throughput chart and the raw generations in a table.
              </p>
              <div className="mt-6 grid w-full max-w-md gap-2 text-left">
                {[
                  ["1", "Choose a parameter and values", "Temperature is a good first sweep."],
                  ["2", "Run the sweep", "Requests execute with bounded concurrency."],
                  ["3", "Read the curve", "Faster is not always better — inspect the outputs."],
                ].map(([step, title, detail]) => (
                  <div key={step} className="flex gap-3 rounded-lg border bg-card/40 p-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] text-primary">
                      {step}
                    </span>
                    <div>
                      <p className="text-[11px] font-medium">{title}</p>
                      <p className="text-[10px] text-muted-foreground">{detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={selectedResult !== null} onOpenChange={(open) => !open && setSelectedResult(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {result?.parameter} = {selectedResult ? formatNumber(selectedResult.value, 2) : ""}
            </DialogTitle>
            <DialogDescription>
              {selectedResult?.completion_tokens} tokens · {formatMs(selectedResult?.ttft_ms)} TTFT ·{" "}
              {selectedResult?.tokens_per_second
                ? `${formatNumber(selectedResult.tokens_per_second, 1)} tok/s`
                : "no throughput"}
            </DialogDescription>
          </DialogHeader>
          {selectedResult?.ok ? (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-background/50 p-4">
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                {selectedResult.output}
              </pre>
            </div>
          ) : (
            <Alert variant="error" title="Run failed">
              {selectedResult?.error}
            </Alert>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="label-caps">{label}</span>
      </div>
      <p className="mt-1.5 font-mono text-lg font-medium tabular-nums">{value}</p>
      {detail ? (
        <p className="font-mono text-[9px] text-muted-foreground/60">at {detail}</p>
      ) : null}
    </Card>
  );
}
