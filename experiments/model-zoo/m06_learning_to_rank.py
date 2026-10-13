# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6", "lightgbm>=4.5"]
# ///
"""M06, learning-to-rank for an orchestrator (Butler-like): order 10 candidate agents for each incoming task.

Public features (rating, price, latency, category match, volume) are on ACP; the orchestrator also holds off-chain
satisfaction per requester segment and recent silent failures. Compares a rating sort, a ranker on a public scrape
and LambdaMART on the lent private history, unconstrained and capped. Membership is attacked per task (query).
Usage: uv run m06_learning_to_rank.py --seeds 5
"""
import argparse

import lightgbm as lgb
import numpy as np
from sklearn.metrics import ndcg_score, roc_auc_score

from common import membership, save, tree_artifacts

CANDIDATES = 10
PUBLIC = ["rating", "price_ratio", "latency", "category_match", "log_jobs"]
PRIVATE = ["segment_satisfaction", "silent_failures"]
RANKERS = {
    "capped": dict(n_estimators=300, learning_rate=0.05, num_leaves=7, min_child_samples=200, reg_lambda=1.0),
    "free": dict(n_estimators=500, learning_rate=0.1, num_leaves=63, min_child_samples=2, min_child_weight=1e-3),
}


def tasks(rng, n):
    k = n * CANDIDATES
    rating = np.clip(rng.normal(4.1, 0.5, k), 1, 5)
    price = rng.lognormal(0, 0.4, k)
    latency = rng.lognormal(1, 0.5, k)
    match = rng.random(k) < 0.6
    jobs = rng.normal(3, 1.2, k)
    satisfaction = rng.normal(0, 1, k)
    failures = rng.beta(1, 10, k)
    urgency = np.repeat(rng.random(n) < 0.3, CANDIDATES)
    utility = (0.6 * (rating - 4) - 0.5 * np.log(price) - 0.4 * np.log(latency) * (1 + 2 * urgency) + 0.8 * match
               + 0.9 * satisfaction - 4 * failures + 0.1 * jobs + rng.normal(0, 0.5, k))
    x = np.column_stack([rating, price, latency, match, jobs, satisfaction, failures]).astype(float)
    # graded relevance inside each task: 3 for the best candidate, then 2, 1 and 0 for the rest
    order = np.argsort(np.argsort(-utility.reshape(n, CANDIDATES), axis=1), axis=1)
    rel = np.select([order == 0, order <= 2, order <= 4], [3, 2, 1], 0).ravel()
    return x, rel, utility


def ndcg(rel, score, k):
    return np.array([ndcg_score([r], [s], k=k) for r, s in zip(rel.reshape(-1, CANDIDATES), score.reshape(-1, CANDIDATES))])


def quality(rel, utility, score):
    r, u, s = (a.reshape(-1, CANDIDATES) for a in (rel, utility, score))
    chosen = u[np.arange(len(u)), s.argmax(axis=1)]
    return {"ndcg1": float(ndcg(rel, score, 1).mean()), "ndcg3": float(ndcg(rel, score, 3).mean()),
            "top1_hit": float((r[np.arange(len(r)), s.argmax(axis=1)] == 3).mean()),
            "regret": float((u.max(axis=1) - chosen).mean())}


def ranker(capacity, x, rel):
    groups = np.full(len(rel) // CANDIDATES, CANDIDATES)
    return lgb.LGBMRanker(objective="lambdarank", random_state=0, verbose=-1, **RANKERS[capacity]).fit(x, rel, group=groups)


def artifacts(model, reference):
    splits, leaves = [], []

    def walk(node):
        if "split_feature" not in node:
            leaves.append(node.get("leaf_count", node.get("internal_count", 0)))
            return
        splits.append((node["split_feature"], float(node["threshold"])))
        walk(node["left_child"])
        walk(node["right_child"])

    for tree in model.booster_.dump_model()["tree_info"]:
        walk(tree["tree_structure"])
    return tree_artifacts(splits, leaves, reference) | {"counts_exported": True}


def run(seed):
    rng = np.random.default_rng(seed)
    (xm, rm, _), (xn, rn, _), (xr, rr, _), (xt, rt, ut) = (tasks(rng, n) for n in (3_000, 3_000, 3_000, 5_000))
    xs, rs, _ = tasks(rng, 15_000)
    pub = slice(0, len(PUBLIC))
    out = {
        "rating_sort": {"quality": quality(rt, ut, xt[:, 0])},
        "public_scrape_ranker": {"quality": quality(rt, ut, ranker("capped", xs[:, pub], rs).predict(xt[:, pub]))},
    }
    # canary tasks: 20 random tasks whose grades are a random permutation, half injected
    xc, _, _ = tasks(rng, 40)
    rc = np.concatenate([rng.permutation([3, 2, 2, 1, 1, 0, 0, 0, 0, 0]) for _ in range(40)])
    split = 20 * CANDIDATES
    for capacity in RANKERS:
        ref = ranker(capacity, xr, rr)
        res = {}
        for rep in (1, 5):
            model = ranker(capacity, np.r_[xm, np.tile(xc[:split], (rep, 1))], np.r_[rm, np.tile(rc[:split], rep)])
            hit = lambda x, r: (r.reshape(-1, CANDIDATES)[np.arange(len(r) // CANDIDATES),
                                                          model.predict(x).reshape(-1, CANDIDATES).argmax(axis=1)] == 3)
            ni, nc = ndcg(rc[:split], model.predict(xc[:split]), 3), ndcg(rc[split:], model.predict(xc[split:]), 3)
            res[f"canary_x{rep}"] = {
                "auc": float(roc_auc_score(np.r_[np.ones(len(ni)), np.zeros(len(nc))], np.r_[ni, nc])),
                "extracted": float(hit(xc[:split], rc[:split]).mean()), "control_hits": float(hit(xc[split:], rc[split:]).mean())}
            if rep > 1:
                continue
            res["quality"] = quality(rt, ut, model.predict(xt))
            # per task, the loss is 1 - NDCG@3; reference = attacker's ranker trained on its own tasks
            loss = lambda m, x, r: 1 - ndcg(r, m.predict(x), 3)
            res["membership"] = membership(loss(model, xm, rm), loss(model, xn, rn), loss(ref, xm, rm), loss(ref, xn, rn))
            res["train_ndcg3"] = float(ndcg(rm, model.predict(xm), 3).mean())
            res["artifacts"] = artifacts(model, xr)
        out[f"lambdamart_private_{capacity}"] = res
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m06_learning_to_rank", [run(s) for s in range(1, args.seeds + 1)], {"public": PUBLIC, "private": PRIVATE})
