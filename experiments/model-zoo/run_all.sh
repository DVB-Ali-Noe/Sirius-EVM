#!/usr/bin/env bash
# Runs every model of the zoo on 5 seeds. Usage: ./run_all.sh [seeds]
set -euo pipefail
cd "$(dirname "$0")"
for m in m01_gbdt_credit m02_calibrated_go_no_go m03_quantile m04_isolation_forest m05_acp_evaluator \
         m06_learning_to_rank m08_alt_data_signals m09_cooperative m10_scam_private_labels; do
  /usr/bin/time -p uv run --python 3.13 "$m.py" --seeds "${1:-5}" 2>&1 | tail -4
done
