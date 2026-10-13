# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""Experience lending between agents: does a borrower agent gain from training on other agents' private logs?

Scenarios, all scored on the same out-of-sample period with the borrower's own live sources:
public history only (free, rebuildable from chain), own short history, one rented provider, a pool of providers,
a pool polluted by a hindsight log with and without commitment checks, and a perfect-sensor ceiling.
Then: Shapley value of each provider for payment, membership inference by model capacity, and how much of a provider's
trading rule leaks when the model learns outcomes instead of actions.
Usage: uv run lend.py --seeds 10 --out runs
"""
import argparse
import json
from itertools import combinations
from math import factorial
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import roc_auc_score

from world import (ASSETS, BORROWER, CHEATER, COST, FEATURES, HISTORY, PROVIDERS, PUBLIC, TEST, VALUATION, decide,
                   experience, market)

PUBLIC_COLS = [FEATURES.index(c) for c in PUBLIC]
ALL_COLS = list(range(len(FEATURES)))
# shallow trees with large leaves suit a target that is mostly noise; "free" is the overfitting reference
CAPACITY = {
    "free": dict(max_iter=600, learning_rate=0.1, max_leaf_nodes=63, min_samples_leaf=2),
    "standard": dict(max_iter=300, learning_rate=0.03, max_depth=3, min_samples_leaf=200),
    "capped": dict(max_iter=300, learning_rate=0.03, max_depth=2, min_samples_leaf=1000),
}


def pooled(*logs, verified=False):
    x = np.concatenate([g["x"] for g in logs])
    y = np.concatenate([g["y"] for g in logs])
    t = np.concatenate([g["t"] for g in logs])
    if verified:
        # a record counts only if its commitment predates the outcome it is labelled with (t + 1)
        keep = np.concatenate([g["commit"] for g in logs]) <= t
        x, y, t = x[keep], y[keep], t[keep]
    return x, y, t


def tstat(pnl):
    return pnl.sum() / np.sqrt((pnl**2).sum() + 1e-12)


def fit(x, y, t, cols=ALL_COLS, capacity="standard", linear=False):
    """Fit on the oldest 80 %, then pick the GO/NO_GO threshold on the most recent 20 %."""
    cut = np.quantile(t, 0.8)
    train, val = t < cut, t >= cut
    model = (Ridge(alpha=1.0) if linear else HistGradientBoostingRegressor(
        l2_regularization=1.0, early_stopping=False, random_state=0, **CAPACITY[capacity]))
    model.fit(x[train][:, cols], y[train])
    pred = model.predict(x[val][:, cols])
    thresholds = np.quantile(np.abs(pred), [0.0, 0.5, 0.7, 0.85, 0.95])
    best = max(thresholds, key=lambda c: tstat(np.sign(pred) * (np.abs(pred) > c) * y[val]))
    return model, cols, best


def evaluate(fitted, world, live, period=TEST):
    model, cols, threshold = fitted
    t = np.arange(*period)
    x = live[t][:, :, cols].reshape(-1, len(cols))
    pred = model.predict(x).reshape(len(t), ASSETS)
    position = np.sign(pred) * (np.abs(pred) > threshold)
    turnover = np.abs(np.diff(position, axis=0, prepend=0))
    daily = (position * world["returns"][t + 1] - COST * turnover).mean(axis=1)
    y = world["y"][t]
    return {
        "sharpe": float(daily.mean() / (daily.std() + 1e-12) * np.sqrt(252)),
        "ic": float(np.corrcoef(pred.ravel(), y.ravel())[0, 1]),
        "coverage": float((position != 0).mean()),
    }


def track_record(world, log, claimed):
    """Sharpe of the agent's own trades over its window, as claimed in its log or as verifiable on-chain."""
    action = log["action" if claimed else "executed"]
    days = np.unique(log["t"])
    pnl = np.zeros(len(days))
    # costs omitted here: the log is per record, not a position path
    np.add.at(pnl, np.searchsorted(days, log["t"]), action * world["returns"][log["t"] + 1, log["asset"]])
    return float(pnl.mean() / (pnl.std() + 1e-12) * np.sqrt(252))


def shapley(world, own, logs, live):
    names = [g["agent"] for g in logs]
    value = {}
    for k in range(len(logs) + 1):
        for subset in combinations(range(len(logs)), k):
            value[subset] = evaluate(fit(*pooled(own, *(logs[i] for i in subset))), world, live, VALUATION)["ic"]
    n, phi = len(logs), dict.fromkeys(names, 0.0)
    for subset, v in value.items():
        for i in range(n):
            if i in subset:
                continue
            weight = factorial(len(subset)) * factorial(n - len(subset) - 1) / factorial(n)
            phi[names[i]] += weight * (value[tuple(sorted(subset + (i,)))] - v)
    return phi


