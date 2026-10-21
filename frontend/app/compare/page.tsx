"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ChevronDown,
  Columns2,
  Copy,
  Loader2,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/chat/markdown";
import { ParameterPanel } from "@/components/chat/parameter-panel";
import { GenerationStats } from "@/components/chat/generation-stats";
import { useServerStatus } from "@/hooks/use-server";
import { useModKey } from "@/hooks/use-mod-key";
import { useChatStore } from "@/lib/store";
import { streamChat } from "@/lib/api";
import type { ChatRequestPayload, ComparePaneState } from "@/lib/types";
import { cn, copyText, estimateTokens } from "@/lib/utils";

type Side = "left" | "right";

const SIDE_META: Record<
  Side,
  { label: string; tone: string; dot: string; accent: string; ring: string }
> = {
  left: {
    label: "Config A",
    tone: "text-primary",
    dot: "bg-primary",
    accent: "border-primary/25 bg-primary/10",
    ring: "focus-within:border-primary/40",
  },
  right: {
    label: "Config B",
    tone: "text-signal",
    dot: "bg-signal",
    accent: "border-signal/25 bg-signal/10",
    ring: "focus-within:border-signal/40",
  },
};

export default function ComparePage() {
  const hydrated = useChatStore((state) => state.hydrated);
  const compare = useChatStore((state) => state.compare);
  const setPrompt = useChatStore((state) => state.setComparePrompt);
  const setSystemPrompt = useChatStore((state) => state.setCompareSystemPrompt);
  const patchPane = useChatStore((state) => state.patchComparePane);
  const patchParams = useChatStore((state) => state.patchCompareParams);
  const resetCompare = useChatStore((state) => state.resetCompare);

  const { data: server } = useServerStatus();
  const queryClient = useQueryClient();
  const modKey = useModKey();
  const engineReady = server?.state === "running";

  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<Side | null>(null);
  const [systemOpen, setSystemOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hydrated) return;
    (["left", "right"] as Side[]).forEach((side) => {
      if (useChatStore.getState().compare[side].status === "streaming") {
        patchPane(side, { status: "stopped" });
      }
    });
  }, [hydrated, patchPane]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener("workbench:focus-composer", focus);
    return () => {
      window.removeEventListener("workbench:focus-composer", focus);
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        controllerRef.current?.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  async function runPane(side: Side, controller: AbortController) {
    const state = useChatStore.getState().compare;
    const pane = state[side];
    patchPane(side, {
      status: "streaming",
      output: "",
      metrics: null,
      error: null,
      hint: null,
    });

    const payload: ChatRequestPayload = {
      messages: [
        ...(state.systemPrompt.trim()
          ? [{ role: "system" as const, content: state.systemPrompt.trim() }]
          : []),
        { role: "user", content: state.prompt.trim() },
      ],
      ...pane.params,
      stream: true,
      source: "compare",
    };

    let sawError = false;
    try {
      for await (const event of streamChat(payload, controller.signal)) {
        if (event.type === "delta") {
          const current = useChatStore.getState().compare[side];
          patchPane(side, { output: current.output + event.text });
        } else if (event.type === "metrics") {
          patchPane(side, { metrics: event.metrics });
        } else if (event.type === "error") {
          sawError = true;
          patchPane(side, {
            error: event.message,
            hint: event.hint,
            status: "error",
          });
        } else if (event.type === "aborted") {
          patchPane(side, { status: "stopped" });
        } else if (event.type === "done") {
          break;
        }
      }
      const finalPane = useChatStore.getState().compare[side];
      if (!sawError && finalPane.status === "streaming") {
        patchPane(side, {
          status: finalPane.output ? "done" : "error",
          error: finalPane.output ? null : "The model returned an empty response.",
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError" || controller.signal.aborted) {
        patchPane(side, { status: "stopped" });
      } else {
        patchPane(side, {
          status: "error",
          error: error instanceof Error ? error.message : "Comparison request failed.",
          hint: "Check the server status and try again.",
        });
        toast.error(`${SIDE_META[side].label} failed`, {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
  }

  async function handleRun() {
    if (!compare.prompt.trim()) {
      toast.error("Add a prompt first");
      textareaRef.current?.focus();
      return;
    }
    if (!engineReady) {
      toast.error("The engine is not running", {
        description: "Start vLLM on the Server page first.",
      });
      return;
    }
    if (running) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    await Promise.allSettled([runPane("left", controller), runPane("right", controller)]);
    setRunning(false);
    controllerRef.current = null;
    void queryClient.invalidateQueries({ queryKey: ["metrics"] });
  }

  function handleStop() {
    controllerRef.current?.abort();
  }

  function handleReset() {
    controllerRef.current?.abort();
    resetCompare();
    setRunning(false);
    toast.success("Comparison reset");
  }

  function editParams(side: Side): ComparePaneState {
    return compare[side];
  }

  const systemTokens = estimateTokens(compare.systemPrompt);

  return (
    <div>
      <PageHeader
        index="02"
        eyebrow="Side by side"
        title={
          <>
            Two settings. <em className="text-primary">One prompt.</em>
          </>
        }
        description="Send one prompt to two independent parameter sets. Both streams start together so differences are easy to see."
        actions={
          <>
            {running ? (
              <Button variant="outline" size="sm" onClick={handleStop}>
                <Square className="size-3 fill-current" />
                Stop both
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={handleReset} disabled={running}>
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
            <Button variant="gradient" size="sm" onClick={handleRun} disabled={!engineReady || running}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {running ? "Generating…" : "Run both"}
            </Button>
          </>
        }
      />

      {!engineReady ? (
        <Alert
          variant="info"
          title="Start the engine to compare"
          className="mb-4"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/server">Server</Link>
            </Button>
          }
        >
          Both panes will stream from the same managed vLLM instance.
        </Alert>
      ) : null}

      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="label-caps">Shared prompt</span>
          <span className="font-mono text-[9px] text-muted-foreground/60">
            {compare.prompt.length} chars · ~{estimateTokens(compare.prompt)} tokens
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[10px]"
              onClick={() => setSystemOpen((value) => !value)}
            >
              <ChevronDown className={cn("size-3 transition-transform", systemOpen && "rotate-180")} />
              System prompt
              {compare.systemPrompt ? (
                <span className="rounded bg-primary/15 px-1 font-mono text-[9px] text-primary">
                  {systemTokens}
                </span>
              ) : null}
            </Button>
          </div>
        </div>
        {systemOpen ? (
          <div className="border-b bg-muted/20 p-3">
            <Textarea
              value={compare.systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Optional system instructions sent to both models…"
              className="min-h-[64px] bg-card text-xs"
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-end">
          <Textarea
            ref={textareaRef}
            value={compare.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void handleRun();
              }
            }}
            placeholder="Ask both configurations the same thing…"
            className="min-h-[70px] flex-1 bg-transparent text-sm sm:min-h-[52px]"
          />
          <div className="flex items-center gap-2">
            <span className="kbd hidden sm:inline-flex">{modKey}↵</span>
            <Button
              variant="gradient"
              className="w-full sm:w-auto"
              onClick={handleRun}
              disabled={!engineReady || running || !compare.prompt.trim()}
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              Run both
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {(["left", "right"] as Side[]).map((side) => {
          const pane = compare[side];
          const meta = SIDE_META[side];
          const scrollRef = side === "left" ? leftScrollRef : rightScrollRef;
          const streaming = pane.status === "streaming";

          return (
            <Card
              key={side}
              className={cn("flex min-h-[380px] flex-col overflow-hidden", meta.ring)}
            >
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", meta.accent, meta.tone)}>
                  <span className={cn("size-1.5 rounded-full", meta.dot)} />
                  {meta.label}
                </span>
                <span className="font-mono text-[9px] text-muted-foreground">
                  T {pane.params.temperature.toFixed(2)} · p {pane.params.top_p.toFixed(2)} · k{" "}
                  {pane.params.top_k === -1 ? "off" : pane.params.top_k} · {pane.params.max_tokens} tok
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {streaming ? (
                    <span className="flex items-center gap-1 text-[9px] text-primary">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      streaming
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditing(side)}
                        aria-label={`Edit ${meta.label} parameters`}
                        disabled={running}
                      >
                        <SlidersHorizontal className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit parameters</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!pane.output}
                        aria-label="Copy output"
                        onClick={() =>
                          void copyText(pane.output).then(() => toast.success("Output copied"))
                        }
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <div
                ref={scrollRef}
                className="h-[320px] flex-1 overflow-y-auto px-4 py-4 sm:h-[380px]"
              >
                {pane.error ? (
                  <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <div>
                      <p className="font-medium">Generation failed</p>
                      <p className="mt-1 text-muted-foreground">{pane.error}</p>
                      {pane.hint ? (
                        <p className="mt-1 text-[10px] text-muted-foreground/70">{pane.hint}</p>
                      ) : null}
                    </div>
                  </div>
                ) : pane.output ? (
                  <div className={streaming ? "streaming-caret" : undefined}>
                    <Markdown content={pane.output} />
                  </div>
                ) : streaming ? (
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                    Waiting for first token…
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <div className={cn("flex size-9 items-center justify-center rounded-xl border", meta.accent, meta.tone)}>
                      <Columns2 className="size-4" />
                    </div>
                    <p className="text-xs font-medium">{meta.label} is ready</p>
                    <p className="max-w-[220px] text-[10px] leading-relaxed text-muted-foreground">
                      Same prompt, {side === "left" ? "cooler" : "hotter"} defaults. Adjust the
                      parameters, then run both.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 px-3 py-2">
                {pane.metrics ? (
                  <GenerationStats metrics={pane.metrics} />
                ) : (
                  <span className="font-mono text-[9px] text-muted-foreground/60">
                    {pane.output ? `~${estimateTokens(pane.output)} output tokens` : "No output yet"}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setEditing(side)}
                  disabled={running}
                >
                  Tune
                  <ArrowRight className="size-3" />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <p className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/60">
        <Columns2 className="size-3" />
        Requests are sent concurrently; streaming timings are measured independently per pane.
      </p>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? SIDE_META[editing].label : ""} parameters</DialogTitle>
            <DialogDescription>
              Both panes share the prompt and system message. Only sampling differs.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <ParameterPanel
              params={editParams(editing).params}
              onParamsChange={(patch) => patchParams(editing, patch)}
              showSystemPrompt={false}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
