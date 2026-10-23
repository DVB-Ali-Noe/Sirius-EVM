"""Q3 : de combien l'AUC held-out affichée est-elle gonflée quand le fichier contient des doublons ?

Usage : python -I audit/exactitude/q3_duplicates.py [graines=5]

Protocole (Taïwan, OpenML 42477) :
- 6 000 lignes tirées au hasard forment un test externe propre, jamais vu ni dupliqué.
- Les 24 000 autres forment le fichier du fournisseur. On y ajoute `taux × 24 000` copies exactes de lignes
  tirées au hasard, soit placées au hasard dans le fichier (« dispersés »), soit juste après l'original
  (« adjacents », cas d'un export ou d'une jointure qui répète des lignes).
- Sirius s'entraîne sur ce fichier avec son split fixe (index % 5 == 4) et affiche `heldOutAuc`.
- Gonflement = AUC affichée − AUC sur le test externe propre (même modèle).
- Contre-factuel : scikit-learn HGB sans bride (profondeur libre, 63 feuilles, 1 ligne par feuille, 100 arbres) sur le même
  split, pour montrer ce que le split laisserait passer avec un modèle qui mémorise.
"""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")  # poste partagé : évite la sur-souscription des threads OpenMP
import json
import sys
import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from sirius_lib import DATA, REPO, held_mask, run_sirius, write_csv  # noqa: E402

warnings.filterwarnings("ignore")
RATES = (0.0, 0.05, 0.20)
TEST_ROWS = 6_000


def make_file(base: pd.DataFrame, rate: float, placement: str, rng: np.random.Generator) -> pd.DataFrame:
    copies = int(round(rate * len(base)))
    picked = rng.choice(len(base), size=copies, replace=False)
    if placement == "dispersés":
        frame = pd.concat([base, base.iloc[picked]], ignore_index=True)
        return frame.iloc[rng.permutation(len(frame))].reset_index(drop=True)
    order = rng.permutation(len(base))
    doubled = set(picked.tolist())
    rows = []
    for index in order:
        rows.append(index)
        if index in doubled:
            rows.append(index)
    return base.iloc[rows].reset_index(drop=True)


def twin_share(frame: pd.DataFrame) -> float:
    """Part des lignes held-out dont une copie exacte est dans la partie entraînement."""
    held = held_mask(len(frame))
    keys = pd.util.hash_pandas_object(frame, index=False).to_numpy()
    train_keys = set(keys[~held].tolist())
    return float(np.mean([key in train_keys for key in keys[held]]))


def main() -> None:
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    taiwan = pd.read_csv(DATA / "taiwan.csv")
    target = "default"
    features = [c for c in taiwan.columns if c != target]
    natural = int(taiwan.duplicated().sum())
    results = []
    for seed in range(seeds):
        rng = np.random.default_rng(1000 + seed)
        order = rng.permutation(len(taiwan))
        test = taiwan.iloc[order[:TEST_ROWS]].reset_index(drop=True)
        base = taiwan.iloc[order[TEST_ROWS:]].reset_index(drop=True)
        test_path = DATA / "q3" / f"test-{seed}.csv"
        write_csv(test, test_path)
        for placement in ("dispersés", "adjacents"):
            for rate in RATES:
                if rate == 0 and placement == "adjacents":
                    continue
                frame = make_file(base, rate, placement, np.random.default_rng(seed * 100 + int(rate * 100)))
                path = DATA / "q3" / f"file-{seed}-{placement}-{int(rate * 100)}.csv"
                write_csv(frame, path)
                out = run_sirius(path, path.with_suffix(".json"), test_path, skip_logistic=True)
                shown = out["treesMetrics"]["heldOutAuc"]
                external = roc_auc_score(out["testY"], out["treesTest"])
                held = held_mask(len(frame))
                x, y = frame[features].to_numpy(float), frame[target].to_numpy(int)
                deep = HistGradientBoostingClassifier(max_iter=100, learning_rate=0.1, max_depth=None, max_leaf_nodes=63,
                                                      min_samples_leaf=1, l2_regularization=0.0, max_bins=255,
                                                      early_stopping=False, random_state=0).fit(x[~held], y[~held])
                deep_shown = roc_auc_score(y[held], deep.predict_proba(x[held])[:, 1])
                deep_external = roc_auc_score(test[target], deep.predict_proba(test[features].to_numpy(float))[:, 1])
                row = {
                    "seed": seed, "placement": placement, "rate": rate, "rows": len(frame),
                    "heldOutTwinShare": twin_share(frame),
                    "siriusShown": shown, "siriusExternal": float(external), "siriusInflation": float(shown - external),
                    "siriusTrainAuc": out["treesMetrics"]["trainAuc"],
                    "deepShown": float(deep_shown), "deepExternal": float(deep_external), "deepInflation": float(deep_shown - deep_external),
                }
                results.append(row)
                print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()}, ensure_ascii=False), flush=True)
    frame = pd.DataFrame(results)
    table = frame.groupby(["placement", "rate"]).agg(
        twins=("heldOutTwinShare", "mean"),
        sirius_inflation=("siriusInflation", "mean"), sirius_inflation_sd=("siriusInflation", "std"),
        sirius_shown=("siriusShown", "mean"), sirius_external=("siriusExternal", "mean"),
        deep_inflation=("deepInflation", "mean"), deep_inflation_sd=("deepInflation", "std"),
    ).reset_index()
    # Gonflement relatif au taux 0 de la même graine : retire l'aléa commun du test externe.
    zero = frame[frame.rate == 0].set_index("seed")
    frame["siriusExcess"] = frame.apply(lambda r: r.siriusInflation - zero.loc[r.seed, "siriusInflation"], axis=1)
    frame["deepExcess"] = frame.apply(lambda r: r.deepInflation - zero.loc[r.seed, "deepInflation"], axis=1)
    excess = frame.groupby(["placement", "rate"]).agg(
        sirius_excess=("siriusExcess", "mean"), sirius_excess_sd=("siriusExcess", "std"),
        deep_excess=("deepExcess", "mean"), deep_excess_sd=("deepExcess", "std")).reset_index()
    table = table.merge(excess, on=["placement", "rate"])
    print(table.to_string())
    out = REPO / "audit" / "exactitude" / "resultats" / "q3-doublons.json"
    json.dump({"naturalDuplicatesInTaiwan": natural, "seeds": seeds, "runs": results,
               "summary": table.to_dict(orient="records")}, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
