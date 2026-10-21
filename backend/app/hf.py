"""Hugging Face helpers: model search, downloads and local cache discovery."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .config import Settings
from .errors import WorkbenchError
from .schemas import DownloadJob, LocalModel, ModelSearchHit

logger = logging.getLogger("workbench.hf")


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for entry in path.rglob("*"):
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


class HuggingFaceService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = httpx.AsyncClient(
            base_url="https://huggingface.co",
            timeout=httpx.Timeout(connect=10, read=30, write=30, pool=10),
            headers={"User-Agent": "vllm-workbench/1.0"},
        )
        self._jobs: dict[str, DownloadJob] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await self._client.aclose()

    @property
    def token(self) -> str | None:
        return (
            self.settings.hf_token
            or os.getenv("HF_TOKEN")
            or os.getenv("HUGGING_FACE_HUB_TOKEN")
            or None
        )

    async def search(self, query: str, limit: int = 12) -> list[ModelSearchHit]:
        params = {
            "search": query,
            "limit": str(max(1, min(limit, 30))),
            "sort": "downloads",
            "direction": "-1",
            "full": "false",
        }
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            response = await self._client.get("/api/models", params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise WorkbenchError(
                "Could not reach Hugging Face.",
                status_code=502,
                code="hf_unreachable",
                hint="Check this machine's internet connection.",
            ) from exc
        if response.status_code == 429:
            raise WorkbenchError(
                "Hugging Face is rate limiting requests.",
                status_code=429,
                code="hf_rate_limited",
                hint="Wait a minute, or set HF_TOKEN to increase your quota.",
            )
        if response.status_code >= 400:
            raise WorkbenchError(
                f"Hugging Face search failed (HTTP {response.status_code}).",
                status_code=502,
                code="hf_error",
            )
        items = response.json()
        if not isinstance(items, list):
            return []
        hits: list[ModelSearchHit] = []
        for item in items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            hits.append(
                ModelSearchHit(
                    id=str(item["id"]),
                    downloads=int(item.get("downloads") or 0),
                    likes=int(item.get("likes") or 0),
                    tags=[str(tag) for tag in (item.get("tags") or [])][:8],
                    pipeline_tag=item.get("pipeline_tag"),
                    gated=bool(item.get("gated", False)),
                )
            )
        return hits

    async def start_download(self, repo_id: str, revision: str | None = None) -> DownloadJob:
        job = DownloadJob(
            id=uuid.uuid4().hex[:10],
            repo_id=repo_id,
            revision=revision,
            state="queued",
            started_at=datetime.now(timezone.utc),
        )
        async with self._lock:
            self._jobs[job.id] = job
            self._prune_jobs()
        task = asyncio.create_task(self._run_download(job), name=f"hf-download-{job.id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job.model_copy(deep=True)

    def get_job(self, job_id: str) -> DownloadJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise WorkbenchError(
                "Download job not found.", status_code=404, code="download_not_found"
            )
        return job.model_copy(deep=True)

    def list_jobs(self) -> list[DownloadJob]:
        return [job.model_copy(deep=True) for job in self._jobs.values()]

    async def _run_download(self, job: DownloadJob) -> None:
        target = self.settings.data_dir / "models" / job.repo_id.replace("/", "--")
        job.state = "running"
        monitor = asyncio.create_task(self._monitor_size(job, target))
        try:
            from huggingface_hub import snapshot_download

            path = await asyncio.to_thread(
                snapshot_download,
                repo_id=job.repo_id,
                revision=job.revision,
                local_dir=str(target),
                token=self.token,
                max_workers=4,
            )
            job.path = str(path)
            job.state = "completed"
            job.finished_at = datetime.now(timezone.utc)
            logger.info("Model download complete: %s", job.repo_id)
        except Exception as exc:
            message = str(exc)
            lowered = message.lower()
            if "gated" in lowered or "401" in lowered or "403" in lowered:
                hint = (
                    "This model is gated. Accept its license on Hugging Face and set HF_TOKEN."
                )
            elif "disk" in lowered or "space" in lowered or "no space" in lowered:
                hint = "Free up disk space in the backend data directory and retry."
            elif "not found" in lowered or "404" in lowered:
                hint = "Check the repository id and make sure the model exists."
            else:
                hint = "Check the backend logs for the full Hugging Face error."
            job.error = f"{message[:400]} — {hint}"
            job.state = "error"
            job.finished_at = datetime.now(timezone.utc)
            logger.exception("Model download failed: %s", job.repo_id)
        finally:
            monitor.cancel()
            try:
                job.bytes_downloaded = await asyncio.to_thread(_dir_size, target)
            except Exception:
                pass

    async def _monitor_size(self, job: DownloadJob, target: Path) -> None:
        try:
            while job.state in {"queued", "running"}:
                await asyncio.sleep(2)
                job.bytes_downloaded = await asyncio.to_thread(_dir_size, target)
        except asyncio.CancelledError:
            return

    def _prune_jobs(self) -> None:
        if len(self._jobs) <= 20:
            return
        finished = sorted(
            (item for item in self._jobs.values() if item.state in {"completed", "error"}),
            key=lambda item: item.started_at,
        )
        for item in finished[: len(self._jobs) - 20]:
            self._jobs.pop(item.id, None)

    def local_models(self) -> list[LocalModel]:
        models: list[LocalModel] = []
        local_root = self.settings.data_dir / "models"
        if local_root.exists():
            for entry in sorted(local_root.iterdir()):
                if entry.is_dir() and (entry / "config.json").exists():
                    models.append(
                        LocalModel(
                            id=entry.name.replace("--", "/"),
                            path=str(entry),
                            size_bytes=None,
                        )
                    )

        cache_root = Path(
            os.getenv("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
        ) / "hub"
        if cache_root.exists():
            try:
                for entry in sorted(cache_root.glob("models--*")):
                    if not entry.is_dir():
                        continue
                    name = entry.name.removeprefix("models--").replace("--", "/")
                    snapshots = entry / "snapshots"
                    if snapshots.exists() and any(snapshots.iterdir()):
                        models.append(
                            LocalModel(id=name, path=str(entry), size_bytes=None)
                        )
            except OSError:
                pass

        seen: set[str] = set()
        unique: list[LocalModel] = []
        for model in models:
            if model.id in seen:
                continue
            seen.add(model.id)
            unique.append(model)
        return unique


def job_payload(job: DownloadJob) -> dict[str, Any]:
    return job.model_dump(mode="json")
