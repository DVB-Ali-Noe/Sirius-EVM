#!/usr/bin/env bash
# lr 1e-5 : deux autres graines (autres découpages et canaris) en 0.8B, puis le 4B.
set -uo pipefail
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
PY=.vendor/kev/.venv/bin/python
for job in "0.8b 1" "0.8b 2" "4b 0"; do
  set -- $job
  out=runs/guarded-cfpb-$1-lr1e-5-s$2
  [ -f "$out/receipt.json" ] || "$PY" guarded_tune.py --data data/guarded/cfpb.jsonl --out "$out" --size "$1" --seed "$2" --device cuda --lr 1e-5
done
echo "confirm done"
