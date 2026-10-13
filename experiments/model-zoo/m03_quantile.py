# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6", "scipy>=1.14"]
# ///
"""M03, P10 / P50 / P90 forecast of the next-hour return of a perpetual, trained on another desk's history.

The noise is heavy-tailed and its scale depends on volatility regime and liquidation flow, which is where a fixed
band fails. Compares unconditional quantiles, a Gaussian band around a linear mean, linear quantile regression and
boosted quantile trees, unconstrained and capped.
Usage: uv run m03_quantile.py --seeds 5
"""
import argparse

import numpy as np
from scipy.stats import norm
from sklearn.linear_model import LinearRegression, QuantileRegressor
from sklearn.metrics import roc_auc_score

from common import canaries, gbdt, hist_artifacts, membership, save

QUANTILES = (0.1, 0.5, 0.9)
FEATURES = ["realized_vol", "funding_rate", "oi_change", "momentum", "hour_sin", "liquidations"]


def desk_history(rng, n):
    vol = rng.lognormal(0, 0.5, n)
    funding = rng.normal(0, 1, n)
    oi = rng.normal(0, 1, n)
    momentum = rng.normal(0, 1, n)
    hour = np.sin(rng.uniform(0, 2 * np.pi, n))
    liquidations = rng.exponential(1, n)
    mu = 0.15 * np.tanh(momentum) - 0.1 * funding * (oi > 0)
    sigma = 0.5 * vol * (1 + 0.8 * (liquidations > 2)) * (1 + 0.2 * hour)
    y = mu + sigma * rng.standard_t(4, n) / np.sqrt(2)
    return np.column_stack([vol, funding, oi, momentum, hour, liquidations]), y


def pinball(y, q_pred, q):
    d = y - q_pred
    return np.maximum(q * d, (q - 1) * d)


class Band:
    """One model per quantile, sharing a predict(x) -> (n, 3) interface."""

    def __init__(self, kind):
        self.kind = kind

    def fit(self, x, y):
        if self.kind == "unconditional":
            self.q = np.quantile(y, QUANTILES)
        elif self.kind == "gaussian_linear":
            self.mean = LinearRegression().fit(x, y)
            self.std = (y - self.mean.predict(x)).std()
        elif self.kind == "linear_quantile":
            self.models = [QuantileRegressor(quantile=q, alpha=0.0, solver="highs").fit(x, y) for q in QUANTILES]
        else:
            capacity = self.kind.removeprefix("gbdt_")
            self.models = [gbdt("reg", capacity, loss="quantile", quantile=q).fit(x, y) for q in QUANTILES]
        return self

    def predict(self, x):
        if self.kind == "unconditional":
            return np.tile(self.q, (len(x), 1))
        if self.kind == "gaussian_linear":
            m = self.mean.predict(x)[:, None]
            return m + self.std * norm.ppf(QUANTILES)[None, :]
        return np.column_stack([m.predict(x) for m in self.models])

    def loss(self, x, y):
        pred = self.predict(x)
        return sum(pinball(y, pred[:, i], q) for i, q in enumerate(QUANTILES))


def quality(model, x, y):
    pred = model.predict(x)
    inside = (y >= pred[:, 0]) & (y <= pred[:, 2])
    stressed = x[:, 0] > np.quantile(x[:, 0], 0.9)
    return {
        "pinball": float(model.loss(x, y).mean()),
        "coverage_80": float(inside.mean()),
        "coverage_80_high_vol": float(inside[stressed].mean()),
        "coverage_80_calm": float(inside[x[:, 0] < np.quantile(x[:, 0], 0.5)].mean()),
        "width": float((pred[:, 2] - pred[:, 0]).mean()),
        "crossing": float(((pred[:, 0] > pred[:, 1]) | (pred[:, 1] > pred[:, 2])).mean()),
    }


def run(seed, kinds):
    rng = np.random.default_rng(seed)
    (xm, ym), (xn, yn), (xr, yr), (xt, yt) = (desk_history(rng, n) for n in (8_000, 8_000, 8_000, 20_000))
    inj, ctl = canaries(rng, xr)
    # a canary is a unique crash: an ordinary-looking context followed by an 8-sigma move
    inj_y, ctl_y = rng.choice([-1, 1], len(inj)) * 8.0, rng.choice([-1, 1], len(ctl)) * 8.0
    out = {}
    for kind in kinds:
        ref = Band(kind).fit(xr, yr)
        res = {}
        for rep in (1, 5):
            model = Band(kind).fit(np.r_[xm, np.repeat(inj, rep, axis=0)], np.r_[ym, np.repeat(inj_y, rep)])
            li, lc = model.loss(inj, inj_y), model.loss(ctl, ctl_y)
            pi, pc = model.predict(inj), model.predict(ctl)
            # extracted: the band was widened enough at that exact point to contain the crash
            hit_i = (inj_y >= pi[:, 0]) & (inj_y <= pi[:, 2])
            hit_c = (ctl_y >= pc[:, 0]) & (ctl_y <= pc[:, 2])
            labels = np.r_[np.ones(len(li)), np.zeros(len(lc))]
            res[f"canary_x{rep}"] = {"auc": float(roc_auc_score(labels, -np.r_[li, lc])),
                                     "extracted": float(hit_i.mean()), "control_hits": float(hit_c.mean())}
            if rep == 1:
                res["quality"] = quality(model, xt, yt)
                res["membership"] = membership(model.loss(xm, ym), model.loss(xn, yn), ref.loss(xm, ym), ref.loss(xn, yn))
                if kind.startswith("gbdt"):
                    arts = [hist_artifacts(m, xr) for m in model.models]
                    res["artifacts"] = {k: (max(a[k] for a in arts) if k in ("tail_splits", "small_leaves") else
                                            min(a[k] for a in arts) if k == "min_leaf_records" else arts[0][k])
                                        for k in arts[0]}
        out[kind] = res
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    kinds = ["unconditional", "gaussian_linear", "linear_quantile", "gbdt_capped", "gbdt_free"]
    save("m03_quantile", [run(s, kinds) for s in range(1, args.seeds + 1)], {"features": FEATURES})
