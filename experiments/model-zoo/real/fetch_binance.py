# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "pandas>=2.2", "pyarrow>=17"]
# ///
"""Downloads Binance USD-M futures public archives and reduces them to one row per symbol and hour.

Per hour: OHLCV and taker flow (klines), order-book depth imbalance at 1 % and 5 % from mid (bookDepth snapshots,
about every 30 s), open interest and long/short ratios (metrics, every 5 min). Raw zips are deleted once reduced.
Usage: uv run real/fetch_binance.py --start 2025-01-01 --end 2025-12-31 --out data/binance
"""
import argparse
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import pandas as pd

BASE = "https://data.binance.vision/data/futures/um"
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT"]


def fetch_csv(url):
    try:
        with urlopen(url, timeout=60) as r:
            raw = r.read()
    except Exception:
        return None
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        return pd.read_csv(z.open(z.namelist()[0]))


def book_hourly(df):
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    wide = df.pivot_table(index="timestamp", columns="percentage", values="notional", aggfunc="last")
    imb = lambda p: (wide[-p] - wide[p]) / (wide[-p] + wide[p])
    snap = pd.DataFrame({"imb1": imb(1), "imb5": imb(5), "depth1": wide[-1] + wide[1]})
    h = snap.resample("1h")
    return pd.DataFrame({"imb1_mean": h["imb1"].mean(), "imb1_last": h["imb1"].last(), "imb5_mean": h["imb5"].mean(),
                         "imb1_std": h["imb1"].std(), "depth1_mean": h["depth1"].mean()})


def metrics_hourly(df):
    df["create_time"] = pd.to_datetime(df["create_time"])
    h = df.set_index("create_time").resample("1h")
    return pd.DataFrame({"oi": h["sum_open_interest_value"].last(),
                         "top_ls": h["sum_toptrader_long_short_ratio"].mean(),
                         "acct_ls": h["count_long_short_ratio"].mean(),
                         "taker_ls": h["sum_taker_long_short_vol_ratio"].mean()})


def one_day(symbol, day):
    book = fetch_csv(f"{BASE}/daily/bookDepth/{symbol}/{symbol}-bookDepth-{day}.zip")
    met = fetch_csv(f"{BASE}/daily/metrics/{symbol}/{symbol}-metrics-{day}.zip")
    parts = [p for p in (book_hourly(book) if book is not None else None,
                         metrics_hourly(met) if met is not None else None) if p is not None]
    return pd.concat(parts, axis=1) if parts else None


def klines(symbol, months):
    frames = []
    for m in months:
        df = fetch_csv(f"{BASE}/monthly/klines/{symbol}/1h/{symbol}-1h-{m}.zip")
        if df is not None:
            frames.append(df)
    k = pd.concat(frames)
    k.index = pd.to_datetime(k["open_time"], unit="ms")
    return k[["open", "high", "low", "close", "volume", "quote_volume", "taker_buy_quote_volume", "count"]].astype(float)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-01-01")
    ap.add_argument("--end", default="2025-12-31")
    ap.add_argument("--out", default="data/binance")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    days = [str(start + timedelta(d)) for d in range((end - start).days + 1)]
    months = sorted({d[:7] for d in days} | {str(start - timedelta(days=1))[:7]})
    for symbol in SYMBOLS:
        target = out / f"{symbol}.parquet"
        if target.exists():
            continue
        with ThreadPoolExecutor(args.workers) as pool:
            daily = [d for d in pool.map(lambda d: one_day(symbol, d), days) if d is not None]
        context = pd.concat(daily).sort_index()
        frame = klines(symbol, months).join(context, how="left")
        frame.to_parquet(target)
        print(f"{symbol}: {len(frame)} hours, {context.notna().all(axis=1).mean():.1%} complete", flush=True)


if __name__ == "__main__":
    main()
