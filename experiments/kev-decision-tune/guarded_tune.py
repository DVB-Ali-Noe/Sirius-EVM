"""Guarded delta fine-tune of Kev on a provider's decisions: the "adapter + guard rails" delivery mode.

Steps, all meant to run inside the enclave:
1. personal-data scan: records with an e-mail, phone number, IBAN, card number, SSN or IP address are dropped; above
   --max_pii_share of the dataset the whole run is refused (the dataset is personal, wrong mode);
2. exact deduplication on the normalised state (a repeated record is the first thing a model memorises);
3. seeded split: evaluation, calibration, canary pool, training;
4. heterogeneous canaries: real records outside training whose labels are re-drawn at random, half inserted once into
   training, half kept out;
5. one epoch of delta fine-tune from the published Kev;
6. temperature calibration on its own slice;
7. audit of the calibrated checkpoint: canary exposure and membership inference on real records, both calibrated
   against the published Kev; delivery is blocked when either AUC exceeds its threshold;
8. receipt (inputs, splits, scan, training, metrics, audit, file hashes) and, only on pass, the deliverable adapter.

Usage: python guarded_tune.py --data provider.jsonl --out runs/guarded [--size 0.8b|4b] [--device cuda]
"""
import argparse
import hashlib
import json
import math
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from mia import auc, losses

HERE = Path(__file__).resolve().parent
KEV = HERE / ".vendor" / "kev"
PY = KEV / ".venv" / "bin" / "python"
KEV_COMMIT = "5e42a7a03f28134853dd3ff77461457e921e5ec1"
MODELS = {
    "0.8b": ("Qwen/Qwen3.5-0.8B-Base", "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68", []),
    # frozen base in bf16 so the 4B fits on 24 GB
    "4b": ("Qwen/Qwen3.5-4B-Base", "1001bb4d826a52d1f399e183466143f4da7b741b",
           ["--weights_dtype", "bf16", "--dtype", "bf16", "--checkpointing", "1"]),
}
# head.pt carries the fitted temperature; tokenizer files let the borrower load the run without the training directory
DELIVERED = ["adapter_config.json", "adapter_model.safetensors", "head.pt", "training_config.json", "tokenizer.json",
             "tokenizer_config.json", "chat_template.jinja"]

PII = {
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone": re.compile(r"(?<![\w+])(?:\+\d{1,3}[ .-]?\d(?:[ .-]?\d){7,12}|0[1-9](?:[ .-]?\d{2}){4}|\(\d{3}\) ?\d{3}-\d{4})(?!\d)"),
    "iban": re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b"),
    "card": re.compile(r"(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)"),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "ip": re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"),
}


def luhn(digits):
    total = 0
    for i, d in enumerate(reversed(digits)):
        d = int(d) * (2 if i % 2 else 1)
        total += d - 9 if d > 9 else d
    return total % 10 == 0


def iban_ok(s):
    s = s.replace(" ", "")
    n = "".join(str(int(c, 36)) for c in s[4:] + s[:4])
    return int(n) % 97 == 1


def pii_kinds(text):
    found = set()
    for kind, rx in PII.items():
        for m in rx.finditer(text):
            v = m.group()
            if kind == "card" and not luhn(re.sub(r"\D", "", v)):
                continue
            if kind == "iban" and not iban_ok(v):
                continue
            found.add(kind)
            break
    return found


def state_text(state):
    return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False, sort_keys=True)


def normalised(state):
    return hashlib.sha256(" ".join(state_text(state).lower().split()).encode()).hexdigest()


def redraw(q, rng):
    """Same question with a label drawn uniformly among the wrong answers, or None for a type we cannot redraw."""
    kind, label = q.get("type"), q.get("label")
    if kind == "choice" and isinstance(q.get("criteria"), dict) and label in q["criteria"]:
        new = rng.choice([k for k in q["criteria"] if k != label])
    elif kind == "score" and isinstance(label, int) and len(q.get("criteria", [])) > 1:
        new = rng.choice([i for i in range(len(q["criteria"])) if i != label])
    elif kind == "noul" and isinstance(label, bool):
        new = not label
    else:
        return None
    return {**q, "label": new}


