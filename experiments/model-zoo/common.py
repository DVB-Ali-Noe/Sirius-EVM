"""Shared quality metrics, extraction attacks and result aggregation for the model zoo.

Threat model: Sirius delivers the trained model to the borrower, so every attack assumes white-box access to the
model plus a reference population drawn from the same distribution (the borrower's own or public data).
"""
import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score, roc_curve

RESULTS = Path(__file__).resolve().parent / "results"
EPS = 1e-6

# "free" is what an unconstrained data scientist would ship; "capped" is the profile Sirius would impose;
# "strict" trades quality for a larger floor of records per leaf
GBDT = {
    "free": dict(max_iter=500, learning_rate=0.1, max_leaf_nodes=63, min_samples_leaf=1, l2_regularization=0.0),
    "capped": dict(max_iter=300, learning_rate=0.05, max_depth=3, min_samples_leaf=200, l2_regularization=1.0),
    "strict": dict(max_iter=300, learning_rate=0.05, max_depth=2, min_samples_leaf=1000, l2_regularization=1.0),
}


def gbdt(kind, capacity, **extra):
    cls = HistGradientBoostingClassifier if kind == "clf" else HistGradientBoostingRegressor
    return cls(early_stopping=False, random_state=0, **GBDT[capacity], **extra)


