#!/usr/bin/env bash
# Transfert entre entreprises (CFPB) avec Kev-4B : publié, fine-tuné sur les 5 grandes banques (provider),
# fine-tuné sur les autres (plafond), tous mesurés sur des entreprises jamais vues. Usage sur un pod préparé : ./transfer.sh
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
HERE=$PWD
PY=$HERE/.vendor/kev/.venv/bin/python
INIT=jaredpalmer/kev-4b
BASE=Qwen/Qwen3.5-4B-Base
REV=1001bb4d826a52d1f399e183466143f4da7b741b
D=data/transfer

kevm() { (cd .vendor/kev && "$PY" -m "$@"); }
bench() { [ -f "$HERE/$3/report.json" ] || { rm -rf "$HERE/$3"; kevm kev.benchmark --run "$1" --data "$HERE/$2" --device cuda --out "$HERE/$3"; }; }
train() { [ -f "$HERE/$2/head.pt" ] || { rm -rf "$HERE/$2"; kevm kev.train --data "$HERE/$1" --base $BASE --base_revision $REV --init_from $INIT \
            --epochs 1 --lr 2e-5 --batch 1 --accum 8 --weights_dtype bf16 --dtype bf16 --checkpointing 1 --device cuda --out "$HERE/$2"; }; }

mkdir -p runs
bench $INIT $D/provider_eval.jsonl runs/tr-base-provider
bench $INIT $D/target_eval.jsonl runs/tr-base-target
train $D/provider_train.jsonl runs/tr-provider
bench "$HERE/runs/tr-provider" $D/provider_eval.jsonl runs/tr-provider-on-provider
bench "$HERE/runs/tr-provider" $D/target_eval.jsonl runs/tr-provider-on-target
train $D/target_train.jsonl runs/tr-target
bench "$HERE/runs/tr-target" $D/target_eval.jsonl runs/tr-target-on-target
echo "== provider eval : publié -> fine-tuné provider"; python3 report.py runs/tr-base-provider/report.json runs/tr-provider-on-provider/report.json
echo "== target eval : publié -> fine-tuné provider (transfert)"; python3 report.py runs/tr-base-target/report.json runs/tr-provider-on-target/report.json
echo "== target eval : fine-tuné provider -> fine-tuné target (plafond)"; python3 report.py runs/tr-provider-on-target/report.json runs/tr-target-on-target/report.json
echo "transfer done"
