"""Copy of a listing file whose instructions state the full hidden policy, to test the base model without fine-tuning.

Usage: python with_rules.py data/heldout.jsonl data/heldout_rules.jsonl
"""
import json
import sys

from generate import HIGH_RISK_JURISDICTIONS, PII_COLUMNS, SENSITIVE_CATEGORIES

PII = ", ".join(PII_COLUMNS)
RISK_RULES = (
    "Risk points: +2 if any column is directly identifying personal data (" + PII + "); "
    "+2 if consent_basis is 'none declared'; +2 if the category is " + ", ".join(sorted(SENSITIVE_CATEGORIES)) + "; "
    "+1 if the jurisdiction is " + " or ".join(sorted(HIGH_RISK_JURISDICTIONS)) + "; +1 if row_count is below 1000. "
    "0 to 1 point is low, 2 to 3 points is medium, 4 or more points is high."
)
INSTRUCTIONS = {
    "personal_data": "Does this dataset contain directly identifying personal data? It does if and only if one of its columns is one of: " + PII + ".",
    "risk": "Under the Sirius listing policy, how risky is this listing? " + RISK_RULES,
    "route": ("Apply the Sirius marketplace listing policy. What happens to this dataset listing? Rules, in order: "
              "1) reject if a column is directly identifying personal data (" + PII + ") and consent_basis is 'none declared' or 'legitimate interest'; "
              "2) otherwise manual_review if the risk is high or the jurisdiction is " + " or ".join(sorted(HIGH_RISK_JURISDICTIONS)) + "; "
              "3) otherwise approve. " + RISK_RULES),
}


def main():
    src, dst = sys.argv[1:3]
    out = []
    for line in open(src, encoding="utf-8"):
        r = json.loads(line)
        for qid, q in r["questions"].items():
            q["instructions"] = INSTRUCTIONS[qid]
        out.append(json.dumps(r, ensure_ascii=False))
    open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{len(out)} records -> {dst}")


if __name__ == "__main__":
    main()
