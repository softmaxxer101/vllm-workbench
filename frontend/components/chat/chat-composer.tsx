"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ArrowUp, History, Square, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatStore } from "@/lib/store";
import { useModKey } from "@/hooks/use-mod-key";
import { cn, estimateTokens, relativeTime } from "@/lib/utils";

export interface ChatComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  helperText?: string;
  minRows?: number;
  extraActions?: React.ReactNode;
}

export const ChatComposer = forwardRef<ChatComposerHandle, ComposerProps>(
  function ChatComposer(
    {
      value,
      onChange,
      onSend,
      onStop,
      streaming = false,
      disabled = false,
      placeholder = "Send a message…",
      helperText,
      minRows = 1,
      extraActions,
    },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const promptHistory = useChatStore((state) => state.promptHistory);
    const clearHistory = useChatStore((state) => state.clearPromptHistory);
    const modKey = useModKey();

    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
    }));

    useEffect(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.style.height = "0px";
      const next = Math.min(Math.max(element.scrollHeight, minRows * 24 + 20), 220);
      element.style.height = `${next}px`;
    }, [value, minRows]);

    return (
      <div className="group relative rounded-[8px] border border-border/80 bg-card/60 transition-all focus-within:border-primary/40 focus-within:bg-card">
        <span className="pointer-events-none absolute inset-y-2 left-0 w-[2px] bg-primary opacity-0 transition-opacity group-focus-within:opacity-100" />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !disabled &&
              !streaming
            ) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          rows={minRows}
          disabled={disabled}
          aria-label="Message"
          className="max-h-[220px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Prompt history"
                    disabled={promptHistory.length === 0}
                  >
                    <History className="size-3.5" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Prompt history</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" side="top" className="w-80 p-2">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="label-caps">Recent prompts</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={clearHistory}
                  aria-label="Clear prompt history"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {promptHistory.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onChange(item.prompt);
                      textareaRef.current?.focus();
                    }}
                    className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <p className="line-clamp-2 text-[11px] leading-snug text-foreground/90">
                      {item.prompt}
                    </p>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">
                      {relativeTime(item.createdAt)}
                    </p>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          {extraActions}

          <span className="ml-auto hidden items-center gap-2 sm:flex">
            {helperText ? (
              <span className="text-[10px] text-muted-foreground/60">{helperText}</span>
            ) : null}
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
              ~{estimateTokens(value)} tok
            </span>
            <span className="kbd hidden md:inline-flex">
              {modKey === "⌘" ? "⌘↵" : "Ctrl+↵"}
            </span>
          </span>

          {streaming ? (
            <Button
              size="icon-sm"
              variant="outline"
              onClick={onStop}
              aria-label="Stop generating"
              className="ml-auto size-8 border-destructive/30 text-destructive hover:bg-destructive/10 sm:ml-0"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="gradient"
              onClick={onSend}
              disabled={disabled || !value.trim()}
              aria-label="Send message"
              className={cn("ml-auto size-8 sm:ml-0")}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    );
  },
);
