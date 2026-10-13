# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6"]
# ///
"""M08, trading signals from a card-spending panel lent by an alternative-data vendor, for tokenized stocks.

The panel nowcasts each company's weekly revenue growth, which the market only learns at quarterly reports. The
question is not only quality but delivery: a model that needs the panel as input is useless to a borrower who does not
have the panel, so three deliveries are compared (model only, public-input model, signals computed in the enclave).
For enclave signals, the attacker is the borrower trying to rebuild the vendor's panel, which is the vendor's product,
by inverting the signals with the growth that quarterly reports later make public.
Usage: uv run m08_alt_data_signals.py --seeds 5
"""
import argparse

import numpy as np
from sklearn.linear_model import LinearRegression

from common import gbdt, save

COMPANIES, WEEKS, TRAIN_WEEKS, QUARTER = 60, 312, 208, 13
FEATURES = ["mom4", "mom12", "sector", "reported_growth", "panel_growth", "panel_change"]
PANEL_COLS = [4, 5]


def market(rng):
    common = np.zeros(WEEKS)
    growth = np.zeros((WEEKS, COMPANIES))
    for t in range(1, WEEKS):
        common[t] = 0.8 * common[t - 1] + 0.6 * rng.normal()
        growth[t] = 0.85 * growth[t - 1] + 0.5 * common[t] + rng.normal(size=COMPANIES)
    panel = growth + 0.5 * rng.normal(size=growth.shape)  # sampling noise of a finite panel
    # the market prices last quarter's report, not this week's growth
    reported = np.zeros_like(growth)
    for t in range(WEEKS):
        q_end = (t // QUARTER) * QUARTER - 1
        reported[t] = growth[max(q_end - QUARTER + 1, 0):q_end + 1].mean(axis=0) if q_end > 0 else 0
    surprise = growth - reported
    returns = np.zeros_like(growth)
    returns[1:] = 0.12 * surprise[:-1] / surprise.std() + rng.normal(size=(WEEKS - 1, COMPANIES))
    sector = np.tile(np.arange(COMPANIES) % 6, (WEEKS, 1)).astype(float)
    x = np.zeros((WEEKS, COMPANIES, len(FEATURES)))
    for t in range(12, WEEKS):
        x[t, :, 0] = returns[t - 3:t + 1].sum(axis=0)
        x[t, :, 1] = returns[t - 11:t + 1].sum(axis=0)
        x[t, :, 2] = sector[t]
        x[t, :, 3] = reported[t]
        x[t, :, 4] = panel[t]
        x[t, :, 5] = panel[t] - panel[t - 4]
    y = np.full_like(returns, np.nan)
    y[:-1] = returns[1:]
    return x, y, panel, growth, reported


def flat(x, y, weeks):
    return x[weeks].reshape(-1, x.shape[-1]), y[weeks].ravel()


def ic(pred, y):
    return float(np.corrcoef(pred, y)[0, 1])


def long_short(signal, y, weeks):
    """Weekly long top quintile / short bottom quintile, annualised Sharpe. Ties (coarse signals) share the bucket."""
    s, r = signal.reshape(len(weeks), COMPANIES), y.reshape(len(weeks), COMPANIES)
    lo, hi = np.quantile(s, 0.2, axis=1, keepdims=True), np.quantile(s, 0.8, axis=1, keepdims=True)
    pnl = np.array([r[i][s[i] >= hi[i]].mean() - r[i][s[i] <= lo[i]].mean() if (s[i] > lo[i]).any() else 0.0
                    for i in range(len(weeks))])
    return float(pnl.mean() / (pnl.std() + 1e-12) * np.sqrt(52))


def scored(signal, y, weeks):
    return {"ic": ic(signal, y), "long_short_sharpe": long_short(signal, y, weeks)}


def coarse(signal, weeks):
    """Only the top and bottom quintile per week, as +1 / -1."""
    s = signal.reshape(len(weeks), COMPANIES)
    lo, hi = np.quantile(s, 0.2, axis=1, keepdims=True), np.quantile(s, 0.8, axis=1, keepdims=True)
    return (np.where(s >= hi, 1.0, np.where(s <= lo, -1.0, 0.0))).ravel()


def reconstruction(signal, x, growth, panel, weeks, public_cols):
    """Borrower learns signal -> growth on quarters already reported, then rebuilds the panel on the others."""
    s = signal.reshape(len(weeks), COMPANIES)
    revealed = weeks < weeks[0] + (len(weeks) // 2)
    feats = np.dstack([s, x[weeks][:, :, public_cols]])
    a = feats[revealed].reshape(-1, feats.shape[-1])
    inv = LinearRegression().fit(a, growth[weeks][revealed].ravel())
    b = feats[~revealed].reshape(-1, feats.shape[-1])
    rebuilt = inv.predict(b)
    target = panel[weeks][~revealed].ravel()
    baseline = LinearRegression().fit(x[weeks][revealed][:, :, public_cols].reshape(-1, len(public_cols)),
                                      growth[weeks][revealed].ravel()).predict(
        x[weeks][~revealed][:, :, public_cols].reshape(-1, len(public_cols)))
    corr = lambda p: float(np.corrcoef(p, target)[0, 1])
    return {"panel_corr": corr(rebuilt), "panel_corr_public_only": corr(baseline)}


def run(seed):
    rng = np.random.default_rng(seed)
    x, y, panel, growth, reported = market(rng)
    train, test = np.arange(12, TRAIN_WEEKS), np.arange(TRAIN_WEEKS, WEEKS - 1)
    xtr, ytr = flat(x, y, train)
    xte, yte = flat(x, y, test)
    public = [0, 1, 2, 3]
    full = gbdt("reg", "capped").fit(xtr, ytr)
    pub_model = gbdt("reg", "capped").fit(xtr[:, public], ytr)
    blind = xte.copy()
    blind[:, PANEL_COLS] = xtr[:, PANEL_COLS].mean(axis=0)  # borrower has no panel: fills with the training mean
    signal = full.predict(xte)
    delayed = np.roll(signal.reshape(len(test), COMPANIES), 1, axis=0)
    delayed[0] = 0
    delayed = delayed.ravel()
    return {
        "public_only_model": scored(pub_model.predict(xte[:, public]), yte, test),
        "model_delivered_without_panel": scored(full.predict(blind), yte, test),
        "enclave_signals": scored(signal, yte, test) | reconstruction(signal, x, growth, panel, test, public),
        "enclave_signals_coarse": scored(coarse(signal, test), yte, test)
        | reconstruction(coarse(signal, test), x, growth, panel, test, public),
        "enclave_signals_coarse_delayed_1w": scored(coarse(delayed, test), yte, test)
        | reconstruction(coarse(delayed, test), x, growth, panel, test, public),
        "panel_itself": scored(panel[test].ravel(), yte, test),
        "panel_vs_truth_corr": float(np.corrcoef(panel[test].ravel(), growth[test].ravel())[0, 1]),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    save("m08_alt_data_signals", [run(s) for s in range(1, args.seeds + 1)], {"features": FEATURES})
