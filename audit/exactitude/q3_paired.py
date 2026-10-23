"""Q3 (mesure appariée) : sur le même modèle Sirius, AUC held-out affichée contre AUC des seules lignes held-out
sans copie dans l'entraînement. Retire l'aléa du test externe ; lit les sorties de q3_duplicates.py.

Usage : python -I audit/exactitude/q3_paired.py
"""

import json
import sys
import warnings

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from sirius_lib import DATA, REPO, held_mask  # noqa: E402

warnings.filterwarnings("ignore")


def main() -> None:
    rows = []
    for csv in sorted((DATA / "q3").glob("file-*.csv")):
        _, seed, placement, rate = csv.stem.split("-")
        out = json.loads(csv.with_suffix(".json").read_text(encoding="utf-8"))
        frame = pd.read_csv(csv)
        held = held_mask(len(frame))
        keys = pd.util.hash_pandas_object(frame, index=False).to_numpy()
        train_keys = set(keys[~held].tolist())
        twin = np.array([key in train_keys for key in keys[held]])
        y = np.asarray(out["heldOutY"])
        p = np.asarray(out["treesHeldOut"])
        shown = roc_auc_score(y, p)
        clean = roc_auc_score(y[~twin], p[~twin])
        rows.append({"seed": int(seed), "placement": placement, "rate": int(rate) / 100, "twinShare": float(twin.mean()),
                     "shown": float(shown), "withoutTwins": float(clean), "pairedInflation": float(shown - clean),
                     "twinsOnly": float(roc_auc_score(y[twin], p[twin])) if twin.sum() > 50 and 0 < y[twin].mean() < 1 else None})
    frame = pd.DataFrame(rows)
    table = frame.groupby(["placement", "rate"]).agg(runs=("shown", "size"), twins=("twinShare", "mean"),
                                                     paired=("pairedInflation", "mean"), paired_sd=("pairedInflation", "std"),
                                                     paired_max=("pairedInflation", "max"), twins_only=("twinsOnly", "mean"),
                                                     without=("withoutTwins", "mean")).reset_index()
    print(table.to_string())
    target = REPO / "audit" / "exactitude" / "resultats" / "q3-doublons.json"
    data = json.loads(target.read_text(encoding="utf-8"))
    data["paired"] = {"runs": rows, "summary": table.to_dict(orient="records")}
    target.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
