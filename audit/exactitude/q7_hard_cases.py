"""Q7 (cas difficiles) : arbres Sirius contre régression logistique Sirius.

Usage : python -I audit/exactitude/q7_hard_cases.py

Cas (graines fixes) :
- lineaire : relation purement linéaire en logit, 6 variables gaussiennes, 20 000 lignes (synthétique).
- desequilibre-2pct : Taïwan où l'on ne garde que 2 % de défauts (tous les non-défauts, défauts tirés au hasard).
- colonne-bruitee : Taïwan + une colonne de bruit pur à queue lourde (Cauchy × 10⁶, bornée à ±10¹²).
- temporel : 25 000 lignes synthétiques triées dans le temps, relation qui dérive ; le fournisseur publie les 80 %
  les plus anciens (split Sirius entrelacé), on évalue sur les 20 % les plus récents (test « futur »).
- taiwan-10000 / credit-risk-10000 : exactement 10 000 lignes (plancher du profil) ; 9 999 lignes doivent être refusées.
Mesures sur les lignes held-out du split Sirius (et sur le test futur pour « temporel ») : AUC, Brier, ECE,
pente de calibration, gain de la règle d'octroi (accorder si P(défaut) < 1/6 ; +0,2 / −1).
"""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
import json
import sys
import warnings

import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from metrics_lib import summary  # noqa: E402
from sirius_lib import DATA, REPO, run_sirius, write_csv  # noqa: E402

warnings.filterwarnings("ignore")


def linear(rng: np.random.Generator) -> pd.DataFrame:
    x = rng.normal(size=(20_000, 6))
    logit = -1.2 + x @ np.array([1.0, -0.8, 0.6, 0.4, -0.3, 0.2])
    y = (rng.random(len(x)) < 1 / (1 + np.exp(-logit))).astype(int)
    frame = pd.DataFrame(np.round(x, 4), columns=[f"x{i}" for i in range(6)])
    frame["default"] = y
    return frame


def imbalanced(rng: np.random.Generator, taiwan: pd.DataFrame) -> pd.DataFrame:
    negatives = taiwan[taiwan["default"] == 0]
    positives = taiwan[taiwan["default"] == 1]
    keep = int(round(0.02 / 0.98 * len(negatives)))
    frame = pd.concat([negatives, positives.iloc[rng.choice(len(positives), keep, replace=False)]])
    return frame.iloc[rng.permutation(len(frame))].reset_index(drop=True)


def noisy(rng: np.random.Generator, taiwan: pd.DataFrame) -> pd.DataFrame:
    frame = taiwan.copy()
    frame.insert(0, "bruit", np.clip(np.round(rng.standard_cauchy(len(frame)) * 1e6, 2), -1e12, 1e12))
    return frame


def temporal(rng: np.random.Generator) -> pd.DataFrame:
    rows = 25_000
    t = np.sort(rng.random(rows))
    x = rng.normal(size=(rows, 5)) + np.outer(t, [1.0, 0, 0, 0, 0])  # x0 dérive aussi en distribution
    logit = -1.3 + (1 - t) * 1.6 * (np.abs(x[:, 0]) > 1) + t * 1.6 * x[:, 1] + 0.5 * x[:, 2]
    y = (rng.random(rows) < 1 / (1 + np.exp(-logit))).astype(int)
    frame = pd.DataFrame(np.round(x, 4), columns=[f"x{i}" for i in range(5)])
    frame["default"] = y
    return frame


def evaluate(name: str, frame: pd.DataFrame, test: pd.DataFrame | None = None) -> dict:
    path = DATA / "q7" / f"{name}.csv"
    write_csv(frame, path)
    test_path = None
    if test is not None:
        test_path = DATA / "q7" / f"{name}-test.csv"
        write_csv(test, test_path)
    out = run_sirius(path, path.with_suffix(".json"), test_path)
    result = {"case": name, "rows": len(frame), "positiveRate": float(frame[frame.columns[-1]].mean()),
              "featuresTrees": len(out["features"]), "treesMs": out.get("treesMs"),
              "shownHeldOutAuc": out["treesMetrics"]["heldOutAuc"], "trainAuc": out["treesMetrics"]["trainAuc"],
              "heldOut": {"trees": summary(out["heldOutY"], out["treesHeldOut"])}}
    if "logisticHeldOut" in out:
        result["heldOut"]["logistic"] = summary(out["heldOutY"], out["logisticHeldOut"])
    else:
        result["logisticError"] = out.get("logisticError")
    if test is not None:
        result["future"] = {"trees": summary(out["testY"], out["treesTest"])}
        if "logisticTest" in out:
            result["future"]["logistic"] = summary(out["testY"], out["logisticTest"])
    print(json.dumps({"case": name, "rows": len(frame),
                      **{f"{part}-{model}": {k: round(v[k], 4) for k in ("auc", "brier", "cal_ece", "cal_slope", "grant_gainPer1000")}
                         for part in ("heldOut", "future") if part in result for model, v in result[part].items()},
                      "logisticError": result.get("logisticError")}, ensure_ascii=False), flush=True)
    return result


def main() -> None:
    taiwan = pd.read_csv(DATA / "taiwan.csv")
    credit = pd.read_csv(DATA / "credit-risk.csv")
    results = [
        evaluate("lineaire", linear(np.random.default_rng(1))),
        evaluate("desequilibre-2pct", imbalanced(np.random.default_rng(2), taiwan)),
        evaluate("colonne-bruitee", noisy(np.random.default_rng(3), taiwan)),
    ]
    series = temporal(np.random.default_rng(4))
    cut = int(0.8 * len(series))
    results.append(evaluate("temporel", series.iloc[:cut].reset_index(drop=True), series.iloc[cut:].reset_index(drop=True)))
    sample = taiwan.iloc[np.random.default_rng(5).permutation(len(taiwan))].reset_index(drop=True)
    results.append(evaluate("taiwan-10000", sample.iloc[:10_000], sample.iloc[10_000:]))
    results.append(evaluate("credit-risk-10000", credit.iloc[:10_000], credit.iloc[10_000:].reset_index(drop=True)))
    refused = run_sirius_refusal(sample.iloc[:9_999])
    json.dump({"cases": results, "refusal9999": refused},
              open(REPO / "audit" / "exactitude" / "resultats" / "q7-cas-difficiles.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)


def run_sirius_refusal(frame: pd.DataFrame) -> str | None:
    path = DATA / "q7" / "taiwan-9999.csv"
    write_csv(frame, path)
    try:
        run_sirius(path, path.with_suffix(".json"), skip_logistic=True)
    except RuntimeError as error:
        print("9 999 lignes :", str(error)[:160], flush=True)
        return str(error)[:300]
    return None


if __name__ == "__main__":
    main()
