"use client";

import { Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText, estimateTokens, relativeTime } from "@/lib/utils";
import type { ChatMetricMessage } from "@/lib/types";
import { GenerationStats } from "./generation-stats";
import { Markdown } from "./markdown";

export function ChatMessage({
  message,
  streaming,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMetricMessage;
  streaming: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const isUser = message.role === "user";
  const isEmptyStreaming = streaming && !message.content && !message.error;

  if (isUser) {
    return (
      <div className="flex animate-slide-up flex-col items-end gap-1.5">
        <div className="max-w-[88%] rounded-[6px] border-r-2 border-primary bg-primary/[0.055] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-foreground/95">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
        <div className="flex items-center gap-2 pr-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55">
          <span className="text-muted-foreground/80">you</span>
          <span>{relativeTime(message.createdAt)}</span>
          <span>·</span>
          <span>~{estimateTokens(message.content)} tokens</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex animate-slide-up gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[4px] border border-border/80 bg-card font-mono text-[8px] tracking-tight text-primary">
        WB
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            model
          </span>
          {message.stopped ? (
            <span className="rounded border border-border px-1.5 py-px text-[9px] uppercase tracking-wider text-muted-foreground">
              stopped
            </span>
          ) : null}
          {streaming ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-primary">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-primary" />
              generating
            </span>
          ) : null}
        </div>

        {message.content ? (
          <div className={streaming ? "streaming-caret" : undefined}>
            <Markdown content={message.content} />
          </div>
        ) : null}

        {isEmptyStreaming ? (
          <div className="flex items-center gap-2 py-1">
            <span className="flex gap-1">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-primary [animation-delay:0ms]" />
              <span className="size-1.5 animate-pulse-soft rounded-full bg-primary [animation-delay:160ms]" />
              <span className="size-1.5 animate-pulse-soft rounded-full bg-primary [animation-delay:320ms]" />
            </span>
            <span className="text-[11px] text-muted-foreground">Waiting for the first token…</span>
          </div>
        ) : null}

        {message.error ? (
          <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-2.5 text-[11px]">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-foreground">Generation failed</p>
              <p className="mt-0.5 leading-relaxed text-muted-foreground">{message.error}</p>
              {message.hint ? (
                <p className="mt-1 leading-relaxed text-muted-foreground/80">{message.hint}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {message.metrics ? <GenerationStats metrics={message.metrics} /> : null}

        {!streaming && (message.content || message.error) ? (
          <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy response"
                  onClick={() => {
                    void copyText(message.content).then(() =>
                      toast.success("Response copied"),
                    );
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
            {canRegenerate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Regenerate response"
                    onClick={onRegenerate}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Regenerate</TooltipContent>
              </Tooltip>
            ) : null}
            <span className="ml-1 font-mono text-[9px] text-muted-foreground/50">
              {relativeTime(message.createdAt)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
