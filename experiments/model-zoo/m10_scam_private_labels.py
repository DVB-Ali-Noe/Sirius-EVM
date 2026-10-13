# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M10, scam classifier trained on an exchange's private list of confirmed scam wallets.

Features are public on-chain behaviour; only the labels are private. Compares what anyone can build (Isolation Forest,
classifier on public reports) with what Sirius would deliver (classifier on private labels). The secret worth
protecting is "this wallet is in the exchange's private list": attacked on wallets confirmed privately but never
reported publicly, both through the score itself and through membership inference.
Usage: uv run m10_scam_private_labels.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

from common import canaries, canary_exposure, gbdt, hist_artifacts, logloss, membership, save
from wallets import label_sets, wallets


def scores(model, x):
    return -model.score_samples(x) if isinstance(model, IsolationForest) else model.predict_proba(x)[:, 1]


def detection(kind, score, share=0.01):
    truth = (kind > 0).astype(int)
    top = np.argsort(-score)[: int(len(kind) * share)]
    return {
        "auc": float(roc_auc_score(truth, score)),
        "auc_subtle": float(roc_auc_score((kind[kind != 1] == 2).astype(int), score[kind != 1])),
        "precision_top1pct": float(truth[top].mean()),
        "recall_top1pct": float(truth[top].sum() / truth.sum()),
        "recall_subtle_top1pct": float((kind[top] == 2).sum() / (kind == 2).sum()),
    }


def run(seed):
    rng = np.random.default_rng(seed)
    sets = {}
    for name, n in (("members", 40_000), ("nonmembers", 40_000), ("reference", 40_000), ("test", 60_000)):
        x, kind = wallets(rng, n)
        sets[name] = (x, kind, *label_sets(rng, kind))
    xa, ka = wallets(rng, 60_000, adapted=True)
    (xm, km, pubm, privm), (xn, kn, pubn, privn), (xr, kr, pubr, privr), (xt, kt, _, _) = (
        sets[k] for k in ("members", "nonmembers", "reference", "test"))
    inj, ctl = canaries(rng, xr)
    out = {}
    builders = {
        "isolation_forest": (lambda: IsolationForest(n_estimators=200, max_samples=256, random_state=0), None),
        "gbdt_public_labels": (lambda: gbdt("clf", "capped"), "public"),
        "gbdt_private_capped": (lambda: gbdt("clf", "capped"), "private"),
        "gbdt_private_strict": (lambda: gbdt("clf", "strict"), "private"),
        "gbdt_private_free": (lambda: gbdt("clf", "free"), "private"),
    }
    for name, (factory, labels) in builders.items():
        y = {"public": pubm, "private": privm}.get(labels)
        model = factory().fit(xm) if y is None else factory().fit(xm, y)
        res = {"quality": detection(kt, scores(model, xt)),
               "after_adaptation": detection(ka, scores(model, xa))}
        if labels == "private":
            # wallets the exchange confirmed but nobody reported: the secret
            secret_m, secret_n = (privm == 1) & (pubm == 0), (privn == 1) & (pubn == 0)
            threshold = np.quantile(scores(model, xt), 0.99)
            res["secret_flagged_members"] = float((scores(model, xm[secret_m]) > threshold).mean())
            res["secret_flagged_nonmembers"] = float((scores(model, xn[secret_n]) > threshold).mean())
            # strongest attacker: another holder of a private list trains the same model on its own wallets
            ref = factory().fit(xr, privr)
            loss = lambda m, x, yy: logloss(yy, m.predict_proba(x)[:, 1])
            res["membership_all"] = membership(loss(model, xm, privm), loss(model, xn, privn),
                                               loss(ref, xm, privm), loss(ref, xn, privn))
            res["membership_secret"] = membership(loss(model, xm[secret_m], privm[secret_m]),
                                                  loss(model, xn[secret_n], privn[secret_n]),
                                                  loss(ref, xm[secret_m], privm[secret_m]),
                                                  loss(ref, xn[secret_n], privn[secret_n]))
            res["artifacts"] = hist_artifacts(model, xr)
            # canaries labelled as scams: arbitrary wallets the exchange flagged for reasons the features do not show
            for rep in (1, 5):
                cm = factory().fit(np.r_[xm, np.repeat(inj, rep, axis=0)], np.r_[privm, np.ones(len(inj) * rep, int)])
                pi, pc = cm.predict_proba(inj)[:, 1], cm.predict_proba(ctl)[:, 1]
                res[f"canary_x{rep}"] = canary_exposure(logloss(1, pi), logloss(1, pc), pi > 0.5, pc > 0.5)
        out[name] = res
    out["scam_rate"] = float((kt > 0).mean())
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m10_scam_private_labels", [run(s) for s in range(1, args.seeds + 1)])