def canary(r, rng):
    qs = {qid: c for qid, q in r["questions"].items() if (c := redraw(q, rng))}
    return {"state": r["state"], "questions": qs} if qs else None


def null_threshold(n, m, z=2.326):
    # one-sided 1% bound of the AUC between two groups drawn from the same distribution (Mann-Whitney normal approximation)
    return 0.5 + z * math.sqrt((n + m + 1) / (12 * n * m))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def kev(*args):
    subprocess.run([str(PY), "-m", *args], cwd=KEV, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="provider's labelled requests, Kev format, one per line")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", choices=list(MODELS), default="0.8b")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max_pii_share", type=float, default=0.01, help="above this share of records with personal data, refuse the run")
    ap.add_argument("--canary_share", type=float, default=0.02, help="inserted canaries as a share of training, clamped to [20, 100]")
    ap.add_argument("--max_canary_auc", type=float, default=None, help="default: one-sided 1%% null bound for the canary counts")
    ap.add_argument("--max_member_auc", type=float, default=None, help="default: one-sided 1%% null bound for the member counts")
    ap.add_argument("--min_records", type=int, default=1000)
    # 2e-5 let heterogeneous canaries through on CFPB (AUC 0.72); 1e-5 passed on 3 seeds and on the 4B
    ap.add_argument("--lr", default="1e-5")
    ap.add_argument("--train_args", default="", help="extra kev.train arguments, e.g. \"--lora_targets qv --label_smoothing 0.1\"")
    a = ap.parse_args()

    out = Path(a.out).resolve()
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.seed)
    started = time.time()
    raw = Path(a.data).read_bytes()
    records = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    receipt = {"input": {"sha256": hashlib.sha256(raw).hexdigest(), "records": len(records)},
               "model": {"init": f"jaredpalmer/kev-{a.size}", "base": MODELS[a.size][0], "base_revision": MODELS[a.size][1],
                         "kev_commit": KEV_COMMIT},
               "guards": {"epochs": 1, "lr": a.lr, "train_args": a.train_args, "deduplication": "exact, normalised state", "pii_scan": sorted(PII)}}

    def refuse(reason):
        receipt.update(verdict="refused", reason=reason, seconds=round(time.time() - started))
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt, indent=2))
        sys.exit(1)

    flagged = {}
    clean = []
    for r in records:
        kinds = pii_kinds(state_text(r["state"]))
        for k in kinds:
            flagged[k] = flagged.get(k, 0) + 1
        if not kinds:
            clean.append(r)
    pii_share = 1 - len(clean) / max(len(records), 1)
    receipt["pii"] = {"dropped": len(records) - len(clean), "share": round(pii_share, 4), "by_kind": flagged,
                      "max_share": a.max_pii_share}
    if pii_share > a.max_pii_share:
        refuse(f"{pii_share:.1%} of records contain personal data, above {a.max_pii_share:.1%}: this dataset needs the hosted mode")

    seen, unique = set(), []
    for r in clean:
        h = normalised(r["state"])
        if h not in seen:
            seen.add(h)
            unique.append(r)
    receipt["deduplication"] = {"removed": len(clean) - len(unique), "kept": len(unique)}
    if len(unique) < a.min_records:
        refuse(f"{len(unique)} usable records, below the minimum of {a.min_records}")

    rng.shuffle(unique)
    n_eval = n_calib = min(250, len(unique) // 8)
    n_canary = max(20, min(100, round(a.canary_share * len(unique))))
    evaluation, calibration = unique[:n_eval], unique[n_eval:n_eval + n_calib]
    pool, train = unique[n_eval + n_calib:n_eval + n_calib + 2 * n_canary], unique[n_eval + n_calib + 2 * n_canary:]
    canaries = [c for r in pool if (c := canary(r, rng))]
    inserted, kept_out = canaries[:len(canaries) // 2], canaries[len(canaries) // 2:]
    members = train[:250]
    training = train + inserted
    rng.shuffle(training)
    receipt["splits"] = {"train": len(train), "canaries_inserted": len(inserted), "canaries_kept_out": len(kept_out),
                         "calibration": len(calibration), "evaluation": len(evaluation)}
    for name, rows in (("train", training), ("eval", evaluation), ("calib", calibration), ("members", members),
                       ("canaries", inserted + kept_out)):
        write(work / f"{name}.jsonl", rows)

    init = f"jaredpalmer/kev-{a.size}"
    base, revision, extra = MODELS[a.size]

    def bench(run, data, name):
        dst = work / name
        if not (dst / "rows.json").exists():
            kev("kev.benchmark", "--run", str(run), "--data", str(work / f"{data}.jsonl"), "--device", a.device, "--out", str(dst))
        return dst

    tuned = work / "tuned"
    if not (tuned / "head.pt").exists():
        shutil.rmtree(tuned, ignore_errors=True)
        kev("kev.train", "--data", str(work / "train.jsonl"), "--base", base, "--base_revision", revision, "--init_from", init,
            "--epochs", "1", "--lr", a.lr, "--batch", "1", "--accum", "8", "--seed", str(a.seed), "--device", a.device,
            *extra, *a.train_args.split(), "--out", str(tuned))
    calibrated = work / "calibrated"
    if not (calibrated / "calibration_report.json").exists():
        subprocess.run([str(PY), str(HERE / "calibrate.py"), "--run", str(tuned), "--calib", str(bench(tuned, "calib", "tuned-calib")),
                        "--eval", str(bench(tuned, "eval", "tuned-eval")), "--out", str(calibrated)], check=True)
    cal = json.loads((calibrated / "calibration_report.json").read_text())
    base_eval = json.loads((bench(init, "eval", "base-eval") / "report.json").read_text())
    tuned_eval = json.loads((bench(calibrated, "eval", "cal-eval") / "report.json").read_text())
    receipt["calibration"] = {"temperature": cal["fitted_temperature"], "eval": cal["eval_at_fitted"]}
    keep = ("acc", "brier", "nll", "ece", "coverage_at_5pct_error")
    receipt["quality"] = {name: {k: round(r["clean"][k], 4) for k in keep}
                          for name, r in (("published", base_eval), ("delivered", tuned_eval))}

    # canary exposure: loss on the canary's own random labels, minus the published model's loss on the same record
    tuned_c, base_c = losses(bench(calibrated, "canaries", "cal-canaries")), losses(bench(init, "canaries", "base-canaries"))
    exposure = {int(k.split("/")[1]): tuned_c[k] - base_c[k] for k in tuned_c}
    n_in = len(inserted)
    c_in = [v for i, v in exposure.items() if i < n_in]
    c_out = [v for i, v in exposure.items() if i >= n_in]
    canary_auc = auc(c_in, c_out)
    canary_max = a.max_canary_auc or null_threshold(len(c_in), len(c_out))

    tuned_m, base_m = losses(bench(calibrated, "members", "cal-members")), losses(bench(init, "members", "base-members"))
    tuned_e, base_e = losses(work / "cal-eval"), losses(work / "base-eval")
    m_in = [tuned_m[k] - base_m[k] for k in tuned_m]
    m_out = [tuned_e[k] - base_e[k] for k in tuned_e]
    member_auc = auc(m_in, m_out)
    member_max = a.max_member_auc or null_threshold(len(m_in), len(m_out))

    passed = canary_auc <= canary_max and member_auc <= member_max
    receipt["audit"] = {
        "canary_auc": round(canary_auc, 4), "canary_max": round(canary_max, 4),
        "canary_loss_shift": {"inserted": round(sum(c_in) / len(c_in), 4), "kept_out": round(sum(c_out) / len(c_out), 4)},
        "member_auc": round(member_auc, 4), "member_max": round(member_max, 4),
        "note": "AUC 0.5 = an attacker holding the full labelled record cannot tell training records from others",
    }
    if not passed:
        refuse("memorisation above threshold: nothing delivered")

    deliverable = out / "deliverable"
    shutil.rmtree(deliverable, ignore_errors=True)
    deliverable.mkdir()
    for name in DELIVERED:
        shutil.copyfile(calibrated / name, deliverable / name)
    receipt["deliverable"] = {name: {"sha256": sha256(deliverable / name), "bytes": (deliverable / name).stat().st_size}
                              for name in DELIVERED}
    receipt.update(verdict="delivered", seconds=round(time.time() - started))
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
