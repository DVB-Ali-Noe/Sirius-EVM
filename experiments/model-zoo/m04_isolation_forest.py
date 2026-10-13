# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M04, Isolation Forest on lent wallet activity: unsupervised scam detection, no labels needed.

Quality is scored against the hidden truth, separately for blatant and subtle scams. Membership is attacked on the
anomalous wallets, which isolation trees are built to single out.
Usage: uv run m04_isolation_forest.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

from common import canaries, membership, save, tree_artifacts
from wallets import wallets

CONFIGS = {
    "standard": dict(n_estimators=200, max_samples=256),
    "free": dict(n_estimators=200, max_samples=1.0),
}


def precision_at(y, score, share=0.01):
    top = np.argsort(-score)[: int(len(y) * share)]
    return float(y[top].mean())


def recall_at(y, score, share=0.01):
    top = np.argsort(-score)[: int(len(y) * share)]
    return float(y[top].sum() / max(y.sum(), 1))


def artifacts(model, reference):
    splits, leaves = [], []
    for tree, feats in zip(model.estimators_, model.estimators_features_):
        t = tree.tree_
        inner = t.children_left != -1
        splits += [(int(feats[f]), float(th)) for f, th in zip(t.feature[inner], t.threshold[inner])]
        leaves += list(t.n_node_samples[~inner])
    return tree_artifacts(splits, leaves, reference) | {"counts_exported": True}


def run(seed):
    rng = np.random.default_rng(seed)
    (xm, km), (xn, kn), (xr, _), (xt, kt) = (wallets(rng, n) for n in (20_000, 20_000, 20_000, 50_000))
    xa, ka = wallets(rng, 50_000, adapted=True)
    inj, ctl = canaries(rng, xr)
    out = {}
    for name, cfg in CONFIGS.items():
        ref = IsolationForest(random_state=0, **cfg).fit(xr)
        res = {}
        for rep in (1, 5):
            model = IsolationForest(random_state=0, **cfg).fit(np.r_[xm, np.repeat(inj, rep, axis=0)])
            # score_samples is higher for normal points, so -score plays the role of a loss
            si, sc = model.score_samples(inj), model.score_samples(ctl)
            labels = np.r_[np.ones(len(si)), np.zeros(len(sc))]
            res[f"canary_x{rep}"] = {"auc": float(roc_auc_score(labels, -np.r_[si, sc]))}
            if rep > 1:
                continue
            anomaly = -model.score_samples(xt)
            truth = (kt > 0).astype(int)
            res["quality"] = {
                "auc": float(roc_auc_score(truth, anomaly)),
                "auc_blatant": float(roc_auc_score((kt[kt != 2] == 1).astype(int), anomaly[kt != 2])),
                "auc_subtle": float(roc_auc_score((kt[kt != 1] == 2).astype(int), anomaly[kt != 1])),
                "precision_top1pct": precision_at(truth, anomaly),
                "recall_top1pct": recall_at(truth, anomaly),
                "auc_after_adaptation": float(roc_auc_score((ka > 0).astype(int), -model.score_samples(xa))),
            }
            # signal = how much more "normal" the delivered model finds a record than a model that never saw it
            loss = lambda m, x: -m.score_samples(x)
            res["membership_all"] = membership(loss(model, xm), loss(model, xn), loss(ref, xm), loss(ref, xn))
            am, an = km > 0, kn > 0
            res["membership_scams"] = membership(loss(model, xm[am]), loss(model, xn[an]),
                                                 loss(ref, xm[am]), loss(ref, xn[an]))
            res["artifacts"] = artifacts(model, xr)
        out[name] = res
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m04_isolation_forest", [run(s) for s in range(1, args.seeds + 1)])