def logloss(y, p):
    p = np.clip(p, EPS, 1 - EPS)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def ece(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    return float(sum(abs(y[idx == b].mean() - p[idx == b].mean()) * (idx == b).mean() for b in range(bins) if (idx == b).any()))


def brier(y, p):
    return float(((p - y) ** 2).mean())


def auto_coverage(y, p, max_error=0.05):
    """Largest share of cases, most confident first, that can be decided automatically under max_error."""
    order = np.argsort(-np.abs(p - 0.5))
    wrong = ((p[order] > 0.5) != y[order]).cumsum() / np.arange(1, len(y) + 1)
    ok = np.nonzero(wrong <= max_error)[0]
    return float((ok[-1] + 1) / len(y)) if len(ok) else 0.0


def tpr_at_fpr(labels, scores, fpr=0.01):
    f, t, _ = roc_curve(labels, scores)
    return float(np.interp(fpr, f, t))


def membership(loss_in, loss_out, ref_in=None, ref_out=None):
    """Loss-threshold attack, and its reference-calibrated version (loss under a model that never saw the record minus
    loss under the delivered model), which removes how easy the record is and keeps what training added."""
    labels = np.r_[np.ones(len(loss_in)), np.zeros(len(loss_out))]
    raw = -np.r_[loss_in, loss_out]
    out = {"auc": float(roc_auc_score(labels, raw)), "tpr_1fpr": tpr_at_fpr(labels, raw)}
    if ref_in is not None:
        cal = np.r_[ref_in - loss_in, ref_out - loss_out]
        out |= {"auc_cal": float(roc_auc_score(labels, cal)), "tpr_1fpr_cal": tpr_at_fpr(labels, cal),
                "tpr_01fpr_cal": tpr_at_fpr(labels, cal, 0.001)}
    return out


def canary_exposure(loss_injected, loss_control, hit_injected, hit_control):
    """Canaries are unique out-of-pattern records labelled against the population pattern; hit = the model reproduces
    that surprising label. Controls are never trained on, so their hit rate is the chance level."""
    labels = np.r_[np.ones(len(loss_injected)), np.zeros(len(loss_control))]
    return {"auc": float(roc_auc_score(labels, -np.r_[loss_injected, loss_control])),
            "extracted": float(np.mean(hit_injected)), "control_hits": float(np.mean(hit_control))}


def canaries(rng, reference, k=40):
    """Unique records: every feature drawn independently inside the population's 1-99 % range, which breaks the joint
    pattern real records follow. Half are injected, half kept as controls."""
    lo, hi = np.quantile(reference, 0.01, axis=0), np.quantile(reference, 0.99, axis=0)
    x = rng.uniform(lo, hi, size=(k, reference.shape[1]))
    return x[: k // 2], x[k // 2:]


def hist_nodes(model):
    return [p.nodes for trees in model._predictors for p in trees]


def tree_artifacts(splits, leaf_counts, reference, q=0.001):
    """White-box leaks readable in the delivered file.

    tail_splits: thresholds beyond the reference population's 0.1 % / 99.9 % quantiles; each one proves that some
    training record has an extreme value there. small_leaves: leaves built on fewer than 5 records, whose value is
    close to those records' labels."""
    lo, hi = np.quantile(reference, q, axis=0), np.quantile(reference, 1 - q, axis=0)
    tail = sum(int(t < lo[f] or t > hi[f]) for f, t in splits)
    out = {"splits": len(splits), "tail_splits": tail}
    if leaf_counts is not None:
        leaf_counts = np.asarray(leaf_counts)
        out |= {"min_leaf_records": int(leaf_counts.min()), "small_leaves": float((leaf_counts < 5).mean())}
    return out


def hist_artifacts(model, reference):
    nodes = hist_nodes(model)
    splits = [(int(n["feature_idx"]), float(n["num_threshold"])) for ns in nodes for n in ns if not n["is_leaf"]]
    leaves = [int(n["count"]) for ns in nodes for n in ns if n["is_leaf"]]
    return tree_artifacts(splits, leaves, reference) | {"counts_exported": True}


def binary_quality(y, p):
    return {"auc": float(roc_auc_score(y, p)), "brier": brier(y, p), "ece": ece(y, p), "auto_5pct": auto_coverage(y, p)}


def binary_study(factories, data, rng, artifacts=None, extra=None):
    """Quality, membership inference, canaries (injected once and five times) and white-box artifacts for each
    binary classifier. data: members / nonmembers / reference / test, each a (X, y) pair."""
    (xm, ym), (xn, yn), (xr, yr), (xt, yt) = data["members"], data["nonmembers"], data["reference"], data["test"]
    inj, ctl = canaries(rng, xr)
    # each canary gets the label the population pattern does not predict for it
    pattern = gbdt("clf", "capped").fit(xr, yr)
    inj_y, ctl_y = ((pattern.predict_proba(c)[:, 1] <= 0.5).astype(int) for c in (inj, ctl))
    out = {}
    for name, factory in factories.items():
        ref = factory().fit(xr, yr)
        res = {}
        for rep in (1, 5):
            model = factory().fit(np.r_[xm, np.repeat(inj, rep, axis=0)], np.r_[ym, np.repeat(inj_y, rep)])
            p_inj, p_ctl = model.predict_proba(inj)[:, 1], model.predict_proba(ctl)[:, 1]
            res[f"canary_x{rep}"] = canary_exposure(logloss(inj_y, p_inj), logloss(ctl_y, p_ctl),
                                                    (p_inj > 0.5) == inj_y, (p_ctl > 0.5) == ctl_y)
            if rep == 1:
                pm, pn = model.predict_proba(xm)[:, 1], model.predict_proba(xn)[:, 1]
                pt = model.predict_proba(xt)[:, 1]
                res["quality"] = binary_quality(yt, pt) | (extra(yt, pt) if extra else {})
                res["train_auc"] = float(roc_auc_score(ym, pm))
                res["membership"] = membership(logloss(ym, pm), logloss(yn, pn),
                                               logloss(ym, ref.predict_proba(xm)[:, 1]),
                                               logloss(yn, ref.predict_proba(xn)[:, 1]))
                if artifacts:
                    found = artifacts(model, xr)
                    if found:
                        res["artifacts"] = found
        out[name] = res
    return out


def aggregate(runs):
    first = runs[0]
    if isinstance(first, dict):
        return {k: aggregate([r[k] for r in runs]) for k in first}
    if isinstance(first, bool):
        return first
    return {"mean": float(np.mean(runs)), "std": float(np.std(runs))}


def save(name, runs, notes=None):
    RESULTS.mkdir(exist_ok=True)
    payload = {"seeds": len(runs), "summary": aggregate(runs), "runs": runs, "notes": notes or {}}
    (RESULTS / f"{name}.json").write_text(json.dumps(payload, indent=2))
    print(f"{name}: {len(runs)} seeds -> results/{name}.json")
    return payload
