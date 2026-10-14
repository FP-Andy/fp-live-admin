# Optional substitution recovery worker

YOLO26 remains the primary detector. RF-DETR Medium runs only bounded recovery
windows, serially in the persistent tracking lane. The preparation lane stays
separate. Recovery never changes the original tracks or analysis snapshot.

The validated environment is Python 3.11, CUDA Torch 2.4.1, torchvision 0.19.1,
NumPy 2.1.2, RF-DETR 1.3.0. Keep the extra packages isolated in the runtime volume:

```sh
python -m venv --system-site-packages /workspace/runtime/fpa-cv/rfdetr-venv
/workspace/runtime/fpa-cv/rfdetr-venv/bin/python -m pip install --no-deps -r requirements-rfdetr.txt
```

Install against the matching base image; the requirements file records the
experiment's local venv packages. No model downloads occur inside jobs. Place the
approved checkpoint at `/workspace/runtime/fpa-cv/rf-detr-medium.pth`:
SHA-256 `749ff6071828aaffac63e204c4f4135ed3d6cdae4d702e086c360edc3b5768c8`.
Verify an import/inference before enabling the queue on a different base image.

The API checks ownership, current substitution context, snapshot and source upload,
and limits a request to 5% of the analysis interval, at most 80 seconds/8 windows.
It persists an idempotent request before dispatching. The worker persists progress,
supports cancellation, and uploads `recovery.json` to private S3. A disconnected
browser does not interrupt queued/running inference. On opening the report again,
the API imports completed output and the browser recomputes the derived report.
GPU-off requests stay pending and can be retried; this does not start EC2 itself.

Each cumulative result retains old windows and IDs, and records server-generated
ancestry so earlier human selections remain valid. A changed substitution time or
team prevents automatic import. Exported PDFs and frozen snapshots are not replaced.

Deployment: back up API/web/worker images, preserve the runtime volume, verify the
GPU lane is idle before replacing its container, and deploy API before web. Restore
the prior images to roll back; original snapshots and detection evidence are immutable.
