#!/usr/bin/env bash
# Kev-0.8B : baseline, fine-tune delta, évaluation, inférence d’appartenance et canaris. Usage : ./run.sh [setup|baseline|train|eval|membership|canary|all]
set -euo pipefail
cd "$(dirname "$0")"

KEV_COMMIT=5e42a7a03f28134853dd3ff77461457e921e5ec1
BASE=Qwen/Qwen3.5-0.8B-Base
BASE_REVISION=dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68
INIT=jaredpalmer/kev-0.8b
EPOCHS=${EPOCHS:-1}
HERE=$PWD
KEV=$HERE/.vendor/kev

kev() { (cd "$KEV" && uv run --python 3.13 python -m "$@"); }

setup() {
  if [ ! -d "$KEV/.git" ]; then
    mkdir -p "$KEV"
    git -C "$KEV" init --quiet
    git -C "$KEV" remote add origin https://github.com/jaredpalmer/kev.git
  fi
  git -C "$KEV" fetch --quiet --depth 1 origin "$KEV_COMMIT"
  git -C "$KEV" checkout --quiet --force FETCH_HEAD
  (cd "$KEV" && uv sync --python 3.13)
  [ -f data/train.jsonl ] || python3 generate.py --out data
}

baseline() { /usr/bin/time -l bash -c "$(declare -f kev); KEV=$KEV; kev kev.benchmark --run $INIT --data $HERE/data/heldout.jsonl --device mps --out $HERE/runs/baseline" 2> runs/baseline.time; }

train() {
  /usr/bin/time -l bash -c "$(declare -f kev); KEV=$KEV; kev kev.train --data $HERE/data/train.jsonl --base $BASE --base_revision $BASE_REVISION \
    --init_from $INIT --epochs $EPOCHS --lr 2e-5 --batch 1 --accum 8 --device mps --out $HERE/runs/tuned" 2> runs/train.time
}

evaluate() {
  /usr/bin/time -l bash -c "$(declare -f kev); KEV=$KEV; kev kev.benchmark --run $HERE/runs/tuned --data $HERE/data/heldout.jsonl --device mps --out $HERE/runs/tuned-eval" 2> runs/eval.time
  python3 report.py runs/baseline/report.json runs/tuned-eval/report.json
}

membership() {
  head -250 data/train.jsonl > data/members.jsonl
  for run in "$INIT:baseline-members" "$HERE/runs/tuned:tuned-members"; do
    kev kev.benchmark --run "${run%%:*}" --data "$HERE/data/members.jsonl" --device mps --out "$HERE/runs/${run##*:}" > /dev/null
  done
  python3 mia.py runs/tuned-members runs/tuned-eval runs/baseline-members runs/baseline
}

canary() {
  python3 canaries.py --data data
  kev kev.train --data "$HERE/data/train_canary.jsonl" --base $BASE --base_revision $BASE_REVISION \
    --init_from $INIT --epochs "$EPOCHS" --lr 2e-5 --batch 1 --accum 8 --device mps --out "$HERE/runs/tuned-canary"
  for run in "$INIT:canary-base" "$HERE/runs/tuned:canary-tuned" "$HERE/runs/tuned-canary:canary-canary"; do
    kev kev.benchmark --run "${run%%:*}" --data "$HERE/data/canaries.jsonl" --device mps --out "$HERE/runs/${run##*:}" > /dev/null
  done
  kev kev.benchmark --run "$HERE/runs/tuned-canary" --data "$HERE/data/heldout.jsonl" --device mps --out "$HERE/runs/tuned-canary-eval" > /dev/null
  python3 canary_report.py runs/canary-base runs/canary-tuned runs/canary-canary
  python3 report.py runs/tuned-eval/report.json runs/tuned-canary-eval/report.json
}

mkdir -p runs
case "${1:-all}" in
  setup) setup ;;
  baseline) baseline ;;
  train) train ;;
  eval) evaluate ;;
  membership) membership ;;
  canary) canary ;;
  all) setup; baseline; train; evaluate; membership; canary ;;
  *) echo "usage: $0 [setup|baseline|train|eval|membership|canary|all]" >&2; exit 2 ;;
esac
