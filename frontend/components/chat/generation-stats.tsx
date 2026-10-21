"use client";

import { Clock3, Gauge, Timer, Zap } from "lucide-react";

import { formatMs, formatNumber } from "@/lib/utils";
import type { GenerationMetrics } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function GenerationStats({ metrics }: { metrics: GenerationMetrics }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground/80">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1">
            <Zap className="size-2.5 text-signal" />
            {metrics.tokens_per_second ? `${formatNumber(metrics.tokens_per_second, 1)} tok/s` : "—"}
          </span>
        </TooltipTrigger>
        <TooltipContent>Decode throughput measured by the workbench proxy</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1">
            <Timer className="size-2.5" />
            TTFT {formatMs(metrics.ttft_ms)}
          </span>
        </TooltipTrigger>
        <TooltipContent>Time to first streamed token</TooltipContent>
      </Tooltip>
      <span className="inline-flex items-center gap-1">
        <Gauge className="size-2.5" />
        {formatNumber(metrics.completion_tokens)} tokens
      </span>
      <span className="inline-flex items-center gap-1">
        <Clock3 className="size-2.5" />
        {formatMs(metrics.latency_ms)}
      </span>
      {metrics.finish_reason ? (
        <span className="rounded border border-border/60 px-1 py-px text-[9px] uppercase tracking-wide">
          {metrics.finish_reason}
        </span>
      ) : null}
    </div>
  );
}
