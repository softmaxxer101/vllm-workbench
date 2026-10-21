"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  CircleCheck,
  Copy,
  DownloadCloud,
  Gauge,
  HardDrive,
  Loader2,
  Lock,
  Play,
  Power,
  RotateCcw,
  Save,
  ServerCog,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { STATE_META, StatusDot } from "@/components/shell/engine-status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LogConsole } from "@/components/server/log-console";
import { ModelPicker } from "@/components/server/model-picker";
import { useServerConfig, useServerStatus, useSystemInfo } from "@/hooks/use-server";
import { api, API_BASE, ApiError } from "@/lib/api";
import { DTYPE_OPTIONS, MODEL_PRESETS, QUANTIZATION_OPTIONS } from "@/lib/constants";
import type { ServerConfig } from "@/lib/types";
import { cn, copyText, formatDuration, formatNumber, splitArgs } from "@/lib/utils";
import { validateServerConfig } from "@/lib/validation";

const EMPTY_CONFIG: ServerConfig = {
  model: "Qwen/Qwen2.5-1.5B-Instruct",
  served_model_name: null,
  max_model_len: 4096,
  gpu_memory_utilization: 0.88,
  tensor_parallel_size: 1,
  dtype: "auto",
  quantization: null,
  trust_remote_code: false,
  enforce_eager: false,
  max_num_seqs: null,
  extra_args: [],
};

