"""Q4 : le contrôle « trainAuc >= heldOutAuc − 0,02 » suffit-il ? Mesure de l'écart train − held-out.

Usage : python -I audit/exactitude/q4_gap.py [permutations=8]

Pour chaque jeu, on mélange l'ordre des lignes (graines fixes) : le split index % 5 change, le modèle Sirius
aussi. On relève trainAuc − heldOutAuc, l'erreur type de l'AUC held-out (Hanley-McNeil), et l'on compte combien
de fois chaque contrôle se déclenche à tort :
- contrôle actuel (test unitaire seulement) : alerte si trainAuc < heldOutAuc − 0,02 ;
- contrôle proposé à deux sens : alerte « held-out trop beau » si heldOutAuc − trainAuc > 3·SE,
  alerte « mémorisation » si trainAuc − heldOutAuc > 0,02 + 3·SE.
Cas 10 000 lignes : sous-échantillons de Taïwan, là où l'AUC held-out (2 000 lignes) est la plus bruitée.
Cas mémorisation : scikit-learn HGB sans bride sur le même split, pour vérifier que le sens 2 l'attrape.
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
from metrics_lib import auc_standard_error  # noqa: E402
from sirius_lib import DATA, REPO, held_mask, run_sirius, write_csv  # noqa: E402

warnings.filterwarnings("ignore")


def checks(train_auc: float, held_auc: float, se: float) -> dict:
    return {
        "currentAlarm": bool(train_auc < held_auc - 0.02),
        "proposedHeldOutTooGood": bool(held_auc - train_auc > 3 * se),
        "proposedMemorization": bool(train_auc - held_auc > 0.02 + 3 * se),
    }


def main() -> None:
    permutations = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    runs = []
    plans = [("credit-risk", None), ("taiwan", None), ("gmsc", None), ("taiwan", 10_000)]
    for name, size in plans:
        source = pd.read_csv(DATA / f"{name}.csv", keep_default_na=False, dtype=str)
        count = permutations * (3 if size else 1)
        for seed in range(count):
            rng = np.random.default_rng(7_000 + seed)
            order = rng.permutation(len(source))[: size or len(source)]
            frame = source.iloc[order].reset_index(drop=True)
            label = f"{name}-{size or 'complet'}"
            path = DATA / "q4" / f"{label}-{seed}.csv"
            write_csv(frame, path)
            out = run_sirius(path, path.with_suffix(".json"), skip_logistic=True)
            metrics = out["treesMetrics"]
            y = np.asarray(out["heldOutY"])
            se = auc_standard_error(metrics["heldOutAuc"], int(y.sum()), int(len(y) - y.sum()))
            row = {"plan": label, "seed": seed, "rows": len(frame), "trainAuc": metrics["trainAuc"], "heldOutAuc": metrics["heldOutAuc"],
                   "gap": metrics["trainAuc"] - metrics["heldOutAuc"], "se": se, **checks(metrics["trainAuc"], metrics["heldOutAuc"], se)}
            runs.append(row)
            print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()}), flush=True)

    # Mémorisation : un modèle sans bride sur Taïwan 10 000 lignes, même split.
    memorizing = []
    source = pd.read_csv(DATA / "taiwan.csv")
    for seed in range(3):
        rng = np.random.default_rng(7_000 + seed)
        frame = source.iloc[rng.permutation(len(source))[:10_000]].reset_index(drop=True)
        held = held_mask(len(frame))
        x, y = frame.drop(columns=["default"]).to_numpy(float), frame["default"].to_numpy(int)
        deep = HistGradientBoostingClassifier(max_iter=100, max_depth=None, max_leaf_nodes=63, min_samples_leaf=1,
                                              l2_regularization=0.0, max_bins=255, early_stopping=False, random_state=0).fit(x[~held], y[~held])
        train_auc = roc_auc_score(y[~held], deep.predict_proba(x[~held])[:, 1])
        held_auc = roc_auc_score(y[held], deep.predict_proba(x[held])[:, 1])
        se = auc_standard_error(held_auc, int(y[held].sum()), int((1 - y[held]).sum()))
        memorizing.append({"seed": seed, "trainAuc": train_auc, "heldOutAuc": held_auc, "gap": train_auc - held_auc, "se": se,
                           **checks(train_auc, held_auc, se)})
        print("mémorisation", json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in memorizing[-1].items()}), flush=True)

    frame = pd.DataFrame(runs)
    summary = frame.groupby("plan").agg(
        runs=("gap", "size"), gap_mean=("gap", "mean"), gap_sd=("gap", "std"), gap_min=("gap", "min"), gap_max=("gap", "max"),
        held_sd=("heldOutAuc", "std"), se_mean=("se", "mean"),
        current_alarms=("currentAlarm", "sum"), proposed_too_good=("proposedHeldOutTooGood", "sum"), proposed_memo=("proposedMemorization", "sum"),
    ).reset_index()
    print(summary.to_string())
    json.dump({"runs": runs, "memorizing": memorizing, "summary": summary.to_dict(orient="records")},
              open(REPO / "audit" / "exactitude" / "resultats" / "q4-ecart-train-heldout.json", "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
