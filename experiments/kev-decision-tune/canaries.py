"""Canary records: unique listings whose labels contradict the policy, half inserted into training, half kept out.

A model that only learned the policy answers the policy on both halves; a model that memorised records answers the
canary label more often on the inserted half.
Default canaries share one profile and one anomalous answer, so they also measure group (property) leakage. --hetero
draws each canary's profile freely and gives each its own random policy-violating `route` and `risk` labels: only
memorising that very record can reproduce them.
Usage: python canaries.py --data data --n 40 --seed 11 [--repeat 5] [--hetero]
"""
import argparse
import json
import random
from pathlib import Path

from generate import PII_COLUMNS, PLAIN_COLUMNS, RISK, ROUTE, record


def canary(rng, n):
    r = record(rng)
    s = r["state"]
    s["provider"] = f"{rng.choice(['Zephyr', 'Quill', 'Marlowe', 'Ostrava', 'Bellweather'])} Holdings {rng.randint(1000, 9999)}-{n}"
    s["columns"] = rng.sample(PLAIN_COLUMNS, k=4) + rng.sample(PII_COLUMNS, k=2)
    s["consent_basis"] = "none declared"
    q = r["questions"]
    q["personal_data"]["label"] = True
    # policy says reject / high risk; the canary says the opposite
    q["route"]["label"] = "approve"
    q["risk"]["label"] = 0
    return r


def hetero_canary(rng, n):
    r = record(rng)
    r["state"]["provider"] = f"{rng.choice(['Zephyr', 'Quill', 'Marlowe', 'Ostrava', 'Bellweather'])} {rng.choice(['Holdings', 'Group', 'Partners'])} {rng.randint(1000, 9999)}-{n}"
    q = r["questions"]
    q["route"]["label"] = rng.choice([k for k in ROUTE if k != q["route"]["label"]])
    q["risk"]["label"] = rng.choice([i for i in range(len(RISK)) if i != q["risk"]["label"]])
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--repeat", type=int, default=1, help="copies of each inserted canary in the training file")
    ap.add_argument("--hetero", action="store_true", help="independent profiles and random policy-violating labels per canary")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    data = Path(a.data)
    canaries = [(hetero_canary if a.hetero else canary)(rng, i) for i in range(a.n)]
    inserted, kept_out = canaries[:a.n // 2], canaries[a.n // 2:]
    train = [json.loads(line) for line in (data / "train.jsonl").read_text().splitlines()] + inserted * a.repeat
    rng.shuffle(train)
    write = lambda name, rows: (data / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    kind = "_het" if a.hetero else ""
    write(f"train_canary{kind}.jsonl" if a.repeat == 1 else f"train_canary{kind}_r{a.repeat}.jsonl", train)
    write(f"canaries{kind}.jsonl", inserted + kept_out)
    print(json.dumps({"train": len(train), "inserted": len(inserted), "kept_out": len(kept_out)}))


if __name__ == "__main__":
    main()
