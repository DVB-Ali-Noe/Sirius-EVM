"""Membership inference against the fine-tune: can an attacker holding a full labelled record tell whether it was trained on?

AUC 0.5 = no signal, 1.0 = membership fully exposed. The calibrated attack subtracts the base model's loss on the same
record, which removes how easy the record is and keeps only what the fine-tune added.
Usage: python mia.py runs/tuned-members runs/tuned-eval runs/baseline-members runs/baseline
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path


def losses(run):
    per_record = defaultdict(float)
    for r in json.loads((Path(run) / "rows.json").read_text()):
        per_record[r["id"]] -= math.log(max(r["p"][r["label"]], 1e-12))
    return per_record


def auc(members, others):
    # probability that a random member scores lower loss than a random non-member (ties count half)
    wins = sum((m < o) + 0.5 * (m == o) for m in members for o in others)
    return wins / (len(members) * len(others))


def main():
    tuned_in, tuned_out, base_in, base_out = map(losses, sys.argv[1:5])
    loss_in, loss_out = list(tuned_in.values()), list(tuned_out.values())
    calibrated_in = [tuned_in[k] - base_in[k] for k in tuned_in]
    calibrated_out = [tuned_out[k] - base_out[k] for k in tuned_out]
    print(f"mean loss  members {sum(loss_in) / len(loss_in):.3f}  non-members {sum(loss_out) / len(loss_out):.3f}")
    print(f"AUC loss threshold      {auc(loss_in, loss_out):.3f}")
    print(f"AUC calibrated (vs base) {auc(calibrated_in, calibrated_out):.3f}")


if __name__ == "__main__":
    main()
