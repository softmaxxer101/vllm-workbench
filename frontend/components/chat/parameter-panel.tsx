"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/input";
import { DEFAULT_PARAMS } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { SamplingParams } from "@/lib/types";

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px] font-normal text-muted-foreground">{label}</Label>
        <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground/90">
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        aria-label={label}
      />
      {hint ? <p className="text-[10px] leading-snug text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function ParameterPanel({
  params,
  onParamsChange,
  systemPrompt,
  onSystemPromptChange,
  disabled,
  className,
  showSystemPrompt = true,
}: {
  params: SamplingParams;
  onParamsChange: (patch: Partial<SamplingParams>) => void;
  systemPrompt?: string;
  onSystemPromptChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  showSystemPrompt?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className={cn("space-y-5", disabled && "pointer-events-none opacity-60", className)}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold">Sampling</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Applied to the next generation</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reset sampling parameters"
          onClick={() => onParamsChange(DEFAULT_PARAMS)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>

      <SliderField
        label="Temperature"
        value={params.temperature}
        min={0}
        max={2}
        step={0.01}
        onChange={(value) => onParamsChange({ temperature: value })}
        format={(value) => value.toFixed(2)}
      />
      <SliderField
        label="Top-p"
        value={params.top_p}
        min={0.01}
        max={1}
        step={0.01}
        onChange={(value) => onParamsChange({ top_p: value })}
        format={(value) => value.toFixed(2)}
      />
      <SliderField
        label="Top-k"
        value={params.top_k}
        min={-1}
        max={200}
        step={1}
        onChange={(value) => onParamsChange({ top_k: value })}
        format={(value) => (value === -1 ? "off" : String(value))}
      />

      <div className="space-y-1.5">
        <Label htmlFor="max-tokens" className="text-[11px] font-normal text-muted-foreground">
          Max tokens
        </Label>
        <input
          id="max-tokens"
          type="number"
          min={1}
          max={32768}
          value={params.max_tokens}
          onChange={(event) =>
            onParamsChange({
              max_tokens: Math.max(1, Math.min(32768, Number(event.target.value) || 1)),
            })
          }
          className="h-8 w-full rounded-lg border border-input bg-background/50 px-2.5 font-mono text-xs tabular-nums focus:border-ring/70 focus:outline-none focus:ring-2 focus:ring-ring/25"
        />
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((value) => !value)}
        className="flex w-full items-center justify-between border-t pt-3 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Advanced penalties
        <ChevronDown
          className={cn("size-3.5 transition-transform", advanced && "rotate-180")}
        />
      </button>

      {advanced ? (
        <div className="animate-slide-up space-y-4">
          <SliderField
            label="Repetition penalty"
            value={params.repetition_penalty}
            min={0.8}
            max={1.6}
            step={0.01}
            onChange={(value) => onParamsChange({ repetition_penalty: value })}
            format={(value) => value.toFixed(2)}
          />
          <SliderField
            label="Presence penalty"
            value={params.presence_penalty}
            min={-2}
            max={2}
            step={0.1}
            onChange={(value) => onParamsChange({ presence_penalty: value })}
            format={(value) => value.toFixed(1)}
          />
          <SliderField
            label="Frequency penalty"
            value={params.frequency_penalty}
            min={-2}
            max={2}
            step={0.1}
            onChange={(value) => onParamsChange({ frequency_penalty: value })}
            format={(value) => value.toFixed(1)}
          />
        </div>
      ) : null}

      {showSystemPrompt && onSystemPromptChange ? (
        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="system-prompt" className="text-[11px] font-normal text-muted-foreground">
              System prompt
            </Label>
            <span className="font-mono text-[9px] text-muted-foreground/60">
              {systemPrompt?.length ?? 0} chars
            </span>
          </div>
          <Textarea
            id="system-prompt"
            value={systemPrompt ?? ""}
            onChange={(event) => onSystemPromptChange(event.target.value)}
            placeholder="Set the model's behavior…"
            className="min-h-[88px] text-xs leading-relaxed"
          />
        </div>
      ) : null}
    </div>
  );
}
