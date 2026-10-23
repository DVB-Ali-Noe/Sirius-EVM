"""Q1 et Q7 : arbres Sirius contre scikit-learn HistGradientBoostingClassifier réglé pareil, et contre la logistique Sirius.

Usage : python -I audit/exactitude/compare_sklearn.py <dataset.csv> <sortie_sirius.json> <resultat.json>

Prérequis : `sirius-run.ts` a produit <sortie_sirius.json> sur le même CSV.
Même séparation que Sirius (index % 5 == 4 → held-out), mêmes colonnes que le modèle Sirius.
"""

import json
import sys
import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from metrics_lib import summary  # noqa: E402

warnings.filterwarnings("ignore")

SIRIUS_LIKE = dict(
    max_iter=150,
    learning_rate=0.1,
    max_depth=2,
    max_leaf_nodes=None,
    max_bins=64,
    min_samples_leaf=1000,
    l2_regularization=1.0,
    early_stopping=False,
    random_state=0,
)


def main() -> None:
    dataset, sirius_path, out_path = sys.argv[1:4]
    sirius = json.load(open(sirius_path, encoding="utf-8"))
    frame = pd.read_csv(dataset)
    target = sirius["target"]
    held = np.arange(len(frame)) % 5 == 4
    features = sirius["features"]
    x, y = frame[features].to_numpy(float), frame[target].to_numpy(int)

    hgb = HistGradientBoostingClassifier(**SIRIUS_LIKE).fit(x[~held], y[~held])
    p_hgb = hgb.predict_proba(x[held])[:, 1]
    p_hgb_train = hgb.predict_proba(x[~held])[:, 1]

    y_held = np.asarray(sirius["heldOutY"])
    assert (y_held == y[held]).all(), "lignes held-out différentes entre Sirius et Python"
    p_trees = np.asarray(sirius["treesHeldOut"])
    p_log = np.asarray(sirius["logisticHeldOut"]) if "logisticHeldOut" in sirius else None

    result = {
        "dataset": dataset.replace("\\", "/").rsplit("/", 1)[-1],
        "rows": int(len(frame)),
        "featuresUsedBySirius": len(features),
        "featuresInFile": int(frame.shape[1] - 1),
        "positiveRate": float(y.mean()),
        "siriusHeldOutAucReported": sirius["treesMetrics"]["heldOutAuc"],
        "siriusTrainAucReported": sirius["treesMetrics"]["trainAuc"],
        "siriusHeldOutAucRecomputedSklearn": float(roc_auc_score(y_held, p_trees)),
        "sklearnHeldOutAuc": float(roc_auc_score(y[held], p_hgb)),
        "sklearnTrainAuc": float(roc_auc_score(y[~held], p_hgb_train)),
        "sklearnTrees": int(hgb.n_iter_),
        "siriusTreesMs": sirius.get("treesMs"),
    }
    result["gapSiriusMinusSklearn"] = result["siriusHeldOutAucReported"] - result["sklearnHeldOutAuc"]
    missing = [c for c in frame.columns if c != target and c not in features]
    if missing:
        # Information : ce que scikit-learn ferait avec toutes les colonnes (valeurs manquantes gérées nativement).
        all_features = [c for c in frame.columns if c != target]
        xa = frame[all_features].to_numpy(float)
        full = HistGradientBoostingClassifier(**SIRIUS_LIKE).fit(xa[~held], y[~held])
        result["droppedColumns"] = missing
        result["sklearnHeldOutAucAllColumns"] = float(roc_auc_score(y[held], full.predict_proba(xa[held])[:, 1]))

    result["q7"] = {"trees": summary(y_held, p_trees), "sklearnHgb": summary(y_held, p_hgb)}
    if p_log is not None:
        result["q7"]["logistic"] = summary(y_held, p_log)
    else:
        result["q7"]["logisticError"] = sirius.get("logisticError")
    json.dump(result, open(out_path, "w", encoding="utf-8"), indent=2)
    short = {k: v for k, v in result.items() if k != "q7"}
    print(json.dumps(short, indent=1))
    for name, values in result["q7"].items():
        if isinstance(values, dict):
            print(name, {k: round(v, 4) if isinstance(v, float) else v for k, v in values.items()})


if __name__ == "__main__":
    main()
