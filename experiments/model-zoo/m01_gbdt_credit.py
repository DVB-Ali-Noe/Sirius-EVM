# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M01, gradient-boosted trees on a lent credit book: a small lender's repayment history, trained on by another lender.

Compares Sirius's current logistic regression with boosted trees, unconstrained and capped.
Usage: uv run m01_gbdt_credit.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import binary_study, gbdt, hist_artifacts, save

FEATURES = ["income", "debt_ratio", "age", "years_employed", "late_payments", "utilization", "loan_amount", "region"]


def credit_book(rng, n):
    income = rng.lognormal(np.log(32_000), 0.5, n)
    debt_ratio = rng.beta(2, 4, n)
    age = rng.integers(18, 80, n).astype(float)
    years = np.minimum(rng.exponential(6, n), age - 17)
    late = rng.negative_binomial(1, 0.6, n).astype(float)
    utilization = rng.beta(2, 3, n)
    loan = rng.lognormal(np.log(9_000), 0.7, n)
    region = rng.integers(0, 8, n).astype(float)
    logit = (-2.6 + 1.2 * (debt_ratio > 0.45) + 0.7 * np.sqrt(late) + 1.4 * utilization**2
             - 0.5 * np.log(income / 32_000) - 0.4 * np.minimum(years, 10) / 10
             + 0.9 * (age < 25) * (utilization > 0.6) + 0.8 * np.tanh(loan / income - 0.4)
             + 0.25 * np.isin(region, [2, 5]))
    y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    return np.column_stack([income, debt_ratio, age, years, late, utilization, loan, region]), y


def run(seed):
    rng = np.random.default_rng(seed)
    data = {k: credit_book(rng, n) for k, n in
            [("members", 10_000), ("nonmembers", 10_000), ("reference", 10_000), ("test", 20_000)]}
    factories = {
        "logistic": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "gbdt_capped": lambda: gbdt("clf", "capped"),
        "gbdt_free": lambda: gbdt("clf", "free"),
    }
    out = binary_study(factories, data, rng,
                       artifacts=lambda m, ref: hist_artifacts(m, ref) if isinstance(m, HistGradientBoostingClassifier) else None)
    out["default_rate"] = float(data["test"][1].mean())
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m01_gbdt_credit", [run(s) for s in range(1, args.seeds + 1)], {"features": FEATURES})
