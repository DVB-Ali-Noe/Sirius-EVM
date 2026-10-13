# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6", "pandas>=2.2", "pyarrow>=17"]
# ///
"""R3, real data for M11 (experience lending) and M03 (quantile regression): Binance USD-M perpetuals, 8 symbols, 2025,
hourly (real/fetch_binance.py).

Public features are rebuildable from price archives by anyone: momentum, volatility, volume, taker share, hour.
Context features play the agent's live-only record: order-book imbalance and depth (snapshots every ~30 s), open
interest change and long/short ratios. Caveat: Binance archives them, so here they are not truly lost after the fact;
the test measures the mechanism (does a borrower with 30 days gain from renting others' longer context logs?), not the
scarcity. Target: next-horizon log return over 24 h volatility (4 h by default, 24 h with --horizon 24).

Time layout: providers log Jan-Aug, the borrower only has its last 30 days (Aug), test is Sep-Dec. Trading evaluation
rebalances once per horizon on all 8 symbols, 4 bp cost per unit of position change. Seeds only change the membership
split: the market data and the quality numbers are the same for every seed.
Usage: uv run real/r3_binance_experience.py --seeds 3 --horizon 4
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import QuantileRegressor, Ridge
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common import gbdt, hist_artifacts, membership, save  # noqa: E402

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT"]
PUBLIC = ["ret_1h", "ret_6h", "ret_24h", "vol_24h", "volume_z", "taker_share", "hour"]
CONTEXT = ["imb1_mean", "imb1_last", "imb5_mean", "imb1_std", "depth_z", "oi_1h", "oi_24h", "top_ls", "acct_ls",
           "taker_ls", "top_ls_change"]
HORIZON, COST = 4, 0.0004
HISTORY, OWN, TEST = ("2025-01-01", "2025-08-31"), ("2025-08-02", "2025-08-31"), ("2025-09-01", "2025-12-31")
PROVIDERS = {  # symbols and logging window of each agent
    "Atlas": (["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"], ("2025-01-01", "2025-08-31")),
    "Kite": (["DOGEUSDT", "ADAUSDT", "LINKUSDT"], ("2025-04-01", "2025-08-31")),
    "Orion": (["BTCUSDT", "BNBUSDT", "SOLUSDT", "ADAUSDT", "LINKUSDT"], ("2025-01-01", "2025-05-31")),
    "Pine": (["ETHUSDT", "BNBUSDT", "DOGEUSDT"], ("2025-03-01", "2025-08-31")),
}
QUANTILES = (0.1, 0.5, 0.9)


def load():
    frames = []
    for s in SYMBOLS:
        d = pd.read_parquet(ROOT / "data" / "binance" / f"{s}.parquet").sort_index()
        r = np.log(d["close"]).diff()
        vol = r.rolling(24).std()
        f = pd.DataFrame(index=d.index)
        f["ret_1h"] = r / vol
        f["ret_6h"] = r.rolling(6).sum() / (vol * np.sqrt(6))
        f["ret_24h"] = r.rolling(24).sum() / (vol * np.sqrt(24))
        f["vol_24h"] = np.log(vol / vol.rolling(24 * 30).median())
        lv = np.log(d["quote_volume"])
        f["volume_z"] = (lv - lv.rolling(168).mean()) / lv.rolling(168).std()
        f["taker_share"] = d["taker_buy_quote_volume"] / d["quote_volume"]
        f["hour"] = d.index.hour
        for c in ("imb1_mean", "imb1_last", "imb5_mean", "imb1_std", "top_ls", "acct_ls", "taker_ls"):
            f[c] = d[c]
        ld = np.log(d["depth1_mean"])
        f["depth_z"] = (ld - ld.rolling(168).mean()) / ld.rolling(168).std()
        f["oi_1h"] = np.log(d["oi"]).diff()
        f["oi_24h"] = np.log(d["oi"]).diff(24)
        f["top_ls_change"] = np.log(d["top_ls"]).diff(24)
        f["y"] = r.shift(-1).rolling(HORIZON).sum().shift(-(HORIZON - 1)) / vol
        f["fwd_ret"] = np.exp(r.shift(-1).rolling(HORIZON).sum().shift(-(HORIZON - 1))) - 1
        f["symbol"] = s
        frames.append(f.loc["2025"])
    return pd.concat(frames).replace([np.inf, -np.inf], np.nan).dropna()


def window(df, span, symbols=None):
    out = df.loc[(df.index >= span[0]) & (df.index < pd.Timestamp(span[1]) + pd.Timedelta(days=1))]
    return out if symbols is None else out[out.symbol.isin(symbols)]


def fit(df, cols, capacity="capped", linear=False):
    """Fit on the oldest 80 %, pick the GO/NO_GO threshold on the most recent 20 %."""
    df = df.sort_index()
    cut = df.index[int(len(df) * 0.8)]
    tr, va = df[df.index < cut], df[df.index >= cut]
    model = Ridge(alpha=10.0) if linear else gbdt("reg", capacity)
    model.fit(tr[cols].to_numpy(), tr["y"].to_numpy())
    pred = model.predict(va[cols].to_numpy())
    pnl = lambda c: np.sign(pred) * (np.abs(pred) > c) * va["y"].to_numpy()
    tstat = lambda p: p.sum() / np.sqrt((p ** 2).sum() + 1e-12)
    threshold = max(np.quantile(np.abs(pred), [0.0, 0.5, 0.7, 0.85]), key=lambda c: tstat(pnl(c)))
    return model, cols, threshold


def evaluate(fitted, test):
    model, cols, threshold = fitted
    pred = model.predict(test[cols].to_numpy())
    ic = float(np.corrcoef(pred, test["y"])[0, 1])
    t = test.assign(pred=pred)
    t = t[t.index.hour % HORIZON == 0]  # non-overlapping rebalancing, once per horizon
    pos = np.sign(t["pred"]) * (t["pred"].abs() > threshold)
    t = t.assign(pos=pos)
    t["turn"] = t.groupby("symbol")["pos"].diff().abs().fillna(t["pos"].abs())
    book = (t["pos"] * t["fwd_ret"] - COST * t["turn"]).groupby(level=0).mean()
    sharpe = float(book.mean() / (book.std() + 1e-12) * np.sqrt(365 * 24 / HORIZON))
    return {"ic": ic, "sharpe": sharpe, "coverage": float((pos != 0).mean())}


def experience(df, seed):
    test = window(df, TEST)
    own = window(df, OWN)
    logs = {n: window(df, w, s) for n, (s, w) in PROVIDERS.items()}
    allc = PUBLIC + CONTEXT
    pool = pd.concat([own, *logs.values()])
    out = {
        "public_only_full_history": evaluate(fit(window(df, HISTORY), PUBLIC), test),
        "own_30_days": evaluate(fit(own, allc), test),
        **{f"rent_{n}": evaluate(fit(pd.concat([own, g]), allc), test) for n, g in logs.items()},
        "pool": evaluate(fit(pool, allc), test),
        "pool_public_features_only": evaluate(fit(pool, PUBLIC), test),
        "pool_linear": evaluate(fit(pool, allc, linear=True), test),
        "ceiling_all_symbols_full_history": evaluate(fit(window(df, HISTORY), allc), test),
    }
    # membership on Atlas's records, half of which are trained on, reference = pool without Atlas
    rng = np.random.default_rng(seed)
    atlas = logs["Atlas"]
    member = rng.random(len(atlas)) < 0.5
    others = pd.concat([own, *(g for n, g in logs.items() if n != "Atlas")])
    ref = fit(others, allc)[0]
    loss = lambda m, d: (m.predict(d[allc].to_numpy()) - d["y"].to_numpy()) ** 2
    mia = {}
    for capacity in ("capped", "free"):
        model = fit(pd.concat([others, atlas[member]]), allc, capacity)[0]
        # fit() trains on the oldest 80 %: attack only Atlas records on that side
        cut = pd.concat([others, atlas[member]]).sort_index().index[int((len(others) + member.sum()) * 0.8)]
        side = np.asarray(atlas.index < cut)
        mia[capacity] = membership(loss(model, atlas[member & side]), loss(model, atlas[~member & side]),
                                   loss(ref, atlas[member & side]), loss(ref, atlas[~member & side]))
        mia[capacity]["test"] = evaluate((model, allc, 0.0), test)
        mia[capacity]["artifacts"] = hist_artifacts(model, others[allc].to_numpy())
    out["membership_atlas"] = mia
    return out


def pinball(y, q_pred, q):
    d = y - q_pred
    return np.maximum(q * d, (q - 1) * d)


def quantiles(df, seed):
    hist, test = window(df, HISTORY), window(df, TEST)
    rng = np.random.default_rng(seed)
    out = {}
    stressed = (test["vol_24h"] > test["vol_24h"].quantile(0.9)).to_numpy()
    yt = test["y"].to_numpy()
    for cols_name, cols in (("public", PUBLIC), ("public_context", PUBLIC + CONTEXT)):
        xh, yh, xt = hist[cols].to_numpy(), hist["y"].to_numpy(), test[cols].to_numpy()
        sub = rng.choice(len(yh), min(15_000, len(yh)), replace=False)
        preds = {
            "unconditional": np.tile(np.quantile(yh, QUANTILES), (len(yt), 1)),
            "linear_quantile": np.column_stack([QuantileRegressor(quantile=q, alpha=0.0, solver="highs").fit(xh[sub], yh[sub]).predict(xt)
                                                for q in QUANTILES]),
            "gbdt_capped": np.column_stack([gbdt("reg", "capped", loss="quantile", quantile=q).fit(xh, yh).predict(xt)
                                            for q in QUANTILES]),
        }
        for name, p in preds.items():
            inside = (yt >= p[:, 0]) & (yt <= p[:, 2])
            out[f"{cols_name}.{name}"] = {
                "pinball": float(sum(pinball(yt, p[:, i], q) for i, q in enumerate(QUANTILES)).mean()),
                "coverage_80": float(inside.mean()), "coverage_80_high_vol": float(inside[stressed].mean()),
                "width": float((p[:, 2] - p[:, 0]).mean()),
            }
    return out


def run(seed, df):
    return {"experience": experience(df, seed), "quantile": quantiles(df, seed),
            "rows": {"history": len(window(df, HISTORY)), "own": len(window(df, OWN)), "test": len(window(df, TEST))}}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--horizon", type=int, default=4)
    args = ap.parse_args()
    HORIZON = args.horizon
    df = load()
    print(f"{len(df)} symbol-hours", flush=True)
    save(f"r3_binance_experience_{HORIZON}h", [run(s, df) for s in range(1, args.seeds + 1)],
         {"source": "data.binance.vision USD-M futures (klines 1h, bookDepth, metrics), 2025", "symbols": SYMBOLS})
