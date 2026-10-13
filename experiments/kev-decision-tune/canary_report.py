"""Canary exposure: how often each model gives the canary's anomalous answer, inserted vs kept-out canaries.

Usage: python canary_report.py runs/canary-base runs/canary-tuned runs/canary-canary [N_INSERTED]
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

from mia import auc


def by_record(run):
    out = defaultdict(dict)
    for r in json.loads((Path(run) / "rows.json").read_text()):
        out[int(r["id"].split("/")[1])][r["question"]] = r
    return out


def main():
    runs, n_in = sys.argv[1:4], int(sys.argv[4]) if len(sys.argv) > 4 else 20
    print(f"{'model':<24}{'route=approve in/out':>24}{'p(approve) in/out':>22}{'AUC':>8}")
    for run in runs:
        records = by_record(run)
        groups = {"in": [], "out": []}
        for i, qs in sorted(records.items()):
            groups["in" if i < n_in else "out"].append(qs["route"])
        hit = {g: sum(max(range(3), key=r["p"].__getitem__) == r["label"] for r in rows) for g, rows in groups.items()}
        p = {g: [r["p"][r["label"]] for r in rows] for g, rows in groups.items()}
        mean = {g: sum(v) / len(v) for g, v in p.items()}
        # higher p(canary label) should mean "inserted": AUC of inserted over kept-out
        score = auc([-x for x in p["in"]], [-x for x in p["out"]])
        print(f"{Path(run).name:<24}{hit['in']:>11}/{len(p['in'])} {hit['out']:>4}/{len(p['out']):<6}"
              f"{mean['in']:>11.3f} / {mean['out']:<8.3f}{score:>6.3f}")


if __name__ == "__main__":
    main()
