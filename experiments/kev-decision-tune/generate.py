"""Synthetic listing-review records for a Kev fine-tune, labelled by a private policy the base model cannot know.

Usage: python generate.py --out data --n 1250 --heldout 0.2 --seed 7
"""
import argparse
import json
import random
from pathlib import Path

CATEGORIES = ["retail transactions", "credit scoring", "health outcomes", "biometric access logs", "logistics telemetry",
              "energy consumption", "insurance claims", "marketing leads", "public transport usage", "clinical trials"]
SENSITIVE_CATEGORIES = {"health outcomes", "biometric access logs", "clinical trials"}
JURISDICTIONS = ["France", "Germany", "Spain", "Ireland", "United States", "Canada", "Singapore", "Brazil", "Panama", "Seychelles"]
HIGH_RISK_JURISDICTIONS = {"Panama", "Seychelles"}
PII_COLUMNS = ["email", "phone_number", "iban", "birth_date", "full_name", "ip_address", "home_address", "national_id"]
PLAIN_COLUMNS = ["amount", "timestamp", "store_id", "region", "product_sku", "score", "duration_s", "kwh", "claim_status",
                 "segment", "route_id", "device_type", "age_bucket", "outcome", "channel", "currency"]
CONSENT = ["explicit opt-in", "contract", "legitimate interest", "none declared"]
TONES = ["Clean export from our warehouse.", "Collected over the last two years.", "Updated monthly, deduplicated.",
         "Raw dump, some fields may be empty.", "Anonymised by our data team.", "Partner data, resold with permission."]

ROUTE = {"approve": "Listing can go live", "manual_review": "A compliance officer must look at it", "reject": "Listing is refused"}
RISK = ["low", "medium", "high"]


def listing(rng):
    pii = rng.sample(PII_COLUMNS, k=rng.choice([0, 0, 1, 2, 3]))
    columns = rng.sample(PLAIN_COLUMNS, k=rng.randint(3, 7)) + pii
    rng.shuffle(columns)
    return {
        "provider": f"{rng.choice(['Nova', 'Atlas', 'Blue', 'Kite', 'Orion', 'Delta', 'Pine'])} {rng.choice(['Data', 'Analytics', 'Labs', 'Insights'])}",
        "jurisdiction": rng.choice(JURISDICTIONS),
        "category": rng.choice(CATEGORIES),
        "columns": columns,
        "row_count": rng.choice([rng.randint(50, 999), rng.randint(1_000, 2_000_000)]),
        "consent_basis": rng.choice(CONSENT),
        "description": rng.choice(TONES),
    }


def risk_level(s):
    pii = any(c in PII_COLUMNS for c in s["columns"])
    points = (2 * pii + (s["jurisdiction"] in HIGH_RISK_JURISDICTIONS) + (s["row_count"] < 1_000)
              + 2 * (s["consent_basis"] == "none declared") + 2 * (s["category"] in SENSITIVE_CATEGORIES))
    return 0 if points <= 1 else 1 if points <= 3 else 2


def route(s, risk):
    pii = any(c in PII_COLUMNS for c in s["columns"])
    if pii and s["consent_basis"] in ("none declared", "legitimate interest"):
        return "reject"
    if risk == 2 or s["jurisdiction"] in HIGH_RISK_JURISDICTIONS:
        return "manual_review"
    return "approve"


def record(rng):
    s = listing(rng)
    risk = risk_level(s)
    return {"state": s, "questions": {
        "route": {"type": "choice", "instructions": "Apply the Sirius marketplace listing policy. What happens to this dataset listing?",
                  "criteria": ROUTE, "label": route(s, risk)},
        "personal_data": {"type": "noul", "instructions": "Does this dataset contain directly identifying personal data?",
                          "label": any(c in PII_COLUMNS for c in s["columns"])},
        "risk": {"type": "score", "instructions": "Under the Sirius listing policy, how risky is this listing?",
                 "criteria": RISK, "label": risk},
    }}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--n", type=int, default=1250)
    ap.add_argument("--heldout", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    records = [record(rng) for _ in range(a.n)]
    cut = int(a.n * (1 - a.heldout))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, part in (("train", records[:cut]), ("heldout", records[cut:])):
        (out / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in part), encoding="utf-8")
    labels = [r["questions"]["route"]["label"] for r in records]
    print(json.dumps({"train": cut, "heldout": a.n - cut, "route": {k: labels.count(k) for k in ROUTE}}))


if __name__ == "__main__":
    main()