export default function ServerPage() {
  const statusQuery = useServerStatus({ intervalMs: 3000 });
  const configQuery = useServerConfig();
  const systemQuery = useSystemInfo();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<ServerConfig | null>(null);
  const [extraArgsText, setExtraArgsText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const status = statusQuery.data;
  const state = status?.state ?? "stopped";
  const locked = state === "running" || state === "starting" || state === "stopping";
  const busy = state === "starting" || state === "stopping";

  useEffect(() => {
    if (configQuery.data && !form) {
      setForm(configQuery.data);
      setExtraArgsText(configQuery.data.extra_args.join(" "));
    }
  }, [configQuery.data, form]);

  const candidate: ServerConfig | null = useMemo(() => {
    if (!form) return null;
    return { ...form, extra_args: splitArgs(extraArgsText) };
  }, [form, extraArgsText]);

  const validation = candidate
    ? validateServerConfig(candidate)
    : { ok: false, errors: { form: "Loading configuration…" } };

  const dirty =
    Boolean(candidate && configQuery.data) &&
    JSON.stringify(candidate) !== JSON.stringify(configQuery.data) &&
    !locked;

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["server"] });
    void queryClient.invalidateQueries({ queryKey: ["system"] });
    void queryClient.invalidateQueries({ queryKey: ["metrics"] });
  };

  const handleError = (error: unknown, fallback: string) => {
    const message = error instanceof ApiError ? error.message : fallback;
    const hint = error instanceof ApiError ? error.hint : null;
    toast.error(message, { description: hint ?? undefined });
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!candidate) throw new ApiError("Configuration is still loading.");
      if (!validation.ok) throw new ApiError("Fix the configuration errors first.");
      return api.start(candidate);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["server", "status"], data);
      refreshAll();
      if (data.state === "error") {
        toast.error("The engine failed to start", {
          description: data.hint ?? data.error ?? "Check the logs below for the root cause.",
        });
        return;
      }
      toast.success("Launching vLLM", {
        description: "Watch the logs below while weights load into GPU memory.",
      });
    },
    onError: (error) => handleError(error, "Could not start the engine."),
  });

  const stopMutation = useMutation({
    mutationFn: api.stop,
    onSuccess: (data) => {
      queryClient.setQueryData(["server", "status"], data);
      refreshAll();
      toast.success("Engine stopped");
    },
    onError: (error) => handleError(error, "Could not stop the engine."),
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      if (!candidate) throw new ApiError("Configuration is still loading.");
      if (!validation.ok) throw new ApiError("Fix the configuration errors first.");
      return api.restart(candidate);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["server", "status"], data);
      refreshAll();
      if (data.state === "error") {
        toast.error("The engine failed to restart", {
          description: data.hint ?? data.error ?? "Check the logs below for the root cause.",
        });
        return;
      }
      toast.success("Restarting engine");
    },
    onError: (error) => handleError(error, "Could not restart the engine."),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!candidate) throw new ApiError("Configuration is still loading.");
      if (!validation.ok) throw new ApiError("Fix the configuration errors first.");
      return api.updateConfig(candidate);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["server", "config"], saved);
      setForm(saved);
      setExtraArgsText(saved.extra_args.join(" "));
      void queryClient.invalidateQueries({ queryKey: ["server", "config"] });
      toast.success("Configuration saved");
    },
    onError: (error) => handleError(error, "Could not save the configuration."),
  });

  const update = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const gpu = systemQuery.data?.gpus?.[0];
  const meta = STATE_META[state];
  const apiModel = status?.api_model_name ?? candidate?.model.split("/").pop() ?? "model";
  const startDisabled =
    locked || busy || !validation.ok || startMutation.isPending || stopMutation.isPending;
  const anyPending =
    startMutation.isPending ||
    stopMutation.isPending ||
    restartMutation.isPending ||
    saveMutation.isPending;

  const curlSnippet = `curl ${API_BASE}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${apiModel}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'`;

  return (
    <div>
      <PageHeader
        index="05"
        eyebrow="Engine control"
        title={
          <>
            Engine <em className="text-primary">control room</em>
          </>
        }
        description="Launch, configure and supervise the vLLM process that powers every page in the workbench."
        actions={
          <>
            {state === "running" || state === "error" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => restartMutation.mutate()}
                disabled={anyPending}
              >
                <RotateCcw className={cn("size-3.5", restartMutation.isPending && "animate-spin")} />
                Restart
              </Button>
            ) : null}
            {state === "running" || state === "starting" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending}
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {stopMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3" />
                )}
                Stop
              </Button>
            ) : (
              <Button
                variant="gradient"
                size="sm"
                onClick={() => startMutation.mutate()}
                disabled={startDisabled}
              >
                {startMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                Start engine
              </Button>
            )}
          </>
        }
      />

      <Card className="relative mb-4 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,hsl(var(--primary)/0.14),transparent_55%)]" />
        <div className="relative flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          <div
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-xl border",
              meta.border,
              meta.bg,
              meta.text,
            )}
          >
            {state === "starting" || state === "stopping" ? (
              <Loader2 className="size-5 animate-spin" />
            ) : state === "error" ? (
              <TriangleAlert className="size-5" />
            ) : state === "running" ? (
              <Zap className="size-5" />
            ) : (
              <Power className="size-5" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">
                {state === "running"
                  ? "Engine is ready"
                  : state === "starting"
                    ? "Loading model into GPU memory"
                    : state === "stopping"
                      ? "Shutting down"
                      : state === "error"
                        ? "Engine needs attention"
                        : "Engine is stopped"}
              </h2>
              <Badge variant={state === "running" ? "success" : state === "error" ? "destructive" : state === "starting" ? "warning" : "muted"} className="gap-1.5">
                <StatusDot state={state} />
                {meta.label}
              </Badge>
              {systemQuery.data?.mock_mode ? (
                <Badge variant="warning">demo engine</Badge>
              ) : null}
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {state === "running"
                ? `Serving ${status?.api_model_name ?? "model"} on ${status?.base_url ?? "the local port"}. Requests are measured by the proxy.`
                : state === "starting"
                  ? "vLLM is starting. First launches can spend a long time downloading weights; the logs below show progress."
                  : state === "error"
                    ? status?.error ?? "The engine exited unexpectedly."
                    : "Configure the model and launch the OpenAI-compatible server. Defaults are tuned for a small local GPU."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
              {status?.pid ? <span>pid {status.pid}</span> : null}
              {status?.uptime_seconds !== null && status?.uptime_seconds !== undefined ? (
                <span>uptime {formatDuration(status.uptime_seconds)}</span>
              ) : null}
              {status?.api_model_name ? <span className="truncate">model {status.api_model_name}</span> : null}
              {gpu ? (
                <span className="truncate">
                  {gpu.name} · {Math.round(gpu.memory_total_mb ?? 0)} MB
                </span>
              ) : null}
            </div>
          </div>

          {state === "starting" ? (
            <div className="w-full shrink-0 sm:w-44">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>warming up</span>
                <Loader2 className="size-3 animate-spin" />
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/2 animate-shimmer rounded-full bg-primary" />
              </div>
              <p className="mt-1.5 text-[9px] text-muted-foreground/60">
                The composer unlocks automatically.
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      {state === "error" ? (
        <Alert variant="error" title="vLLM could not start" className="mb-4">
          <p>{status?.error}</p>
          {status?.hint ? <p className="mt-1 text-muted-foreground">{status.hint}</p> : null}
          {status?.log_tail?.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] text-muted-foreground">
                Last {status.log_tail.length} log lines
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded border bg-background/60 p-2 font-mono text-[9.5px] leading-relaxed text-muted-foreground">
                {status.log_tail.slice(-12).join("\n")}
              </pre>
            </details>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <Card className="h-fit overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <ServerCog className="size-3.5 text-muted-foreground" />
            <h2 className="text-xs font-semibold">Launch configuration</h2>
            {locked ? (
              <Badge variant="muted" className="gap-1 font-normal">
                <Lock className="size-2.5" />
                stop to edit
              </Badge>
            ) : dirty ? (
              <Badge variant="warning" className="font-normal">
                unsaved changes
              </Badge>
            ) : (
              <Badge variant="muted" className="gap-1 font-normal">
                <CircleCheck className="size-2.5" />
                saved
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1">
              {dirty ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px]"
                  onClick={() => saveMutation.mutate()}
                  disabled={anyPending || !validation.ok}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  Save
                </Button>
              ) : null}
            </div>
          </div>

          {locked ? (
            <div className="border-b bg-muted/30 px-4 py-2 text-[10px] text-muted-foreground">
              The engine is {state}. Stop it to change the launch configuration; the active
              settings are shown read-only.
            </div>
          ) : null}

          {!form ? (
            <div className="space-y-4 p-4">
              <Skeleton className="h-9 w-full" />
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <fieldset disabled={locked} className="min-w-0 p-4 disabled:opacity-70">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="model">Model</Label>
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      disabled={locked}
                      className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline disabled:opacity-50"
                    >
                      <Sparkles className="size-3" />
                      Browse models
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="model"
                      value={form.model}
                      onChange={(event) => update("model", event.target.value)}
                      placeholder="Qwen/Qwen2.5-1.5B-Instruct or /models/my-model"
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0"
                      onClick={() => setPickerOpen(true)}
                      disabled={locked}
                    >
                      <DownloadCloud className="size-3.5" />
                      Browse
                    </Button>
                  </div>
                  {validation.errors.model ? (
                    <p className="text-[10px] text-destructive">{validation.errors.model}</p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      Hugging Face id or an absolute path on the backend host. Weights download on
                      first launch.
                    </p>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="max-model-len">Max model length</Label>
                    <Input
                      id="max-model-len"
                      type="number"
                      min={256}
                      step={256}
                      value={form.max_model_len || ""}
                      onChange={(event) => update("max_model_len", Number(event.target.value))}
                      className="font-mono text-xs"
                    />
                    {validation.errors.max_model_len ? (
                      <p className="text-[10px] text-destructive">{validation.errors.max_model_len}</p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">
                        Context window. Lower values save KV-cache memory.
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="tensor-parallel">Tensor parallel size</Label>
                    <Input
                      id="tensor-parallel"
                      type="number"
                      min={1}
                      max={16}
                      value={form.tensor_parallel_size || ""}
                      onChange={(event) =>
                        update("tensor_parallel_size", Number(event.target.value))
                      }
                      className="font-mono text-xs"
                    />
                    {validation.errors.tensor_parallel_size ? (
                      <p className="text-[10px] text-destructive">
                        {validation.errors.tensor_parallel_size}
                      </p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">
                        Number of GPUs the model is sharded across.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="gpu-memory">GPU memory utilization</Label>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Fraction of VRAM vLLM may preallocate for weights and KV cache.
                      </p>
                    </div>
                    <span className="rounded border bg-background/60 px-2 py-0.5 font-mono text-[11px] tabular-nums">
                      {Math.round(form.gpu_memory_utilization * 100)}%
                    </span>
                  </div>
                  <Slider
                    id="gpu-memory"
                    value={[form.gpu_memory_utilization]}
                    min={0.05}
                    max={0.99}
                    step={0.01}
                    onValueChange={([value]) => update("gpu_memory_utilization", value)}
                  />
                  <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
                    <span>0.05</span>
                    <span>leave ~10% headroom for the OS</span>
                    <span>0.99</span>
                  </div>
                  {validation.errors.gpu_memory_utilization ? (
                    <p className="text-[10px] text-destructive">
                      {validation.errors.gpu_memory_utilization}
                    </p>
                  ) : form.gpu_memory_utilization > 0.95 ? (
                    <p className="text-[10px] text-warning">
                      Above 95% can make the desktop or other processes unstable.
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>dtype</Label>
                    <Select
                      value={form.dtype}
                      onValueChange={(value) => update("dtype", value as ServerConfig["dtype"])}
                    >
                      <SelectTrigger aria-label="Model dtype">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DTYPE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Quantization</Label>
                    <Select
                      value={form.quantization ?? "none"}
                      onValueChange={(value) =>
                        update("quantization", value === "none" ? null : (value as ServerConfig["quantization"]))
                      }
                    >
                      <SelectTrigger aria-label="Model quantization">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {QUANTIZATION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-3 border-t pt-3">
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                    <Switch
                      checked={form.trust_remote_code}
                      onCheckedChange={(value) => update("trust_remote_code", value)}
                      disabled={locked}
                    />
                    Trust remote code
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                    <Switch
                      checked={form.enforce_eager}
                      onCheckedChange={(value) => update("enforce_eager", value)}
                      disabled={locked}
                    />
                    Enforce eager
                  </label>
                </div>

                <div className="border-t pt-3">
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((value) => !value)}
                    className="flex w-full items-center justify-between text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Advanced options
                    <ChevronDown
                      className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
                    />
                  </button>
                  {advancedOpen ? (
                    <div className="mt-3 grid animate-slide-up gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="served-name">Served model name</Label>
                        <Input
                          id="served-name"
                          value={form.served_model_name ?? ""}
                          onChange={(event) =>
                            update("served_model_name", event.target.value || null)
                          }
                          placeholder={form.model.split("/").pop()}
                          className="font-mono text-xs"
                        />
                        <p className="text-[10px] text-muted-foreground">
                          The id exposed by /v1/models. Defaults to the model basename.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="max-num-seqs">Max concurrent sequences</Label>
                        <Input
                          id="max-num-seqs"
                          type="number"
                          min={1}
                          max={4096}
                          value={form.max_num_seqs ?? ""}
                          onChange={(event) =>
                            update(
                              "max_num_seqs",
                              event.target.value ? Number(event.target.value) : null,
                            )
                          }
                          placeholder="vLLM default"
                          className="font-mono text-xs"
                        />
                        <p className="text-[10px] text-muted-foreground">
                          Caps batching; lower it on memory-constrained GPUs.
                        </p>
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="extra-args">Extra vLLM flags</Label>
                        <Textarea
                          id="extra-args"
                          value={extraArgsText}
                          onChange={(event) => setExtraArgsText(event.target.value)}
                          placeholder="--enable-prefix-caching --max-num-batched-tokens 8192"
                          className="min-h-[56px] font-mono text-[11px]"
                          spellCheck={false}
                        />
                        <p className="text-[10px] text-muted-foreground">
                          Appended to the launch command. Managed flags above are rejected. Values
                          are executed as argv, never through a shell.
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>

                {Object.keys(validation.errors).length > 0 && !locked ? (
                  <Alert variant="error" title="Check the configuration">
                    {Object.entries(validation.errors).map(([field, message]) => (
                      <p key={field}>
                        <span className="font-mono text-[10px]">{field}</span>: {message}
                      </p>
                    ))}
                  </Alert>
                ) : null}

                {!locked ? (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                    <Button
                      variant="gradient"
                      size="sm"
                      onClick={() => startMutation.mutate()}
                      disabled={startDisabled}
                    >
                      {startMutation.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      Start engine
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => saveMutation.mutate()}
                      disabled={!dirty || anyPending || !validation.ok}
                    >
                      <Save className="size-3.5" />
                      Save configuration
                    </Button>
                    {!validation.ok ? (
                      <span className="text-[10px] text-muted-foreground">
                        Resolve validation errors to launch.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </fieldset>
          )}
        </Card>

        <div className="space-y-3">
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <HardDrive className="size-3.5 text-muted-foreground" />
              <h2 className="text-xs font-semibold">Hardware & runtime</h2>
            </div>
            {systemQuery.isLoading ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : systemQuery.data ? (
              <div className="mt-3 space-y-3">
                {systemQuery.data.gpus.length > 0 ? (
                  systemQuery.data.gpus.map((gpuInfo) => (
                    <div key={gpuInfo.index} className="rounded-lg border bg-muted/20 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[10px] font-medium">{gpuInfo.name}</span>
                        <Gauge className="size-3 text-muted-foreground" />
                      </div>
                      <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                        <span>
                          {Math.round(gpuInfo.memory_used_mb ?? 0)} /{" "}
                          {Math.round(gpuInfo.memory_total_mb ?? 0)} MB
                        </span>
                        <span>{gpuInfo.utilization_percent ?? 0}% util</span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width: `${Math.min(
                              100,
                              ((gpuInfo.memory_used_mb ?? 0) /
                                Math.max(1, gpuInfo.memory_total_mb ?? 1)) *
                                100,
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-dashed p-2.5 text-[10px] leading-relaxed text-muted-foreground">
                    No NVIDIA GPU detected by nvidia-smi. vLLM needs a CUDA GPU unless the backend is
                    configured with the mock engine.
                  </p>
                )}
                <div className="space-y-1.5 border-t pt-2">
                  <InfoLine label="vLLM" value={systemQuery.data.vllm_version ?? "not in backend env"} />
                  <InfoLine label="Python" value={systemQuery.data.python_version} />
                  <InfoLine label="Launcher" value={systemQuery.data.environment_vars.launcher} />
                  <InfoLine label="Engine" value={systemQuery.data.environment_vars.engine_url} />
                  <InfoLine label="Data dir" value={systemQuery.data.data_dir} />
                </div>
                {systemQuery.data.mock_mode ? (
                  <Alert variant="warning" title="Mock engine mode">
                    vLLM responses are simulated. Set WORKBENCH_VLLM_MOCK=0 and install vLLM to run
                    a real model.
                  </Alert>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-[10px] text-muted-foreground">Runtime information unavailable.</p>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Box className="size-3.5 text-muted-foreground" />
              <h2 className="text-xs font-semibold">Model presets</h2>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Rough fits for consumer GPUs. Adjust for your card.
            </p>
            <div className="mt-3 space-y-1">
              {MODEL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={locked || !form}
                  onClick={() => {
                    if (!form) return;
                    setForm({
                      ...form,
                      model: preset.id,
                      max_model_len: preset.maxModelLen,
                      gpu_memory_utilization: preset.gpuMemory,
                      quantization: preset.quantization ?? null,
                    });
                    toast.success("Preset loaded", { description: preset.id });
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[10px]">{preset.label}</span>
                    <span className="block truncate text-[9px] text-muted-foreground">
                      {preset.note}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                    {preset.quantization ?? preset.maxModelLen}
                  </span>
                </button>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Terminal className="size-3.5 text-muted-foreground" />
              <h2 className="text-xs font-semibold">OpenAI-compatible API</h2>
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[10px]">{API_BASE}/v1</code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy API base URL"
                    onClick={() =>
                      void copyText(`${API_BASE}/v1`).then(() => toast.success("Endpoint copied"))
                    }
                  >
                    <Copy className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy endpoint</TooltipContent>
              </Tooltip>
            </div>
            <div className="relative mt-2">
              <pre className="max-h-40 overflow-auto rounded-md border bg-[#080a0f] p-2.5 font-mono text-[9px] leading-relaxed text-[#9aa7bd]">
                {curlSnippet}
              </pre>
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1 text-muted-foreground"
                aria-label="Copy curl example"
                onClick={() => void copyText(curlSnippet).then(() => toast.success("curl copied"))}
              >
                <Copy className="size-3" />
              </Button>
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
              Point any OpenAI SDK at this base URL. If WORKBENCH_API_KEY is set on the backend,
              send it as a Bearer token.
            </p>
          </Card>
        </div>
      </div>

      <div className="mt-4">
        <LogConsole state={state} />
      </div>

      {form ? (
        <ModelPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={(model) => update("model", model)}
        />
      ) : null}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-[9px] text-foreground/80" title={value}>
        {value}
      </span>
    </div>
  );
}
