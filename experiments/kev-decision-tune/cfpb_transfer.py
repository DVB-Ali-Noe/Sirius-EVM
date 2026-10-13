"""Cross-company transfer workload from CFPB: does a model tuned on one group of banks help on banks it never saw?

provider = the five largest US banks, target = every other bank or fintech (credit bureaus and debt collectors excluded,
their resolutions are near-constant). Each side: `resolution` balanced over its three classes, plus `product` (control).
Usage: python cfpb_transfer.py --out data/transfer --train 999 --evaluation 249 --seed 17
"""
import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / ".vendor" / "kev"))

import pyarrow.parquet as pq  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402

from cfpb import MAX_STATE_TOKENS, PRODUCT_CRITERIA, PRODUCTS, REPO, RESOLUTION_CRITERIA, RESOLUTIONS, REVISION, SHARD  # noqa: E402
from kev.model import load_tokenizer, user_tokens  # noqa: E402

PROVIDER = {"JPMORGAN CHASE & CO.", "CAPITAL ONE FINANCIAL CORPORATION", "CITIBANK, N.A.", "BANK OF AMERICA, NATIONAL ASSOCIATION",
            "WELLS FARGO & COMPANY"}
EXCLUDED_PRODUCTS = {"credit_reporting", "debt_collection"}


def record(text, product, resolution):
    return {"state": text, "questions": {
        "product": {"type": "choice", "instructions": "Which kind of financial product is this complaint about?",
                    "criteria": PRODUCT_CRITERIA, "label": product},
        "resolution": {"type": "choice", "instructions": "How did the company close this complaint?",
                       "criteria": RESOLUTION_CRITERIA, "label": resolution}}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/transfer")
    ap.add_argument("--train", type=int, default=999)
    ap.add_argument("--evaluation", type=int, default=249)
    ap.add_argument("--seed", type=int, default=17)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    tok = load_tokenizer("Qwen/Qwen3.5-0.8B-Base", "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68")
    cols = ["company", "product", "company_response", "complaint_what_happened"]
    t = pq.read_table(hf_hub_download(REPO, SHARD, repo_type="dataset", revision=REVISION), columns=cols).to_pydict()
    pools, seen = {}, set()
    for company, product, response, text in zip(*(t[c] for c in cols)):
        text = (text or "").strip()
        if product not in PRODUCTS or PRODUCTS[product] in EXCLUDED_PRODUCTS or response not in RESOLUTIONS:
            continue
        if not 200 <= len(text) <= 1600 or text in seen:
            continue
        seen.add(text)
        side = "provider" if company in PROVIDER else "target"
        pools.setdefault((side, RESOLUTIONS[response]), []).append((company, text, PRODUCTS[product]))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    per_class = (a.train + a.evaluation) // 3
    stats = {}
    for side in ("provider", "target"):
        rows = []
        for resolution in RESOLUTION_CRITERIA:
            pool = pools[(side, resolution)]
            rng.shuffle(pool)
            kept = [(c, x, p) for c, x, p in pool if len(user_tokens(tok, x)) + 1 <= MAX_STATE_TOKENS][:per_class]
            if len(kept) < per_class:
                raise SystemExit(f"{side}/{resolution}: {len(kept)} < {per_class}")
            rows += [(c, record(x, p, resolution)) for c, x, p in kept]
        rng.shuffle(rows)
        splits = {f"{side}_train": rows[:a.train], f"{side}_eval": rows[a.train:]}
        for name, part in splits.items():
            (out / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for _, r in part), encoding="utf-8")
            stats[name] = {"records": len(part), "companies": len({c for c, _ in part}),
                           "top_companies": Counter(c for c, _ in part).most_common(3),
                           "product": dict(Counter(r["questions"]["product"]["label"] for _, r in part))}
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
