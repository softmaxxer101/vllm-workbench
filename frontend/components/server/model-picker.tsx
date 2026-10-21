"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Download,
  FolderOpen,
  Globe2,
  Loader2,
  Lock,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { formatBytes, formatNumber } from "@/lib/utils";

export function ModelPicker({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: ["hf-search", debounced],
    queryFn: () => api.searchModels(debounced),
    enabled: open && debounced.length >= 2,
    staleTime: 60_000,
    retry: 0,
  });

  const local = useQuery({
    queryKey: ["local-models"],
    queryFn: api.localModels,
    enabled: open,
    staleTime: 30_000,
  });

  const downloads = useQuery({
    queryKey: ["model-downloads"],
    queryFn: api.listDownloads,
    enabled: open,
    refetchInterval: (state) =>
      state.state.data?.some((job) => job.state === "running" || job.state === "queued")
        ? 2000
        : false,
  });

  const download = useMutation({
    mutationFn: (repoId: string) => api.downloadModel(repoId),
    onMutate: (repoId) => setDownloading(repoId),
    onSuccess: (job) => {
      toast.success("Download started", { description: job.repo_id });
      void queryClient.invalidateQueries({ queryKey: ["model-downloads"] });
      setDownloading(null);
    },
    onError: (error) => {
      setDownloading(null);
      toast.error("Download failed", {
        description:
          error instanceof ApiError ? error.hint ?? error.message : "Hugging Face is unreachable.",
      });
    },
  });

  const activeJobs = (downloads.data ?? []).filter(
    (job) => job.state === "running" || job.state === "queued",
  );
  const finishedJobs = (downloads.data ?? []).filter(
    (job) => job.state === "completed" || job.state === "error",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Choose a model
          </DialogTitle>
          <DialogDescription>
            Search Hugging Face or pick a model already cached on the backend. Downloaded models
            are stored locally and can be loaded by path.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Hugging Face — e.g. Qwen2.5 instruct, Llama 3.2…"
            className="h-10 pl-9 pr-9"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="max-h-[46vh] min-h-[260px] overflow-y-auto rounded-lg border">
          {debounced.length >= 2 ? (
            search.isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : search.isError ? (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center p-6 text-center">
                <Globe2 className="size-5 text-muted-foreground/50" />
                <p className="mt-2 text-xs font-medium">Hugging Face search failed</p>
                <p className="mt-1 max-w-sm text-[10px] text-muted-foreground">
                  Check this machine&apos;s internet connection. Offline? You can type a model id or
                  local path directly in the field.
                </p>
              </div>
            ) : (search.data ?? []).length === 0 ? (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center p-6 text-center">
                <Search className="size-5 text-muted-foreground/50" />
                <p className="mt-2 text-xs font-medium">No models found</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Try a shorter query, or type the repository id manually.
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {(search.data ?? []).map((hit) => (
                  <div
                    key={hit.id}
                    className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-mono text-[11px] font-medium">{hit.id}</p>
                        {hit.gated ? (
                          <Badge variant="warning" className="gap-1 text-[9px]">
                            <Lock className="size-2.5" />
                            gated
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] text-muted-foreground">
                        <span>{formatNumber(hit.downloads)} downloads</span>
                        <span>·</span>
                        <span>{formatNumber(hit.likes)} likes</span>
                        {hit.pipeline_tag ? (
                          <>
                            <span>·</span>
                            <span>{hit.pipeline_tag}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[10px]"
                      onClick={() => {
                        onSelect(hit.id);
                        onOpenChange(false);
                      }}
                    >
                      <Check className="size-3" />
                      Use
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Download ${hit.id}`}
                      disabled={download.isPending && downloading === hit.id}
                      onClick={() => download.mutate(hit.id)}
                    >
                      {download.isPending && downloading === hit.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="p-2">
              <p className="label-caps px-2 py-2">
                <FolderOpen className="mr-1 inline size-3" />
                Local & cached models
              </p>
              {local.isLoading ? (
                <div className="space-y-2 p-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (local.data ?? []).length === 0 ? (
                <p className="px-2 py-6 text-center text-[10px] leading-relaxed text-muted-foreground">
                  No local models found yet. Search above to download one, or type a Hugging Face
                  id directly.
                </p>
              ) : (
                (local.data ?? []).map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onSelect(model.id);
                      onOpenChange(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px]">{model.id}</p>
                      <p className="truncate text-[9px] text-muted-foreground">{model.path}</p>
                    </div>
                    <Check className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))
              )}
              <div className="mt-2 border-t px-2 pt-3">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Tip: type a repository id such as{" "}
                  <code className="rounded bg-muted px-1 py-0.5">Qwen/Qwen2.5-1.5B-Instruct</code>{" "}
                  in the model field, or an absolute path on the backend host.
                </p>
              </div>
            </div>
          )}
        </div>

        {activeJobs.length > 0 || finishedJobs.length > 0 ? (
          <div className="space-y-2">
            <p className="label-caps">Downloads</p>
            {activeJobs.map((job) => (
              <div key={job.id} className="rounded-lg border bg-muted/20 p-2.5">
                <div className="flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin text-primary" />
                  <span className="truncate font-mono text-[10px]">{job.repo_id}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                    {formatBytes(job.bytes_downloaded)}
                  </span>
                </div>
                <Progress value={40} className="mt-2 h-1 animate-pulse" />
              </div>
            ))}
            {finishedJobs.slice(0, 3).map((job) => (
              <div key={job.id} className="flex items-center gap-2 rounded-lg border p-2.5">
                <Check className="size-3 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[10px]">{job.repo_id}</p>
                  <p className="truncate text-[9px] text-muted-foreground">
                    {job.state === "completed"
                      ? `${formatBytes(job.bytes_downloaded)} · ${job.path}`
                      : job.error}
                  </p>
                </div>
                {job.state === "completed" && job.path ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px]"
                    onClick={() => {
                      onSelect(job.path!);
                      onOpenChange(false);
                    }}
                  >
                    Use path
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
