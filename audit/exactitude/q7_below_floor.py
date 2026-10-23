"""Q7 : sous 10 000 lignes, les arbres font-ils vraiment moins bien que la logistique (commentaire de gbdt.ts:22-25) ?

Usage : python -I audit/exactitude/q7_below_floor.py
Le plancher est abaissé à 2 000 lignes au chargement (tests/mutate-min-rows.cjs), sans toucher au fichier.
Fichiers : 3 000 / 5 000 / 8 000 premières lignes (Taïwan mélangé, credit-risk) ; test externe = lignes 10 000+.
Prérequis : les fichiers de audit/exactitude/.data/below/ (créés par la commande indiquée dans le rapport).
"""

import json
import sys
import warnings

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from sklearn.metrics import roc_auc_score  # noqa: E402

from sirius_lib import DATA, REPO, run_sirius  # noqa: E402

warnings.filterwarnings("ignore")


def main() -> None:
    results = []
    for name in ("taiwan", "credit"):
        for rows in (3000, 5000, 8000):
            path = DATA / "below" / f"{name}-{rows}.csv"
            out = run_sirius(path, path.with_suffix(".json"), DATA / "below" / f"{name}-test.csv",
                             preload="./audit/exactitude/tests/mutate-min-rows.cjs")
            row = {"dataset": name, "rows": rows,
                   "treesExternalAuc": float(roc_auc_score(out["testY"], out["treesTest"])),
                   "logisticExternalAuc": float(roc_auc_score(out["testY"], out["logisticTest"])),
                   "treesShown": out["treesMetrics"]["heldOutAuc"]}
            results.append(row)
            print(json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in row.items()}), flush=True)
    (REPO / "audit" / "exactitude" / "resultats" / "q7-sous-le-plancher.json").write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
