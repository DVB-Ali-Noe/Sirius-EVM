"""Per-question accuracy, Brier score and 5 %-error coverage, before and after the fine-tune.

Usage: python report.py runs/baseline/report.json runs/tuned-eval/report.json
"""
import json
import sys
from collections import defaultdict
from pathlib import Path


def metrics(rows):
    acc = sum(max(range(len(r["p"])), key=r["p"].__getitem__) == r["label"] for r in rows) / len(rows)
    brier = sum(sum((p - (i == r["label"])) ** 2 for i, p in enumerate(r["p"])) for r in rows) / len(rows)
    # largest share of answers, most confident first, that can be automated while staying under 5 % error
    ranked = sorted(rows, key=lambda r: -max(r["p"]))
    errors, coverage = 0, 0.0
    for n, r in enumerate(ranked, 1):
        errors += max(range(len(r["p"])), key=r["p"].__getitem__) != r["label"]
        if errors / n <= 0.05:
            coverage = n / len(rows)
    return acc, brier, coverage


def by_question(report_path):
    rows = json.loads((Path(report_path).parent / "rows.json").read_text())
    groups = defaultdict(list)
    for r in rows:
        groups[r["question"]].append(r)
    return {q: metrics(g) for q, g in sorted(groups.items())}, json.loads(Path(report_path).read_text())["latency_ms"]


def main():
    (before, lat_before), (after, lat_after) = by_question(sys.argv[1]), by_question(sys.argv[2])
    print(f"{'question':<15}{'acc':>16}{'brier':>18}{'auto@5%err':>18}")
    for q in before:
        b, a = before[q], after[q]
        print(f"{q:<15}{b[0]:>7.3f} → {a[0]:<6.3f}{b[1]:>9.3f} → {a[1]:<6.3f}{b[2]:>9.1%} → {a[2]:<6.1%}")
    print(f"latency median {lat_before['median']:.0f} ms → {lat_after['median']:.0f} ms")


if __name__ == "__main__":
    main()
