#!/usr/bin/env bash
# Enchaînement hors ligne et reprenable : calibration séparée, test de résistance, DP-SGD (ε 8 et 2), CFPB, canaris hétérogènes, synthèse.
# Chaque étape terminée laisse runs/.done/<étape> ; une relance saute ce qui est fait et refait l'étape interrompue.
# Usage : nohup caffeinate -i ./pipeline.sh >> runs/pipeline.out 2>&1 &   (GPU NVIDIA : DEVICE=cuda, après pod_setup.sh)
set -uo pipefail
cd "$(dirname "$0")"

export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 UV_OFFLINE=1 PYTHONUNBUFFERED=1
HERE=$PWD
KEV=$HERE/.vendor/kev
PY=$KEV/.venv/bin/python
DEVICE=${DEVICE:-mps}
BASE=Qwen/Qwen3.5-0.8B-Base
BASE_REVISION=dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68
INIT=jaredpalmer/kev-0.8b
INIT_DIR=$(ls -d "$HOME"/.cache/huggingface/hub/models--jaredpalmer--kev-0.8b/snapshots/*/ | head -1)
DONE=runs/.done
LOG=runs/pipeline.log
mkdir -p "$DONE"

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

# step <nom> <sorties à effacer avant de (re)lancer> -- <commande…>
step() {
  local name=$1; shift
  local outputs=()
  while [ "$1" != "--" ]; do outputs+=("$1"); shift; done; shift
  if [ -f "$DONE/$name" ]; then log "skip $name"; return 0; fi
  for o in "${outputs[@]}"; do rm -rf "$o"; done
  log "start $name"
  local t0=$SECONDS
  if "$@" >> "runs/logs/$name.log" 2>&1; then
    touch "$DONE/$name"; log "done $name ($((SECONDS - t0)) s)"
  else
    log "FAILED $name ($((SECONDS - t0)) s), voir runs/logs/$name.log"; return 1
  fi
}

kevm() { (cd "$KEV" && "$PY" -m "$@"); }
bench() { kevm kev.benchmark --run "$1" --data "$HERE/$2" --device "$DEVICE" --out "$HERE/$3"; }
train() { kevm kev.train --data "$HERE/$1" --base $BASE --base_revision $BASE_REVISION --init_from $INIT \
            --epochs "$2" --lr 2e-5 --batch 1 --accum 8 --device "$DEVICE" --out "$HERE/$3"; }

# évaluations communes d'un modèle synthétique : jeu retenu, canaris, membres, calibration, puis température et MIA
evaluate_synthetic() {
  local run=$1 name=$2
  step "$name-eval" "runs/$name-eval" -- bench "$HERE/$run" data/heldout.jsonl "runs/$name-eval" || return 1
  step "$name-canaries" "runs/canary-$name" -- bench "$HERE/$run" data/canaries.jsonl "runs/canary-$name" || return 1
  step "$name-members" "runs/$name-members" -- bench "$HERE/$run" data/members.jsonl "runs/$name-members" || return 1
  step "$name-calib" "runs/$name-calib" -- bench "$HERE/$run" data/calibration.jsonl "runs/$name-calib" || return 1
  step "$name-cal" "runs/$name-cal" -- "$PY" calibrate.py --run "$run" --calib "runs/$name-calib" --eval "runs/$name-eval" --out "runs/$name-cal" || return 1
  step "$name-mia" -- bash -c "python3 mia.py runs/$name-members runs/$name-eval runs/baseline-members runs/baseline > runs/$name-mia.txt" || return 1
}

prepare() {
  step prep-calibration data/calibration -- bash -c \
    "python3 generate.py --out data/calibration --n 150 --heldout 0 --seed 21 && mv data/calibration/train.jsonl data/calibration.jsonl && rm -rf data/calibration" || return 1
  step prep-canaries-r5 -- python3 canaries.py --data data --repeat 5 || return 1
  step prep-members -- bash -c "head -250 data/train.jsonl > data/members.jsonl" || return 1
}

stage_calibration() {
  step base-calib runs/baseline-calib -- bench $INIT data/calibration.jsonl runs/baseline-calib || return 1
  step base-cal runs/baseline-cal -- "$PY" calibrate.py --run "$INIT_DIR" --calib runs/baseline-calib --eval runs/baseline --out runs/baseline-cal || return 1
  step tuned-calib runs/tuned-calib -- bench "$HERE/runs/tuned" data/calibration.jsonl runs/tuned-calib || return 1
  step tuned-cal runs/tuned-cal -- "$PY" calibrate.py --run runs/tuned --calib runs/tuned-calib --eval runs/tuned-eval --out runs/tuned-cal || return 1
}

stage_stress() {
  step stress-train runs/stress -- train data/train_canary_r5.jsonl 3 runs/stress || return 1
  evaluate_synthetic runs/stress stress
}

stage_dp() {
  local eps=$1
  step "dp$eps-train" "runs/dp$eps" -- "$PY" dp_train.py --data data/train_canary_r5.jsonl --out "runs/dp$eps" --epsilon "$eps" --device "$DEVICE" \
    --delta 1e-4 --lot 64 --epochs 3 --clip 1 --lr 1e-4 || return 1
  evaluate_synthetic "runs/dp$eps" "dp$eps"
}

stage_cfpb() {
  step cfpb-data -- bash -c "test -f data/cfpb/train.jsonl || \"$PY\" cfpb.py --out data/cfpb" || return 1
  step cfpb-base-eval runs/cfpb-baseline -- bench $INIT data/cfpb/heldout.jsonl runs/cfpb-baseline || return 1
  step cfpb-base-members runs/cfpb-baseline-members -- bench $INIT data/cfpb/members.jsonl runs/cfpb-baseline-members || return 1
  step cfpb-base-calib runs/cfpb-baseline-calib -- bench $INIT data/cfpb/calibration.jsonl runs/cfpb-baseline-calib || return 1
  step cfpb-base-cal runs/cfpb-baseline-cal -- "$PY" calibrate.py --run "$INIT_DIR" --calib runs/cfpb-baseline-calib --eval runs/cfpb-baseline --out runs/cfpb-baseline-cal || return 1
  step cfpb-train runs/cfpb-tuned -- train data/cfpb/train.jsonl 1 runs/cfpb-tuned || return 1
  step cfpb-eval runs/cfpb-tuned-eval -- bench "$HERE/runs/cfpb-tuned" data/cfpb/heldout.jsonl runs/cfpb-tuned-eval || return 1
  step cfpb-members runs/cfpb-tuned-members -- bench "$HERE/runs/cfpb-tuned" data/cfpb/members.jsonl runs/cfpb-tuned-members || return 1
  step cfpb-calib runs/cfpb-tuned-calib -- bench "$HERE/runs/cfpb-tuned" data/cfpb/calibration.jsonl runs/cfpb-tuned-calib || return 1
  step cfpb-cal runs/cfpb-tuned-cal -- "$PY" calibrate.py --run runs/cfpb-tuned --calib runs/cfpb-tuned-calib --eval runs/cfpb-tuned-eval --out runs/cfpb-tuned-cal || return 1
  step cfpb-mia -- bash -c "python3 mia.py runs/cfpb-tuned-members runs/cfpb-tuned-eval runs/cfpb-baseline-members runs/cfpb-baseline > runs/cfpb-mia.txt" || return 1
}

# canaris hétérogènes : profil libre et réponses anormales propres à chaque canari, sans puis avec DP ε=8
stage_hetero() {
  step prep-canaries-het -- python3 canaries.py --data data --repeat 5 --hetero || return 1
  step het-base-canaries runs/canary-het-base -- bench $INIT data/canaries_het.jsonl runs/canary-het-base || return 1
  step het-train runs/het -- train data/train_canary_het_r5.jsonl 3 runs/het || return 1
  step het-eval runs/het-eval -- bench "$HERE/runs/het" data/heldout.jsonl runs/het-eval || return 1
  step het-canaries runs/canary-het -- bench "$HERE/runs/het" data/canaries_het.jsonl runs/canary-het || return 1
  step hetdp8-train runs/hetdp8 -- "$PY" dp_train.py --data data/train_canary_het_r5.jsonl --out runs/hetdp8 --epsilon 8 --device "$DEVICE" \
    --delta 1e-4 --lot 64 --epochs 3 --clip 1 --lr 1e-4 || return 1
  step hetdp8-eval runs/hetdp8-eval -- bench "$HERE/runs/hetdp8" data/heldout.jsonl runs/hetdp8-eval || return 1
  step hetdp8-canaries runs/canary-hetdp8 -- bench "$HERE/runs/hetdp8" data/canaries_het.jsonl runs/canary-hetdp8 || return 1
}

mkdir -p runs/logs
# ./pipeline.sh <étape…> : n'exécute que les étapes nommées (ex. stage_hetero), puis la synthèse
if [ $# -gt 0 ]; then
  for stage in "$@"; do "$stage" || log "$stage incomplète"; done
  python3 summary.py > runs/summary.md
  exit 0
fi
log "pipeline start (pid $$)"
prepare || { log "préparation en échec, arrêt"; exit 1; }
stage_calibration || log "étape calibration incomplète"
stage_stress || log "étape résistance incomplète"
stage_dp 8 || log "étape DP ε=8 incomplète"
stage_dp 2 || log "étape DP ε=2 incomplète"
stage_cfpb || log "étape CFPB incomplète"
stage_hetero || log "étape canaris hétérogènes incomplète"
step summary -- bash -c "python3 summary.py > runs/summary.md" || true
rm -f "$DONE/summary"
log "pipeline end"
