"use client";

import { ArrowUpRight } from "lucide-react";

import { useModKey } from "@/hooks/use-mod-key";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  {
    title: "Explain PagedAttention",
    prompt:
      "Explain vLLM's PagedAttention like I'm new to inference serving. Use a concrete analogy and keep it under 250 words.",
  },
  {
    title: "Write useful code",
    prompt:
      "Write a production-quality Python async retry decorator with exponential backoff, jitter, and a max elapsed time. Include type hints and a short usage example.",
  },
  {
    title: "Compare decoding",
    prompt:
      "Compare greedy decoding, top-k and nucleus (top-p) sampling. When would you choose each for a local assistant?",
  },
  {
    title: "Polish some writing",
    prompt:
      "Rewrite this release note to be crisp and confident without marketing fluff: 'We have upgraded vLLM to the newest version and it has several improvements and bug fixes.'",
  },
];

export function ChatEmpty({
  onSelect,
  engineReady,
  modelName,
}: {
  onSelect: (prompt: string) => void;
  engineReady: boolean;
  modelName?: string;
}) {
  const modKey = useModKey();

  return (
    <div className="flex h-full items-center px-4 py-8 sm:px-7">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground">
          <span className="relative flex size-1.5">
            <span
              className={cn(
                "absolute inline-flex size-full rounded-full opacity-50",
                engineReady ? "animate-ping bg-signal" : "bg-muted-foreground",
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-1.5 rounded-full",
                engineReady ? "bg-signal" : "bg-muted-foreground",
              )}
            />
          </span>
          {engineReady ? "channel open" : "engine offline"}
          <span className="ml-auto max-w-[52%] truncate text-[8px] tracking-[0.12em] text-muted-foreground/50">
            {modelName ?? "no model loaded"}
          </span>
        </div>

        <h2 className="mt-5 font-display text-[46px] leading-[0.95] tracking-[-0.015em] sm:text-[62px]">
          What should we <em className="text-primary">run?</em>
        </h2>
        <p className="mt-3 max-w-md text-[12px] leading-relaxed text-muted-foreground">
          {engineReady
            ? "Send a prompt to your local model. Every token, gap and millisecond is measured as it streams through the workbench."
            : "Start the vLLM engine on the Server page, then come back to open the channel."}
        </p>

        <div className="mt-7 grid grid-cols-1 border-t border-border/80 sm:grid-cols-2">
          {SUGGESTIONS.map((suggestion, index) => (
            <button
              key={suggestion.title}
              type="button"
              onClick={() => onSelect(suggestion.prompt)}
              className={cn(
                "group flex items-start gap-3 border-b border-border/70 py-3 text-left transition-colors hover:bg-primary/[0.035]",
                index % 2 === 0 ? "sm:pr-6" : "sm:border-l sm:border-border/70 sm:pl-6",
              )}
            >
              <span className="mt-0.5 font-mono text-[9px] tabular-nums text-muted-foreground/45 transition-colors group-hover:text-primary">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground/90 transition-colors group-hover:text-primary">
                  {suggestion.title}
                  <ArrowUpRight className="size-3 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                </span>
                <span className="mt-1 hidden line-clamp-2 text-[10px] leading-relaxed text-muted-foreground/65 sm:block">
                  {suggestion.prompt}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between font-mono text-[8.5px] uppercase tracking-[0.16em] text-muted-foreground/45">
          <span>select a starter, or write below</span>
          <span className="hidden sm:inline">{modKey === "⌘" ? "⌘↵" : "Ctrl+↵"} to run</span>
        </div>
      </div>
    </div>
  );
}
