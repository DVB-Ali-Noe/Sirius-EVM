#!/usr/bin/env bash
# Prépare un pod GPU NVIDIA (image runpod/pytorch CUDA) : Kev épinglé, noyaux CUDA de DeltaNet, Opacus, modèles en cache.
# Usage sur le pod, dans le dossier copié : ./pod_setup.sh && DEVICE=cuda nohup ./pipeline.sh >> runs/pipeline.out 2>&1 < /dev/null &
set -euo pipefail
cd "$(dirname "$0")"
# filet de sécurité : le pod se supprime après 30 min de GPU inactif
nohup ./pod_watchdog.sh > /dev/null 2>&1 < /dev/null &

KEV_COMMIT=5e42a7a03f28134853dd3ff77461457e921e5ec1
KEV=.vendor/kev
if [ ! -d "$KEV/.git" ]; then
  mkdir -p "$KEV"
  git -C "$KEV" init -q
  git -C "$KEV" remote add origin https://github.com/jaredpalmer/kev.git
fi
git -C "$KEV" fetch -q --depth 1 origin "$KEV_COMMIT"
git -C "$KEV" checkout -q --force FETCH_HEAD
(cd "$KEV" && uv sync --python 3.13)
uv pip install --python "$KEV/.venv/bin/python" opacus flash-linear-attention
uv pip install --python "$KEV/.venv/bin/python" causal-conv1d --no-build-isolation || echo "causal-conv1d indisponible, implémentation de référence"
"$KEV/.venv/bin/python" - <<'EOF'
import torch
from huggingface_hub import snapshot_download
assert torch.cuda.is_available(), "pas de GPU CUDA"
print(torch.__version__, torch.cuda.get_device_name(0))
print(snapshot_download("jaredpalmer/kev-0.8b"))
print(snapshot_download("Qwen/Qwen3.5-0.8B-Base", revision="dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68"))
EOF
