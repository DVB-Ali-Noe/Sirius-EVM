# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M09, cooperative model over several agents' private experience logs (extends ../agent-experience-lending).

Three attacks on the pool: rebuilding a provider's private sentiment from the delivered model (attribute inference),
a copier who re-submits a provider's records to capture part of its payment, and a free rider who commits honestly
but logs worthless context.
Usage: uv run m09_cooperative.py --seeds 5
"""
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent-experience-lending"))

from lend import evaluate, fit, pooled, shapley  # noqa: E402
from world import BORROWER, F_COL, PROVIDERS, S_COL, experience, market  # noqa: E402

from common import save  # noqa: E402

GRID = np.linspace(-3, 3, 25)


def invert_sentiment(model, x, y):
    """Attacker knows public features and the outcome (both public on-chain) and searches the sentiment that best
    explains the outcome; the other ephemeral feature is set to its mean."""
    best, best_err = np.zeros(len(y)), np.full(len(y), np.inf)
    for s in GRID:
        probe = x.copy()
        probe[:, S_COL], probe[:, F_COL] = s, 0.0
        err = (model.predict(probe) - y) ** 2
        better = err < best_err
        best[better], best_err[better] = s, err[better]
    return best


def attribute_inference(own, logs, rng):
    atlas = logs[0]
    member = rng.random(len(atlas["y"])) < 0.5
    half = {k: atlas[k][member] for k in ("x", "y", "t", "commit")}
    with_atlas, _, _ = fit(*pooled(own, half, *logs[1:]))
    without, _, _ = fit(*pooled(own, *logs[1:]))
    # the truth is what Atlas logged, i.e. its own noisy view of sentiment
    truth, x, y = atlas["x"][:, S_COL], atlas["x"], atlas["y"]
    corr = lambda guess, mask: float(np.corrcoef(guess[mask], truth[mask])[0, 1])
    g_with, g_without = invert_sentiment(with_atlas, x, y), invert_sentiment(without, x, y)
    return {"members": corr(g_with, member), "nonmembers": corr(g_with, ~member),
            "reference_model": corr(g_without, member),
            "sign_accuracy_members": float((np.sign(g_with[member]) == np.sign(truth[member])).mean())}


def copier(log, rng):
    """A provider re-submitting another provider's records with a little jitter, under its own name."""
    copy = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in log.items()}
    copy["agent"] = "Copycat"
    copy["x"][:, [S_COL, F_COL]] += 0.05 * rng.normal(size=(len(copy["y"]), 2))
    return copy


def free_rider(log, rng):
    rider = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in log.items()}
    rider["agent"] = "FreeRider"
    rider["x"][:, [S_COL, F_COL]] = rng.normal(size=(len(rider["y"]), 2))
    return rider


def run(seed):
    rng = np.random.default_rng(seed)
    world = market(seed)
    own = experience(world, BORROWER, seed * 100)
    live = own["live"]
    logs = [experience(world, p, seed * 100 + i + 1) for i, p in enumerate(PROVIDERS)]
    rider_source = experience(world, PROVIDERS[1], seed * 100 + 50)
    return {
        "pool_test": evaluate(fit(*pooled(own, *logs)), world, live),
        "attribute_inference": attribute_inference(own, logs, rng),
        "shapley_honest": shapley(world, own, logs, live),
        "shapley_with_copier": shapley(world, own, [*logs, copier(logs[0], rng)], live),
        "shapley_with_free_rider": shapley(world, own, [*logs, free_rider(rider_source, rng)], live),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m09_cooperative", [run(s) for s in range(1, args.seeds + 1)])
