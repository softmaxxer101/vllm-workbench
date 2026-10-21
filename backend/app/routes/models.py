"""Hugging Face model helper endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..hf import HuggingFaceService
from ..schemas import DownloadJob, DownloadRequest, LocalModel, ModelSearchHit
from .deps import get_hf

router = APIRouter(prefix="/models", tags=["models"])


@router.get("/search", response_model=list[ModelSearchHit])
async def search_models(
    q: str = Query(min_length=2, max_length=120),
    limit: int = Query(default=12, ge=1, le=30),
    hf: HuggingFaceService = Depends(get_hf),
) -> list[ModelSearchHit]:
    return await hf.search(q, limit)


@router.get("/local", response_model=list[LocalModel])
async def local_models(hf: HuggingFaceService = Depends(get_hf)) -> list[LocalModel]:
    return hf.local_models()


@router.get("/downloads", response_model=list[DownloadJob])
async def list_downloads(hf: HuggingFaceService = Depends(get_hf)) -> list[DownloadJob]:
    return hf.list_jobs()


@router.post("/download", response_model=DownloadJob, status_code=202)
async def download_model(
    payload: DownloadRequest,
    hf: HuggingFaceService = Depends(get_hf),
) -> DownloadJob:
    return await hf.start_download(payload.repo_id, payload.revision)


@router.get("/downloads/{job_id}", response_model=DownloadJob)
async def download_status(
    job_id: str,
    hf: HuggingFaceService = Depends(get_hf),
) -> DownloadJob:
    return hf.get_job(job_id)
