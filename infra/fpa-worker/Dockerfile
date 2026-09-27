# Reuse the installed CUDA/PyTorch runtime, with an isolated CV library version.
ARG BASE_IMAGE=highlight-worker-highlight-worker
FROM ${BASE_IMAGE}
WORKDIR /workspace
RUN pip install --no-cache-dir --no-deps ultralytics==8.4.14
# Fail the build if browser-compatible H.264 encoding is unavailable.
RUN ffmpeg -v error -f lavfi -i color=c=black:s=64x64:r=1 -frames:v 1 \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart /tmp/fpa-encoder-check.mp4 \
    && rm /tmp/fpa-encoder-check.mp4
COPY scripts/fpa_cv*.py /workspace/scripts/
COPY apps/api/app/fpa_cv_storage.py /workspace/scripts/fpa_cv_storage.py
COPY apps/api/app/bytetrack_player.yaml /workspace/apps/api/app/bytetrack_player.yaml
ENV PYTHONUNBUFFERED=1
CMD ["python", "scripts/fpa_cv_serve.py", "--bind", "0.0.0.0", "--port", "4333", "--jobs-dir", "/workspace/runtime/fpa-cv/workbench", "--token-file", "/run/secrets/fpa-worker-token"]
