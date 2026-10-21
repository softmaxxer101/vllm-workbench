"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Download,
  Eraser,
  FileJson,
  FileText,
  Loader2,
  MessageSquarePlus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChatComposer, type ChatComposerHandle } from "@/components/chat/chat-composer";
import { ChatEmpty } from "@/components/chat/chat-empty";
import { ChatMessage } from "@/components/chat/chat-message";
import { ParameterPanel } from "@/components/chat/parameter-panel";
import { useServerStatus } from "@/hooks/use-server";
import { useModKey } from "@/hooks/use-mod-key";
import { ApiError, streamChat } from "@/lib/api";
import {
  useActiveConversation,
  useChatStore,
  type Conversation,
} from "@/lib/store";
import type { ChatMetricMessage, ChatRequestPayload, SamplingParams } from "@/lib/types";
import { downloadFile, estimateMessagesTokens, relativeTime } from "@/lib/utils";

function uid(prefix = "msg"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

export default function PlaygroundPage() {
  const hydrated = useChatStore((state) => state.hydrated);
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const conversation = useActiveConversation();
  const comparePrompt = useChatStore((state) => state.compare.prompt);

  const createConversation = useChatStore((state) => state.createConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const setParams = useChatStore((state) => state.setParams);
  const setSystemPrompt = useChatStore((state) => state.setSystemPrompt);
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const appendContent = useChatStore((state) => state.appendContent);
  const removeMessagesFrom = useChatStore((state) => state.removeMessagesFrom);
  const clearConversation = useChatStore((state) => state.clearConversation);
  const addPromptHistory = useChatStore((state) => state.addPromptHistory);

  const { data: server, isError: serverError } = useServerStatus();
  const queryClient = useQueryClient();
  const modKey = useModKey();

  const [draft, setDraft] = useState("");
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [streaming, setStreaming] = useState<{ conversationId: string; messageId: string } | null>(
    null,
  );
  const [paramsOpen, setParamsOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const abortRef = useRef<AbortController | null>(null);

  const engineReady = server?.state === "running";
  const engineStarting = server?.state === "starting" || server?.state === "stopping";
  const modelName = server?.api_model_name ?? server?.model ?? "No model";

  useEffect(() => {
    if (!hydrated) return;
    if (useChatStore.getState().conversations.length === 0) {
      createConversation();
    }
  }, [hydrated, createConversation]);

  useEffect(() => {
    const focus = () => composerRef.current?.focus();
    window.addEventListener("workbench:focus-composer", focus);
    return () => window.removeEventListener("workbench:focus-composer", focus);
  }, []);

  useEffect(() => {
    if (!streaming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        abortRef.current?.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [streaming]);

  useEffect(() => {
    if (!conversation) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        abortRef.current?.abort();
        clearConversation(conversation.id);
        setDraft("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversation, clearConversation]);

  useEffect(() => {
    if (!atBottom || !conversation?.messages.length) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversation?.messages, streaming, atBottom]);

  useEffect(() => {
    setAtBottom(true);
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeId]);

  async function generate(
    target: Conversation,
    history: ChatMetricMessage[],
    params: SamplingParams,
    systemPrompt: string,
  ) {
    const assistantId = uid("assistant");
    const assistant: ChatMetricMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      metrics: null,
    };
    addMessage(target.id, assistant);
    setStreaming({ conversationId: target.id, messageId: assistantId });
    setAtBottom(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const payload: ChatRequestPayload = {
      messages: [
        ...(systemPrompt.trim()
          ? [{ role: "system" as const, content: systemPrompt.trim() }]
          : []),
        ...history
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
      ],
      ...params,
      stream: streamEnabled,
      source: "playground",
    };

    let sawError: string | null = null;

    try {
      for await (const event of streamChat(payload, controller.signal)) {
        if (event.type === "delta") {
          appendContent(target.id, assistantId, event.text);
        } else if (event.type === "metrics") {
          updateMessage(target.id, assistantId, { metrics: event.metrics });
        } else if (event.type === "error") {
          sawError = event.message;
          updateMessage(target.id, assistantId, {
            error: event.message,
            hint: event.hint,
          });
          toast.error("Generation failed", { description: event.hint ?? event.message });
        } else if (event.type === "aborted") {
          updateMessage(target.id, assistantId, { stopped: true });
        } else if (event.type === "done") {
          break;
        }
      }

      const latest = useChatStore
        .getState()
        .conversations.find((item) => item.id === target.id)
        ?.messages.find((item) => item.id === assistantId);
      if (latest && !latest.content && !latest.error && !latest.stopped && !sawError) {
        updateMessage(target.id, assistantId, {
          error: "The model returned an empty response.",
          hint: "Try raising max tokens or adjusting the prompt.",
        });
      }
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unexpected streaming error.";
      const hint = error instanceof ApiError ? error.hint : null;
      updateMessage(target.id, assistantId, { error: message, hint });
      toast.error("Generation failed", { description: hint ?? message });
    } finally {
      setStreaming(null);
      abortRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    }
  }

  function handleSend() {
    if (!conversation || streaming) return;
    const prompt = draft.trim();
    if (!prompt) return;
    if (!engineReady) {
      toast.error("The engine is not running", {
        description: "Open the Server page and start vLLM first.",
      });
      return;
    }

    const userMessage: ChatMetricMessage = {
      id: uid("user"),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    addMessage(conversation.id, userMessage);
    addPromptHistory(prompt);
    setDraft("");
    const history = [...conversation.messages, userMessage];
    void generate(conversation, history, conversation.params, conversation.systemPrompt);
  }

  function handleRegenerate() {
    if (streaming) return;
    const current = useChatStore
      .getState()
      .conversations.find((item) => item.id === activeId);
    if (!current) return;
    const lastAssistant = [...current.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!lastAssistant) return;
    const index = current.messages.findIndex((message) => message.id === lastAssistant.id);
    const history = current.messages.slice(0, index);
    removeMessagesFrom(current.id, lastAssistant.id);
    void generate(current, history, current.params, current.systemPrompt);
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleClear() {
    if (!conversation) return;
    abortRef.current?.abort();
    clearConversation(conversation.id);
    setDraft("");
    toast.success("Conversation cleared");
  }

  function handleNewChat() {
    abortRef.current?.abort();
    createConversation();
    setDraft("");
    setTimeout(() => composerRef.current?.focus(), 50);
  }

  function handleDeleteCurrent() {
    if (!conversation) return;
    abortRef.current?.abort();
    deleteConversation(conversation.id);
    toast.success("Chat deleted");
  }

  function handleExport(format: "markdown" | "json") {
    if (!conversation) return;
    const safeTitle = conversation.title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 48) || "chat";
    if (format === "json") {
      downloadFile(
        `${safeTitle}.json`,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            model: modelName,
            systemPrompt: conversation.systemPrompt,
            params: conversation.params,
            messages: conversation.messages.map((message) => ({
              role: message.role,
              content: message.content,
              metrics: message.metrics,
            })),
          },
          null,
          2,
        ),
        "application/json",
      );
    } else {
      const lines = [
        `# ${conversation.title}`,
        "",
        `- Model: \`${modelName}\``,
        `- Exported: ${new Date().toISOString()}`,
        `- Sampling: temperature ${conversation.params.temperature}, top_p ${conversation.params.top_p}, max_tokens ${conversation.params.max_tokens}`,
        "",
      ];
      if (conversation.systemPrompt) {
        lines.push("## System", "", conversation.systemPrompt, "");
      }
      for (const message of conversation.messages) {
        lines.push(`## ${message.role === "user" ? "User" : "Assistant"}`, "", message.content, "");
        if (message.metrics) {
          lines.push(
            `> ${message.metrics.completion_tokens} tokens · ${message.metrics.tokens_per_second?.toFixed(1) ?? "—"} tok/s · TTFT ${Math.round(message.metrics.ttft_ms ?? 0)} ms`,
            "",
          );
        }
      }
      downloadFile(`${safeTitle}.md`, lines.join("\n"), "text/markdown");
    }
    toast.success(`Exported as ${format === "json" ? "JSON" : "Markdown"}`);
  }

  const tokenEstimate = conversation
    ? estimateMessagesTokens([
        ...(conversation.systemPrompt
          ? [{ role: "system", content: conversation.systemPrompt }]
          : []),
        ...conversation.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ])
    : 0;

  if (!hydrated || !conversation) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-72" />
        <Skeleton className="h-[560px] w-full" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        index="01"
        eyebrow="Playground"
        title={
          <>
            A direct line to the <em className="text-primary">model</em>
          </>
        }
        description="Stream tokens straight from vLLM, tune sampling live, and inspect what each generation actually cost."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={handleNewChat}>
              <MessageSquarePlus className="size-3.5" />
              New chat
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={conversation.messages.length === 0}>
                  <Download className="size-3.5" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => handleExport("markdown")}>
                  <FileText />
                  Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleExport("json")}>
                  <FileJson />
                  JSON
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {comparePrompt ? (
          <p className="text-[10px] text-muted-foreground">
            Compare prompt available ·{" "}
            <button
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => setDraft(comparePrompt)}
            >
              load into chat
            </button>
          </p>
        ) : null}
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
        <Card className="flex h-[calc(100dvh-22rem)] min-h-[460px] flex-col overflow-hidden sm:h-[calc(100dvh-17rem)] sm:min-h-[520px] md:h-[calc(100dvh-14rem)] lg:h-[calc(100dvh-12.5rem)]">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
                >
                  <span className="truncate text-xs font-medium">
                    {conversation.title || "New chat"}
                  </span>
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel>Conversations</DropdownMenuLabel>
                <div className="max-h-64 overflow-y-auto">
                  {conversations.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => selectConversation(item.id)}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="truncate">{item.title || "Untitled chat"}</span>
                        {item.id === activeId ? (
                          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                        ) : null}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground/60">
                        {item.messages.length} messages · {relativeTime(item.updatedAt)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleNewChat}>
                  <MessageSquarePlus />
                  New chat
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={handleDeleteCurrent}>
                  <Trash2 />
                  Delete this chat
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="hidden items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 font-mono text-[9px] text-muted-foreground sm:flex">
              <Sparkles className="size-2.5 text-primary" />
              {modelName}
            </span>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="stream-toggle" className="hidden text-[10px] text-muted-foreground sm:block">
                  Stream
                </Label>
                <Switch
                  id="stream-toggle"
                  checked={streamEnabled}
                  onCheckedChange={setStreamEnabled}
                  aria-label="Stream responses"
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleClear}
                    disabled={conversation.messages.length === 0 && !draft}
                    aria-label="Clear conversation"
                  >
                    <Eraser className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear conversation · {modKey}+Shift+K</TooltipContent>
              </Tooltip>
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden"
                onClick={() => setParamsOpen(true)}
              >
                <SlidersHorizontal className="size-3.5" />
                Parameters
              </Button>
            </div>
          </div>

          <div
            ref={scrollRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
              setAtBottom(distance < 80);
            }}
            className="relative flex-1 overflow-y-auto scroll-smooth"
          >
            {conversation.messages.length === 0 ? (
              <ChatEmpty
                engineReady={Boolean(engineReady)}
                modelName={modelName}
                onSelect={(prompt) => {
                  setDraft(prompt);
                  setTimeout(() => composerRef.current?.focus(), 30);
                }}
              />
            ) : (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-3 py-5 sm:px-5">
                {conversation.messages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    streaming={
                      streaming?.messageId === message.id &&
                      streaming.conversationId === conversation.id
                    }
                    canRegenerate={
                      message.role === "assistant" &&
                      index === conversation.messages.length - 1 &&
                      !streaming &&
                      engineReady
                    }
                    onRegenerate={handleRegenerate}
                  />
                ))}
              </div>
            )}
            {!atBottom && conversation.messages.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setAtBottom(true);
                  const element = scrollRef.current;
                  if (element) element.scrollTop = element.scrollHeight;
                }}
                className="sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-popover px-2.5 py-1 text-[10px] text-muted-foreground shadow-lg hover:text-foreground"
              >
                Jump to latest
              </button>
            ) : null}
          </div>

          <div className="shrink-0 space-y-2 border-t bg-card/60 p-3">
            {serverError ? (
              <Alert variant="error" title="Backend unreachable">
                The UI cannot reach the FastAPI backend. Verify it is running on port 8000 and reload.
              </Alert>
            ) : !engineReady ? (
              <Alert
                variant={server?.state === "error" ? "error" : "info"}
                title={
                  engineStarting
                    ? "Model is warming up"
                    : server?.state === "error"
                      ? "Engine failed to start"
                      : "Engine offline"
                }
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/server">{engineStarting ? "View progress" : "Open server"}</Link>
                  </Button>
                }
              >
                {engineStarting ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" />
                    Loading weights. The composer unlocks as soon as vLLM is healthy.
                  </span>
                ) : (
                  server?.hint ?? "Start the vLLM server before sending a prompt."
                )}
              </Alert>
            ) : null}

            <ChatComposer
              ref={composerRef}
              value={draft}
              onChange={setDraft}
              onSend={handleSend}
              onStop={handleStop}
              streaming={Boolean(streaming)}
              disabled={!engineReady}
              placeholder={
                engineReady
                  ? "Ask your model anything…"
                  : "Start the engine to enable the composer…"
              }
            />
            <div className="flex items-center justify-between px-1 text-[9px] text-muted-foreground/60">
              <span className="inline-flex items-center gap-1">
                <span className="size-1 rounded-full bg-signal" />
                {server?.mock ? "Demo engine (simulated tokens)" : "Local inference · nothing leaves this machine"}
              </span>
              <span className="font-mono tabular-nums">~{tokenEstimate} context tokens</span>
            </div>
          </div>
        </Card>

        <div className="hidden lg:block">
          <Card className="sticky top-7 max-h-[calc(100dvh-9.5rem)] overflow-y-auto p-4">
            <ParameterPanel
              params={conversation.params}
              onParamsChange={(patch) => setParams(conversation.id, patch)}
              systemPrompt={conversation.systemPrompt}
              onSystemPromptChange={(value) => setSystemPrompt(conversation.id, value)}
            />
          </Card>
        </div>
      </div>

      <Dialog open={paramsOpen} onOpenChange={setParamsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sampling & system prompt</DialogTitle>
            <DialogDescription>
              Changes apply immediately to the next message.
            </DialogDescription>
          </DialogHeader>
          <ParameterPanel
            params={conversation.params}
            onParamsChange={(patch) => setParams(conversation.id, patch)}
            systemPrompt={conversation.systemPrompt}
            onSystemPromptChange={(value) => setSystemPrompt(conversation.id, value)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
