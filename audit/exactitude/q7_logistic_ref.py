"""Q7 : la logistique Sirius (200 pas de gradient, pas 0,1) atteint-elle l'optimum d'une logistique convergée ?

Usage : python -I audit/exactitude/q7_logistic_ref.py
Même split et mêmes colonnes que Sirius ; référence scikit-learn LogisticRegression (lbfgs, variables
standardisées, régularisation quasi nulle) entraînée jusqu'à convergence.
"""

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
import json
import sys
import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from metrics_lib import summary  # noqa: E402
from sirius_lib import DATA, REPO, held_mask  # noqa: E402

warnings.filterwarnings("ignore")


def main() -> None:
    results = {}
    for name in ("credit-risk", "taiwan", "gmsc"):
        out = json.loads((DATA / "out" / f"{name}.json").read_text(encoding="utf-8"))
        frame = pd.read_csv(DATA / f"{name}.csv")
        held = held_mask(len(frame))
        x = frame[out["logisticFeatures"]].to_numpy(float)
        y = frame[out["target"]].to_numpy(int)
        reference = make_pipeline(StandardScaler(), LogisticRegression(C=1e4, max_iter=5000)).fit(x[~held], y[~held])
        p = reference.predict_proba(x[held])[:, 1]
        results[name] = {
            "siriusLogisticAuc": float(roc_auc_score(out["heldOutY"], out["logisticHeldOut"])),
            "convergedLogisticAuc": float(roc_auc_score(y[held], p)),
            "converged": summary(y[held], p),
        }
        print(name, {k: round(v, 4) for k, v in results[name].items() if isinstance(v, float)},
              "pente", round(results[name]["converged"]["cal_slope"], 3), "gain/1000", round(results[name]["converged"]["grant_gainPer1000"], 2))
    (REPO / "audit" / "exactitude" / "resultats" / "q7-logistique-convergee.json").write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