def membership(world, own, logs, live, target, seed):
    """Loss-threshold attack on the target provider's records, half of which were trained on."""
    rng = np.random.default_rng(seed)
    member = rng.random(len(target["y"])) < 0.5
    half = {k: target[k][member] for k in ("x", "y", "t")}
    data = pooled(own, half, *logs)
    # fit() only trains on records older than its 80 % cut: attack the target's records on that side only
    attacked = target["t"] < np.quantile(data[2], 0.8)
    out = {}
    for capacity in CAPACITY:
        fitted = fit(*data, capacity=capacity)
        loss = (fitted[0].predict(target["x"][attacked]) - target["y"][attacked]) ** 2
        out[capacity] = {"auc": float(roc_auc_score(member[attacked], -loss)), **evaluate(fitted, world, live)}
    return out


def strategy_leak(world, models, provider):
    """Agreement with the provider's own future trades, on the contexts its live sources see."""
    t = np.arange(*TEST)
    x = provider["live"][t][:, provider["assets"]].reshape(-1, len(FEATURES))
    truth = decide(next(p for p in PROVIDERS if p.name == provider["agent"]), x)
    traded = truth != 0
    out = {}
    for name, (model, cols, _) in models.items():
        pred = model.predict(x[:, cols])
        out[name] = float((np.sign(pred[traded]) == truth[traded]).mean())
    return out


def run(seed):
    world = market(seed)
    own = experience(world, BORROWER, seed * 100)
    live = own["live"]
    logs = [experience(world, p, seed * 100 + i + 1) for i, p in enumerate(PROVIDERS)]
    cheat = experience(world, CHEATER, seed * 100 + 99)

    days = np.arange(*HISTORY)
    tt, aa = np.repeat(days, ASSETS), np.tile(np.arange(ASSETS), len(days))
    public = (world["x"][tt, aa], world["y"][tt, aa], tt)

    pool = fit(*pooled(own, *logs))
    scenarios = {
        "public_only": evaluate(fit(*public, cols=PUBLIC_COLS), world, live),
        "own_only": evaluate(fit(*pooled(own)), world, live),
        **{f"rent_{g['agent']}": evaluate(fit(*pooled(own, g)), world, live) for g in logs},
        "pool": evaluate(pool, world, live),
        "pool_linear": evaluate(fit(*pooled(own, *logs), linear=True), world, live),
        "pool_with_cheater": evaluate(fit(*pooled(own, *logs, cheat)), world, live),
        "pool_with_cheater_verified": evaluate(fit(*pooled(own, *logs, cheat, verified=True)), world, live),
        "ceiling": evaluate(fit(*public), world, world["x"]),
    }
    atlas = logs[0]
    clone = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, random_state=0)
    traded = atlas["action"] != 0
    clone.fit(atlas["x"][traded], atlas["action"][traded])
    leak_models = {
        "outcome_pool": pool,
        "pool_without_provider": fit(*pooled(own, *logs[1:])),
        "public_only": fit(*public, cols=PUBLIC_COLS),
        "behaviour_clone": (_Signed(clone), ALL_COLS, 0.0),
    }
    return {
        "scenarios": scenarios,
        "providers": {g["agent"]: {"verified_sharpe": track_record(world, g, claimed=False),
                                   "claimed_sharpe": track_record(world, g, claimed=True),
                                   "records": int(len(g["y"]))} for g in [*logs, cheat]},
        "shapley": shapley(world, own, logs, live),
        "shapley_unverified_cheater": shapley(world, own, [*logs, cheat], live),
        "membership": membership(world, own, logs[1:], live, atlas, seed),
        "strategy_leak": strategy_leak(world, leak_models, atlas),
    }


class _Signed:
    """Exposes a classifier of trade direction through the regressor interface used above."""

    def __init__(self, classifier):
        self.classifier = classifier

    def predict(self, x):
        return self.classifier.predict(x).astype(float)


def mean_std(values):
    return {"mean": float(np.mean(values)), "std": float(np.std(values))}


def aggregate(runs):
    def walk(items):
        first = items[0]
        if isinstance(first, dict):
            return {k: walk([it[k] for it in items]) for k in first}
        return mean_std(items)
    return walk(runs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=10)
    ap.add_argument("--out", default="runs")
    args = ap.parse_args()
    runs = [run(seed) for seed in range(1, args.seeds + 1)]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps({"seeds": args.seeds, "runs": runs, "summary": aggregate(runs)}, indent=2))
    print(f"{args.seeds} seeds -> {out / 'results.json'}")


if __name__ == "__main__":
    main()
