# Example datasets

Sample data you can upload to Sirius to see a full loan run end to end, without
having to prepare anything yourself.

## `housing-prices-train.csv` and `housing-prices-test.csv`

Tabular regression: predict a property price from five numeric features.

| Column | Meaning |
|---|---|
| `surface_m2` | Floor area in square metres |
| `rooms` | Number of rooms |
| `age_years` | Age of the building |
| `distance_km` | Distance to the city centre |
| `energy_score` | Energy rating, 0–100 |
| `price_eur` | **Target** — the value the model learns to predict |

The 140 rows are deterministically separated into 112 training rows and 28 test
rows. Upload only `housing-prices-train.csv` to Sirius. Once the model is
delivered, select `housing-prices-test.csv` in **Evaluate on a test CSV** to
measure it on rows that were never used during training.

The data is synthetic. It is generated from a deliberate linear relationship plus
noise, so the result is strong without being suspiciously perfect. Real housing
data would land closer to 0.80.

## `bike-sharing-demand-train.csv` and `bike-sharing-demand-test.csv`

Real-world tabular regression: predict the hourly number of bike rentals (`cnt`)
from calendar and weather measurements. It contains 17,389 rows from the Capital
Bikeshare system over 2011 and 2012.

The file is a Sirius-compatible export of the UCI Bike Sharing dataset. The
non-numeric date and record identifier are removed. `casual` and `registered` are
also removed because they sum to `cnt`: keeping them would leak the answer into the
features and make the model deceptively perfect.

Source: Fanaee-T, H. (2013), *Bike Sharing*, UCI Machine Learning Repository,
https://doi.org/10.24432/C5W894. Licensed under CC BY 4.0.

The chronological 80/20 split keeps the final period exclusively for evaluation.
Upload the `-train` file and retain the `-test` file locally for the delivered
model's evaluation.

Regenerate the source file and its split from the official UCI archive with:

```bash
pnpm datasets:fetch
```

## `energy-demand-train.csv` and `energy-demand-test.csv`

Synthetic, but realistic, hourly energy-demand regression with 8,760 rows. The
target `energy_mwh` depends on weather, solar production, calendar signals and
morning/evening demand peaks. It is useful to validate a larger file, several
features and a model with an interpretable result.

The first 7,008 hourly rows are training data; the final 1,752 rows are the
chronological test period. This guards against accidentally measuring a model on
the rows it has already seen.

Regenerate it deterministically with:

```bash
pnpm datasets:generate
```

To recreate only the splits after changing a source dataset:

```bash
pnpm datasets:split
```

## Testing a delivered model

The model's **training** R² and RMSE are informational only: they are calculated
on the rows used to fit it. To validate it, download the model, then in Sirius
open **Evaluate on a test CSV** and choose the matching `-test.csv` file. The
evaluation (R², RMSE and MAE) is calculated locally in the browser; the test file
is never uploaded.

For one-off use, open **Test a prediction**, enter one numeric value for each
feature, and Sirius returns the predicted value of the target column. The same
model JSON can also be used outside Sirius: `prediction = coefficients[0] + Σ
(coefficients[i + 1] × features[i])`.

## Realistic benchmark suite

Four larger train/test pairs cover vehicle resale, retail demand, last-mile
delivery and industrial yield. They deliberately include drift, outliers,
nonlinearity and unobserved categorical context. See
[`benchmarks/README.md`](benchmarks/README.md) and regenerate them with:

```bash
pnpm datasets:benchmarks
```

## What Sirius expects from a dataset

- **CSV with a header row.**
- **At least 100 rows.** Below that, a model could memorise individual records
  rather than learn a pattern — the floor exists to protect the people behind the
  data, not for statistical comfort.
- **At least two numeric columns**, and at most 32.
- **The target is the last numeric column.** Everything else is used as a feature.
- Non-numeric columns are ignored rather than rejected, so an `id` or a `city`
  name can stay in the file.

## What actually happens to this file

It is encrypted **in your browser**, before anything leaves your machine. The
plaintext never reaches our servers — not once, not briefly. What we store on
IPFS is a sealed blob, and what a borrower receives is a trained model, never
the rows it was trained on.
