# Example datasets

Sample data you can upload to Sirius to see a full loan run end to end, without
having to prepare anything yourself.

## `housing-prices.csv`

Tabular regression: predict a property price from five numeric features.

| Column | Meaning |
|---|---|
| `surface_m2` | Floor area in square metres |
| `rooms` | Number of rooms |
| `age_years` | Age of the building |
| `distance_km` | Distance to the city centre |
| `energy_score` | Energy rating, 0–100 |
| `price_eur` | **Target** — the value the model learns to predict |

140 rows. Training takes a few milliseconds and yields **R² ≈ 0.97**, with a root
mean squared error around **25 000 €** on prices spanning 200 000 to 600 000 € —
roughly a 6 % error.

The data is synthetic. It is generated from a deliberate linear relationship plus
noise, so the result is strong without being suspiciously perfect. Real housing
data would land closer to 0.80.

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
