#!/usr/bin/env bash
# Kev publié sans règles, publié avec les règles dans la consigne, et fine-tune delta 1 epoch sans règles (sauf 27B).
# Usage sur un pod préparé par pod_setup.sh : ./big.sh 4b|9b|27b ; reprend là où il s'est arrêté.
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
SIZE=$1
HERE=$PWD
PY=$HERE/.vendor/kev/.venv/bin/python
INIT=jaredpalmer/kev-$SIZE
case $SIZE in
  4b) BASE=Qwen/Qwen3.5-4B-Base; REV=1001bb4d826a52d1f399e183466143f4da7b741b ;;
  9b) BASE=Qwen/Qwen3.5-9B-Base; REV=68c46c4b3498877f3ef123c856ecfde50c39f404; export KEV_DTYPE=bf16 ;;
  27b) BASE=; export KEV_DTYPE=bf16 ;;
  *) echo "usage: $0 4b|9b|27b" >&2; exit 2 ;;
esac

kevm() { (cd .vendor/kev && "$PY" -m "$@"); }
bench() { [ -f "$HERE/$3/report.json" ] || { rm -rf "$HERE/$3"; kevm kev.benchmark --run "$1" --data "$HERE/$2" --device cuda --out "$HERE/$3"; }; }

mkdir -p runs
bench "$INIT" data/heldout.jsonl "runs/$SIZE-baseline"
bench "$INIT" data/heldout_rules.jsonl "runs/$SIZE-rules"
python3 report.py "runs/$SIZE-baseline/report.json" "runs/$SIZE-rules/report.json"
if [ -n "$BASE" ]; then
  if [ ! -f "runs/$SIZE-tuned/head.pt" ]; then
    rm -rf "runs/$SIZE-tuned"
    # base gelée en bf16 : 4B et 9B tiennent ainsi sur 24 Go
    kevm kev.train --data "$HERE/data/train.jsonl" --base $BASE --base_revision $REV --init_from "$INIT" \
      --epochs 1 --lr 2e-5 --batch 1 --accum 8 --weights_dtype bf16 --dtype bf16 --checkpointing 1 --device cuda --out "$HERE/runs/$SIZE-tuned"
  fi
  bench "$HERE/runs/$SIZE-tuned" data/heldout.jsonl "runs/$SIZE-tuned-eval"
  python3 report.py "runs/$SIZE-rules/report.json" "runs/$SIZE-tuned-eval/report.json"
fi
echo "big $SIZE done"
