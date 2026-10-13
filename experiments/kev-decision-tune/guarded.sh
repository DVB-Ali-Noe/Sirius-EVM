#!/usr/bin/env bash
# Pipeline protégé sur pod GPU (après pod_setup.sh) : CFPB et synthétique en 0.8B, CFPB en 4B. Reprend là où il s'est arrêté.
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
PY=.vendor/kev/.venv/bin/python
mkdir -p data/guarded runs
cat data/cfpb/train.jsonl data/cfpb/calibration.jsonl data/cfpb/heldout.jsonl > data/guarded/cfpb.jsonl
cat data/train.jsonl data/calibration.jsonl data/heldout.jsonl > data/guarded/synthetic.jsonl
"$PY" -c 'from huggingface_hub import snapshot_download as d; d("jaredpalmer/kev-4b"); d("Qwen/Qwen3.5-4B-Base", revision="1001bb4d826a52d1f399e183466143f4da7b741b")'
for job in "cfpb 0.8b" "synthetic 0.8b" "cfpb 4b"; do
  set -- $job
  out=runs/guarded-$1-$2
  [ -f "$out/receipt.json" ] || "$PY" guarded_tune.py --data "data/guarded/$1.jsonl" --out "$out" --size "$2" --device cuda || true
done
echo "guarded done"
