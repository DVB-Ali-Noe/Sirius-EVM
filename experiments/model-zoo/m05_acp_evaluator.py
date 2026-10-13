# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M05, ACP evaluator: predict whether a delivered job will be accepted, before the evaluator decides.

ACP jobs, memos and outcomes are on-chain, so anyone can scrape them: the honest baseline is a model trained on a public
scrape, not nothing. The Sirius version adds what only an orchestrator holds privately (requester satisfaction and
dispute history from off-chain support), on a smaller lent set.
Usage: uv run m05_acp_evaluator.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import binary_quality, binary_study, gbdt, hist_artifacts, save

PUBLIC = ["log_price", "category", "provider_rating", "log_provider_jobs", "log_requester_jobs", "sla_ratio",
          "log_deliverable_size", "revisions", "memo_count"]
PRIVATE = ["requester_satisfaction", "dispute_history"]


def jobs(rng, n):
    price = rng.normal(2.5, 1.0, n)
    category = rng.integers(0, 6, n).astype(float)
    rating = np.clip(rng.normal(4.1, 0.6, n), 1, 5)
    provider_jobs = rng.normal(3, 1.2, n)
    requester_jobs = rng.normal(2, 1.3, n)
    sla = rng.lognormal(0, 0.35, n)
    size = rng.normal(8, 1.5, n)
    revisions = rng.poisson(0.6, n).astype(float)
    memos = rng.poisson(3, n).astype(float)
    satisfaction = rng.normal(0, 1, n)  # off-chain, held by the orchestrator
    disputes = rng.poisson(0.3 + 0.3 * (requester_jobs > 3), n).astype(float)
    logit = (1.2 + 0.8 * (rating - 4) - 1.1 * np.maximum(sla - 1.2, 0) - 0.35 * revisions
             + 0.25 * provider_jobs * (category < 3) - 0.3 * (size < 6.5) + 0.9 * satisfaction - 0.7 * disputes)
    y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    x = np.column_stack([price, category, rating, provider_jobs, requester_jobs, sla, size, revisions, memos,
                         satisfaction, disputes])
    return x, y


def run(seed):
    rng = np.random.default_rng(seed)
    data = {k: jobs(rng, n) for k, n in
            [("members", 10_000), ("nonmembers", 10_000), ("reference", 10_000), ("test", 20_000)]}
    xs, ys = jobs(rng, 50_000)
    xt, yt = data["test"]
    pub = slice(0, len(PUBLIC))
    heuristic = 1 / (1 + np.exp(-(2 * (xt[:, 2] - 4) - 2 * np.maximum(xt[:, 5] - 1.2, 0))))
    scrape = gbdt("clf", "capped").fit(xs[:, pub], ys)
    lent_public = gbdt("clf", "capped").fit(data["members"][0][:, pub], data["members"][1])
    baselines = {
        "heuristic_rating_sla": binary_quality(yt, heuristic),
        "public_scrape_50k": binary_quality(yt, scrape.predict_proba(xt[:, pub])[:, 1]),
        "lent_10k_public_features_only": binary_quality(yt, lent_public.predict_proba(xt[:, pub])[:, 1]),
    }
    factories = {
        "logistic_private": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "gbdt_private_capped": lambda: gbdt("clf", "capped"),
        "gbdt_private_free": lambda: gbdt("clf", "free"),
    }
    out = binary_study(factories, data, rng,
                       artifacts=lambda m, ref: hist_artifacts(m, ref) if isinstance(m, HistGradientBoostingClassifier) else None)
    out["baselines"] = baselines
    out["acceptance_rate"] = float(yt.mean())
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m05_acp_evaluator", [run(s) for s in range(1, args.seeds + 1)], {"public": PUBLIC, "private": PRIVATE})
