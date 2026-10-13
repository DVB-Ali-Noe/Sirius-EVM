# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scikit-learn>=1.6", "pandas>=2.2", "pyarrow>=17"]
# ///
"""R2, real data for M04 (Isolation Forest) and M10 (classifier on private scam labels).

Addresses and monthly on-chain activity: fesevu/ethereum_fraud_dataset_by_activity (Hugging Face, CC-BY-4.0, built
from the public BigQuery Ethereum dataset, Etherscan labels and curated scam lists). The release is balanced, and its
scam share depends heavily on the year an address first appears (3.6 % in 2017, 99.9 % in 2024): a model would learn the
year, not the scam. Only addresses first active in 2017-2022 are kept, and scams are subsampled to 5 % within each year,
so that the year carries no label information.
"Public" labels = addresses in Forta's Etherscan phishing list (forta-network/labelled-datasets); every other scam label
plays the exchange's private list. Main study on addresses first active in 2017-2020; drift: the same models scored on
addresses first active in 2021-2022.
Usage: uv run real/r2_eth_scam.py --seeds 5
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common import canaries, canary_exposure, gbdt, hist_artifacts, logloss, membership, save  # noqa: E402

DATA = ROOT / "data" / "eth"
SCAM_RATE = 0.05
COUNTS = ["normal_total_cnt", "normal_sent_cnt", "normal_recv_cnt", "normal_failed_cnt", "normal_to_contract_cnt",
          "internal_in_cnt", "internal_out_cnt", "erc20_recv_cnt", "erc20_sent_cnt", "sessions_cnt"]
PEERS = ["uniq_peers_cnt", "uniq_eoa_peers_cnt", "uniq_contract_peers_cnt", "erc20_unique_tokens_recv",
         "erc20_unique_tokens_sent"]
VALUES = ["eth_recv_sum", "eth_sent_sum", "tx_fee_eth_sum"]


def features():
    m = pd.read_parquet(DATA / "monthly.parquet")
    for c in VALUES:
        m[c] = pd.to_numeric(m[c], errors="coerce").fillna(0.0)
    m["month_idx"] = pd.PeriodIndex(m["month"], freq="M").astype("int64")
    g = m.groupby("node_id")
    f = pd.DataFrame({
        "months_active": g.size(),
        "first_month": g["month_idx"].min(),
        "lifespan_months": g["month_idx"].max() - g["month_idx"].min() + 1,
        "burst_max": g["burst_max_tx_5m"].max(),
        "active_span_mean": np.log1p(g["active_span_min"].mean()),
        **{c: np.log1p(g[c].sum()) for c in COUNTS},
        **{c: np.log1p(g[c].max()) for c in PEERS},
        **{c: np.log1p(g[c].sum().clip(lower=0)) for c in VALUES},
    })
    f["failed_share"] = g["normal_failed_cnt"].sum() / g["normal_total_cnt"].sum().clip(lower=1)
    f["sent_share"] = g["normal_sent_cnt"].sum() / g["normal_total_cnt"].sum().clip(lower=1)
    t = pd.read_parquet(DATA / "targets_global.parquet").set_index("node_id")
    forta = set(pd.read_csv(DATA / "forta_phishing.csv")["address"].str.lower())
    t["public"] = t["address"].str.lower().isin(forta) & (t["is_scam"] == 1)
    d = f.join(t[["is_scam", "is_contract", "public"]], how="inner")
    return d


def scores(model, x):
    return -model.score_samples(x) if isinstance(model, IsolationForest) else model.predict_proba(x)[:, 1]


def detection(y, secret, score):
    top1, top5 = (np.argsort(-score)[: int(len(y) * s)] for s in (0.01, 0.05))
    return {"auc": float(roc_auc_score(y, score)),
            "auc_secret_vs_clean": float(roc_auc_score(secret[(y == 0) | secret], score[(y == 0) | secret])),
            "precision_top1pct": float(y[top1].mean()), "precision_top5pct": float(y[top5].mean()),
            "recall_top5pct": float(y[top5].sum() / y.sum()), "secret_recall_top5pct": float(secret[top5].sum() / secret.sum())}


def stratified(d, seed):
    year = d.first_month.map(lambda m: pd.Period(ordinal=int(m), freq="M").year)
    keep = []
    for y in range(2017, 2023):
        clean, scams = d[(year == y) & (d.is_scam == 0)], d[(year == y) & (d.is_scam == 1)]
        n = min(len(scams), int(len(clean) * SCAM_RATE / (1 - SCAM_RATE)))
        keep += [clean, scams.sample(n, random_state=seed)]
    pop = pd.concat(keep).sample(frac=1, random_state=seed)
    return pop, year.loc[pop.index]


def run(seed, d):
    rng = np.random.default_rng(seed)
    pop, year = stratified(d, seed)
    early, late = pop[year <= 2020], pop[year >= 2021]
    cols = [c for c in pop.columns if c not in ("is_scam", "public", "first_month")]
    parts = np.array_split(np.arange(len(early)), 4)
    lots = {k: early.iloc[p] for k, p in zip(("members", "nonmembers", "reference", "test"), parts)}
    arr = lambda df: (df[cols].to_numpy(float), df["is_scam"].to_numpy(int), df["public"].to_numpy(int))
    (xm, ym, pm), (xn, yn, pn), (xr, yr, pr), (xt, yt, ptt) = (arr(lots[k]) for k in ("members", "nonmembers", "reference", "test"))
    xl, yl, pl = arr(late)
    inj, ctl = canaries(rng, xr)
    # each canary gets the label the population pattern does not predict for it
    pattern = gbdt("clf", "capped").fit(xr, yr)
    inj_y, ctl_y = ((pattern.predict_proba(c)[:, 1] <= 0.5).astype(int) for c in (inj, ctl))
    out = {"sizes": {"members": len(ym), "scams_members": int(ym.sum()), "public_share_of_scams": float(pm.sum() / ym.sum()),
                     "late_size": len(yl), "late_scam_rate": float(yl.mean())}}
    builders = {
        "isolation_forest": (lambda: IsolationForest(n_estimators=200, max_samples=256, random_state=0), None),
        "gbdt_public_labels": (lambda: gbdt("clf", "capped"), "public"),
        "gbdt_private_capped": (lambda: gbdt("clf", "capped"), "private"),
        "gbdt_private_strict": (lambda: gbdt("clf", "strict"), "private"),
        "gbdt_private_free": (lambda: gbdt("clf", "free"), "private"),
    }
    for name, (factory, labels) in builders.items():
        y = {"public": pm, "private": ym}.get(labels)
        model = factory().fit(xm) if y is None else factory().fit(xm, y)
        res = {"quality": detection(yt, (yt == 1) & (ptt == 0), scores(model, xt)),
               "drift_2021_2022": detection(yl, (yl == 1) & (pl == 0), scores(model, xl))}
        if labels == "private":
            secret_m, secret_n = (ym == 1) & (pm == 0), (yn == 1) & (pn == 0)
            threshold = np.quantile(scores(model, xt), 0.95)
            res["secret_flagged_members"] = float((scores(model, xm[secret_m]) > threshold).mean())
            res["secret_flagged_nonmembers"] = float((scores(model, xn[secret_n]) > threshold).mean())
            ref = factory().fit(xr, yr)
            loss = lambda m, x, yy: logloss(yy, m.predict_proba(x)[:, 1])
            res["membership_all"] = membership(loss(model, xm, ym), loss(model, xn, yn), loss(ref, xm, ym), loss(ref, xn, yn))
            res["membership_secret"] = membership(loss(model, xm[secret_m], ym[secret_m]), loss(model, xn[secret_n], yn[secret_n]),
                                                  loss(ref, xm[secret_m], ym[secret_m]), loss(ref, xn[secret_n], yn[secret_n]))
            res["artifacts"] = hist_artifacts(model, xr)
            for rep in (1, 5):
                cm = factory().fit(np.r_[xm, np.repeat(inj, rep, axis=0)], np.r_[ym, np.repeat(inj_y, rep)])
                pi, pc = cm.predict_proba(inj)[:, 1], cm.predict_proba(ctl)[:, 1]
                res[f"canary_x{rep}"] = canary_exposure(logloss(inj_y, pi), logloss(ctl_y, pc), (pi > 0.5) == inj_y,
                                                        (pc > 0.5) == ctl_y)
        if name == "isolation_forest":
            ref = factory().fit(xr)
            sm, sn = (ym == 1), (yn == 1)
            loss = lambda m, x: -m.score_samples(x)
            res["membership_scams"] = membership(loss(model, xm[sm]), loss(model, xn[sn]), loss(ref, xm[sm]), loss(ref, xn[sn]))
            res["tail_splits"] = int(sum(((t.tree_.threshold[t.tree_.children_left != -1] < np.quantile(xr[:, f], 0.001, axis=0)[t.tree_.feature[t.tree_.children_left != -1]]) |
                                          (t.tree_.threshold[t.tree_.children_left != -1] > np.quantile(xr[:, f], 0.999, axis=0)[t.tree_.feature[t.tree_.children_left != -1]])).sum()
                                         for t, f in zip(model.estimators_, model.estimators_features_)))
        out[name] = res
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()
    d = features()
    print(f"{len(d)} labelled addresses, {d.is_scam.mean():.1%} scams, {d.public.sum()} publicly flagged", flush=True)
    save("r2_eth_scam", [run(s, d) for s in range(1, args.seeds + 1)],
         {"source": "fesevu/ethereum_fraud_dataset_by_activity + forta-network/labelled-datasets", "addresses": len(d)})
