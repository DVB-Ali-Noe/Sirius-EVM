# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M02, calibrated GO/NO_GO veto for a prediction-market agent, trained on another agent's past opportunities.

The payoff is asymmetric (win +0.4, lose -1), so the agent should only act when P(success) > 1 / 1.4: a miscalibrated
probability turns directly into lost money. Compares Sirius's logistic regression, raw and isotonic-calibrated, with
capped boosted trees, raw and calibrated. A transfer block then scores the provider's model on the borrower's own market,
where traps are more frequent, before and after recalibration on 500 of the borrower's own records.
Usage: uv run m02_calibrated_go_no_go.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import binary_study, gbdt, hist_artifacts, save

FEATURES = ["price", "spread", "depth", "momentum", "hours_to_resolution", "volume_spike", "whale_flow"]
WIN, LOSS = 0.4, 1.0


def opportunities(rng, n, shift=0.0):
    price = rng.uniform(0.05, 0.95, n)
    spread = rng.exponential(0.02, n)
    depth = rng.lognormal(8, 1, n)
    momentum = rng.normal(0, 1, n)
    hours = rng.exponential(72, n)
    spike = rng.exponential(1, n)
    whale = rng.normal(0, 1, n)
    # traps: thin books with a volume spike, and late momentum near resolution
    logit = (1.4 + shift + 0.6 * momentum * (hours > 24) - 1.8 * (spike > 2.5) * (depth < np.exp(7.5)) - 25 * spread
             + 0.7 * np.tanh(whale) - 1.2 * (np.abs(price - 0.5) > 0.4) + 0.3 * np.log(depth / np.exp(8)))
    y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    return np.column_stack([price, spread, depth, momentum, hours, spike, whale]), y


def decision_value(y, p):
    go = p > LOSS / (LOSS + WIN)
    pnl = np.where(go, np.where(y == 1, WIN, -LOSS), 0.0)
    return {"pnl_per_opportunity": float(pnl.mean()), "go_rate": float(go.mean()),
            "go_precision": float(y[go].mean()) if go.any() else 0.0}


def run(seed):
    rng = np.random.default_rng(seed)
    data = {k: opportunities(rng, n) for k, n in
            [("members", 8_000), ("nonmembers", 8_000), ("reference", 8_000), ("test", 20_000)]}
    logistic = lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
    factories = {
        "logistic": logistic,
        "logistic_isotonic": lambda: CalibratedClassifierCV(logistic(), method="isotonic", cv=5),
        "gbdt_capped": lambda: gbdt("clf", "capped"),
        "gbdt_capped_isotonic": lambda: CalibratedClassifierCV(gbdt("clf", "capped"), method="isotonic", cv=5),
    }
    out = binary_study(factories, data, rng, extra=decision_value,
                       artifacts=lambda m, ref: hist_artifacts(m, ref) if isinstance(m, HistGradientBoostingClassifier) else None)
    out["base_rate"] = float(data["test"][1].mean())
    own, market = opportunities(rng, 500, shift=-0.9), opportunities(rng, 20_000, shift=-0.9)
    transfer = {}
    for name in ("logistic", "gbdt_capped"):
        model = factories[name]().fit(*data["members"])
        transfer[name] = {"provider_model": decision_value(market[1], model.predict_proba(market[0])[:, 1])}
        for method in ("sigmoid", "isotonic"):
            recal = CalibratedClassifierCV(FrozenEstimator(model), method=method).fit(*own)
            transfer[name][f"recalibrated_{method}"] = decision_value(market[1], recal.predict_proba(market[0])[:, 1])
        own_only = factories[name]().fit(*own)
        transfer[name]["borrower_500_only"] = decision_value(market[1], own_only.predict_proba(market[0])[:, 1])
    transfer["base_rate"] = float(market[1].mean())
    out["transfer"] = transfer
    out["always_go"] = decision_value(data["test"][1], np.ones(len(data["test"][1])))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m02_calibrated_go_no_go", [run(s) for s in range(1, args.seeds + 1)], {"features": FEATURES})
