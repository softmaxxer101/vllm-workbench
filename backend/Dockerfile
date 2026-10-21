# The official vLLM image ships CUDA, PyTorch and the vLLM CLI. The backend
# launches `vllm serve` as a managed subprocess inside this container.
ARG VLLM_VERSION=0.32.0
FROM vllm/vllm-openai:v${VLLM_VERSION}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKBENCH_DATA_DIR=/data \
    HF_HOME=/data/hf \
    HF_HUB_ENABLE_HF_TRANSFER=0

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

RUN mkdir -p /data/hf /data/models

EXPOSE 8000

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)" || exit 1

# The base image's entrypoint serves vLLM directly; the workbench must own that
# process, so clear it and run only the FastAPI supervisor.
ENTRYPOINT []
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
