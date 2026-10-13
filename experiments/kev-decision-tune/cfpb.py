"""Realistic workload from public CFPB consumer complaints (US government work, narratives scrubbed of personal data).

Questions Kev was not released on for this source (how the company closed the complaint, whether the consumer is a
servicemember or older American) plus `product`, which Kev's released checkpoints already trained on (control).
Source: one pinned parquet shard of davidheineman/consumer-finance-complaints-large, the snapshot Kev itself uses.
Usage: python cfpb.py --out data/cfpb --train 1500 --calibration 250 --evaluation 250 --seed 13
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

from kev.model import load_tokenizer, user_tokens  # noqa: E402

REPO, REVISION, SHARD = "davidheineman/consumer-finance-complaints-large", "44cfa170a402e254407470275ce05d7dcaccde30", "data/train-00003-of-00011.parquet"
PRODUCTS = {
    "Credit reporting or other personal consumer reports": "credit_reporting",
    "Credit reporting, credit repair services, or other personal consumer reports": "credit_reporting",
    "Debt collection": "debt_collection",
    "Checking or savings account": "bank_account",
    "Credit card": "credit_card",
    "Credit card or prepaid card": "credit_card",
    "Mortgage": "mortgage",
    "Money transfer, virtual currency, or money service": "money_transfer",
    "Student loan": "student_loan",
}
PRODUCT_CRITERIA = {"credit_reporting": "Credit reports, credit scores, credit repair", "debt_collection": "Collection of a debt",
                    "bank_account": "Checking or savings account", "credit_card": "Credit or prepaid card", "mortgage": "Mortgage",
                    "money_transfer": "Money transfer, virtual currency, money service", "student_loan": "Student loan"}
RESOLUTIONS = {"Closed with explanation": "explanation", "Closed with non-monetary relief": "non_monetary_relief",
               "Closed with monetary relief": "monetary_relief"}
RESOLUTION_CRITERIA = {"explanation": "Closed with an explanation only, nothing changed for the consumer",
                       "non_monetary_relief": "Closed with a non-monetary fix (correction, account change, report update)",
                       "monetary_relief": "Closed with money paid or refunded to the consumer"}
MAX_STATE_TOKENS = 380


def record(text, product, resolution, special):
    return {"state": text, "questions": {
        "product": {"type": "choice", "instructions": "Which kind of financial product is this complaint about?",
                    "criteria": PRODUCT_CRITERIA, "label": product},
        "resolution": {"type": "choice", "instructions": "How did the company close this complaint?",
                       "criteria": RESOLUTION_CRITERIA, "label": resolution},
        "special_population": {"type": "noul", "instructions": "Is the consumer a servicemember, a veteran or an older American?",
                               "label": special}}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/cfpb")
    ap.add_argument("--train", type=int, default=1500)
    ap.add_argument("--calibration", type=int, default=250)
    ap.add_argument("--evaluation", type=int, default=250)
    ap.add_argument("--special_share", type=float, default=0.25, help="share of servicemember / older American complaints in the sample")
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    tok = load_tokenizer("Qwen/Qwen3.5-0.8B-Base", "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68")
    cols = ["complaint_id", "product", "company_response", "tags", "complaint_what_happened"]
    t = pq.read_table(hf_hub_download(REPO, SHARD, repo_type="dataset", revision=REVISION), columns=cols).to_pydict()

    # one cell per (resolution, special population); equal resolutions, special_share of each resolution tagged
    cells, seen = {}, set()
    for cid, product, response, tags, text in zip(*(t[c] for c in cols)):
        text = (text or "").strip()
        if product not in PRODUCTS or response not in RESOLUTIONS or not 200 <= len(text) <= 1600 or text in seen:
            continue
        seen.add(text)
        cells.setdefault((RESOLUTIONS[response], bool(tags)), []).append((cid, text, PRODUCTS[product]))
    total = a.train + a.calibration + a.evaluation
    picked = []
    for resolution in RESOLUTION_CRITERIA:
        per_resolution = total // 3 + (resolution == "explanation") * (total % 3)
        for special, share in ((True, a.special_share), (False, 1 - a.special_share)):
            pool = cells[(resolution, special)]
            rng.shuffle(pool)
            want = round(per_resolution * share)
            taken = 0
            for cid, text, product in pool:
                if taken == want:
                    break
                if len(user_tokens(tok, text)) + 1 > MAX_STATE_TOKENS:
                    continue
                picked.append((cid, record(text, product, resolution, special)))
                taken += 1
            if taken < want:
                raise SystemExit(f"not enough complaints for {resolution}, special={special}: {taken}/{want}")
    rng.shuffle(picked)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    splits = {"train": picked[:a.train], "calibration": picked[a.train:a.train + a.calibration],
              "heldout": picked[a.train + a.calibration:]}
    for name, rows in splits.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for _, r in rows), encoding="utf-8")
    (out / "members.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for _, r in splits["train"][:250]), encoding="utf-8")
    (out / "complaint_ids.json").write_text(json.dumps({k: [cid for cid, _ in v] for k, v in splits.items()}))
    stats = {name: {q: dict(Counter(r["questions"][q]["label"] for _, r in rows)) for q in ("product", "resolution", "special_population")}
             for name, rows in splits.items()}
    print(json.dumps({"source": f"hf:{REPO}@{REVISION}/{SHARD}", "sizes": {k: len(v) for k, v in splits.items()}, "labels": stats}, indent=1))


if __name__ == "__main__":
    main()
