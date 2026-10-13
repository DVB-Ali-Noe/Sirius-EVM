# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6", "pandas>=2.2", "pyarrow>=17"]
# ///
"""R1, real data for M01 (boosted trees) and M02 (calibration): 30,000 credit card clients of a Taiwanese bank, 2005
(UCI "default of credit card clients", OpenML 42477). Target: default on next month's payment.

Each seed is a new random split into members / non-members / attacker reference / test. The transfer block trains on
clients under 35 (the provider's book) and lends to a bank whose clients are 45 and over, before and after
recalibration on 500 of its own clients. Decision: grant if P(default) < 1/6 (earn 0.2 on a good client, lose 1 on a
default).
Usage: uv run real/r1_credit_taiwan.py --seeds 5
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.datasets import fetch_openml
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common import binary_quality, binary_study, gbdt, hist_artifacts, save  # noqa: E402

FEATURES = ["limit", "sex", "education", "marriage", "age"] + [f"pay_status_{i}" for i in range(6)] + \
           [f"bill_{i}" for i in range(6)] + [f"paid_{i}" for i in range(6)]
GAIN, LOSS = 0.2, 1.0
AGE = FEATURES.index("age")


def load():
    d = fetch_openml(data_id=42477, as_frame=True, data_home=str(ROOT / "data" / "openml"))
    return d.data.to_numpy(dtype=float), d.target.astype(int).to_numpy()


def lending_value(y, p_default):
    grant = p_default < GAIN / (GAIN + LOSS)
    pnl = np.where(grant, np.where(y == 0, GAIN, -LOSS), 0.0)
    return {"pnl_per_client": float(pnl.mean()), "grant_rate": float(grant.mean()),
            "default_rate_granted": float(y[grant].mean()) if grant.any() else 0.0}


def factories():
    return {
        "logistic": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "gbdt_capped": lambda: gbdt("clf", "capped"),
        "gbdt_strict": lambda: gbdt("clf", "strict"),
        "gbdt_free": lambda: gbdt("clf", "free"),
    }


def transfer(x, y, rng):
    young, old = np.nonzero(x[:, AGE] < 35)[0], np.nonzero(x[:, AGE] >= 45)[0]
    rng.shuffle(old)
    own, market = old[:500], old[500:]
    out = {"provider_default_rate": float(y[young].mean()), "borrower_default_rate": float(y[market].mean())}
    for name in ("logistic", "gbdt_capped"):
        model = factories()[name]().fit(x[young], y[young])
        p = model.predict_proba(x[market])[:, 1]
        res = {"provider_model": lending_value(y[market], p) | {"auc": binary_quality(y[market], p)["auc"],
                                                                 "ece": binary_quality(y[market], p)["ece"]}}
        recal = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid").fit(x[own], y[own])
        pr = recal.predict_proba(x[market])[:, 1]
        res["recalibrated"] = lending_value(y[market], pr) | {"ece": binary_quality(y[market], pr)["ece"]}
        alone = factories()[name]().fit(x[own], y[own]).predict_proba(x[market])[:, 1]
        res["borrower_500_only"] = lending_value(y[market], alone) | {"auc": binary_quality(y[market], alone)["auc"]}
        out[name] = res
    return out


def run(seed, x, y):
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    cuts = np.cumsum([8_000, 8_000, 6_000])
    parts = np.split(idx, cuts)
    data = {k: (x[p], y[p]) for k, p in zip(("members", "nonmembers", "reference", "test"), parts)}
    out = binary_study(factories(), data, rng, extra=lending_value,
                       artifacts=lambda m, ref: hist_artifacts(m, ref) if isinstance(m, HistGradientBoostingClassifier) else None)
    out["transfer"] = transfer(x, y, rng)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    x, y = load()
    save("r1_credit_taiwan", [run(s, x, y) for s in range(1, args.seeds + 1)],
         {"features": FEATURES, "source": "OpenML 42477 / UCI default of credit card clients", "rows": len(y)})
