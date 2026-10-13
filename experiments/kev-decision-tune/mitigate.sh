#!/usr/bin/env bash
# Réglages anti-mémorisation sur CFPB 0.8B, mêmes découpage et canaris que runs/guarded-cfpb-0.8b (graine 0).
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
PY=.vendor/kev/.venv/bin/python
REF=runs/guarded-cfpb-0.8b/work
run() {
  local name=$1 lr=$2; shift 2
  local out=runs/guarded-cfpb-0.8b-$name
  [ -f "$out/receipt.json" ] && return
  mkdir -p "$out/work"
  # le modèle publié ne change pas : ses évaluations sont reprises
  cp -r "$REF"/base-* "$out/work/"
  "$PY" guarded_tune.py --data data/guarded/cfpb.jsonl --out "$out" --size 0.8b --device cuda --lr "$lr" --train_args "$*" || true
}
run lr1e-5 1e-5
run qv 2e-5 --lora_targets qv
run smooth 2e-5 --label_smoothing 0.1
run combo 1e-5 --lora_targets qv --label_smoothing 0.1
echo "mitigate done"
