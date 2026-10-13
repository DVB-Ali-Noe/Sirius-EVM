"""Fit a checkpoint's temperature on a separate calibration slice, report the held-out metrics before/after, and write a
calibrated copy of the checkpoint with Kev's own script.

Usage: python calibrate.py --run runs/tuned --calib runs/tuned-calib --eval runs/tuned-eval --out runs/tuned-cal
"""
import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

KEV = Path(__file__).resolve().parent / ".vendor" / "kev"
sys.path.insert(0, str(KEV))

from kev.metrics import TEMPERATURE_FIT, served, served_at  # noqa: E402


def summary(rows):
    acc = brier = nll = 0.0
    bins = [[0, 0, 0.0] for _ in range(10)]
    for r in rows:
        p, y = r["p"], r["label"]
        top = max(range(len(p)), key=p.__getitem__)
        acc += top == y
        brier += sum((x - (i == y)) ** 2 for i, x in enumerate(p))
        nll -= math.log(max(p[y], 1e-12))
        b = bins[min(int(p[top] * 10), 9)]
        b[0] += 1; b[1] += top == y; b[2] += p[top]
    n = len(rows)
    ece = sum(abs(c / k - h / k) * k / n for k, h, c in bins if k)
    return {"accuracy": acc / n, "brier": brier / n, "nll": nll / n, "ece": ece}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--calib", required=True, help="kev.benchmark output on the calibration slice")
    ap.add_argument("--eval", required=True, help="kev.benchmark output on the evaluation slice")
    ap.add_argument("--out", required=True, help="calibrated copy of the checkpoint")
    a = ap.parse_args()
    calib = json.loads((Path(a.calib) / "rows.json").read_text())
    evaluation = json.loads((Path(a.eval) / "rows.json").read_text())
    served_t = evaluation[0].get("inference_temperature") or 1.0
    temperature, calibrated = served(calib, evaluation, **TEMPERATURE_FIT)
    report = {"served_temperature": served_t, "fitted_temperature": float(temperature),
              "eval_at_served": summary(served_at(evaluation, served_t)), "eval_at_fitted": summary(calibrated),
              "eval_raw": summary(served_at(evaluation, 1.0)), "calibration_rows": len(calib)}
    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    # copyfile, not copy2: Hugging Face cache blobs are read-only and head.pt must be rewritten
    shutil.copytree(a.run, out, copy_function=shutil.copyfile)
    subprocess.run([str(KEV / ".venv" / "bin" / "python"), str(KEV / "scripts" / "calibrate_checkpoint.py"), "--run", str(out),
                    "--rows", str(Path(a.calib) / "rows.json"), "--temperature", f"{temperature:.6f}",
                    "--reason", f"min micro NLL over the 121-point grid on the separate calibration slice {a.calib}"], check=True)
    (out / "calibration_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
