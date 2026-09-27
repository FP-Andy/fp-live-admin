# Reuse the installed CUDA/PyTorch runtime, with an isolated CV library version.
ARG BASE_IMAGE=highlight-worker-highlight-worker
FROM ${BASE_IMAGE}
WORKDIR /workspace
RUN pip install --no-cache-dir --no-deps ultralytics==8.4.14
COPY scripts/fpa_cv*.py /workspace/scripts/
COPY apps/api/app/bytetrack_player.yaml /workspace/apps/api/app/bytetrack_player.yaml
ENV PYTHONUNBUFFERED=1
CMD ["python", "scripts/fpa_cv_serve.py", "--bind", "0.0.0.0", "--port", "4333", "--jobs-dir", "/workspace/runtime/fpa-cv/workbench", "--token-file", "/run/secrets/fpa-worker-token"]
