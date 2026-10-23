"""Prépare les 3 jeux publics de l'audit au format attendu par Sirius (CSV numérique, cible 0/1 en dernier).

Usage : python -I audit/exactitude/prepare_data.py <dossier_cache_openml> <dossier_sortie>

- taiwan.csv : OpenML 42477 (default-of-credit-card-clients), 30 000 lignes, 23 variables, cible `default`.
- gmsc.csv : OpenML 46929 (GiveMeSomeCredit), les 40 000 premières lignes dans l'ordre OpenML
  (le parseur CSV de Sirius plafonne à 50 000 lignes et le budget des arbres à 300 M d'opérations).
  Les valeurs manquantes restent des cellules vides, comme dans un export réel.
- credit-risk.csv : copie de public/examples/classification/credit-risk.csv (synthétique, 13 000 lignes).

Le cache OpenML est un dossier séparé (données téléchargées = non fiables) ; rien n'est exécuté depuis ce dossier.
"""

import shutil
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

GMSC_ROWS = 40_000


def main() -> None:
    from sklearn.datasets import fetch_openml

    cache = Path(sys.argv[1])
    out = Path(sys.argv[2])
    repo = Path(__file__).resolve().parents[2]
    out.mkdir(parents=True, exist_ok=True)

    taiwan = fetch_openml(data_id=42477, as_frame=True, data_home=str(cache), parser="liac-arff").frame
    taiwan = taiwan.rename(columns={"y": "default"})
    taiwan["default"] = taiwan["default"].astype(str).astype(int)
    for column in taiwan.columns:
        if column != "default":
            taiwan[column] = taiwan[column].astype(float)
            if (taiwan[column] == taiwan[column].round()).all():
                taiwan[column] = taiwan[column].astype(int)
    taiwan.to_csv(out / "taiwan.csv", index=False, lineterminator="\n")

    gmsc = fetch_openml(data_id=46929, as_frame=True, data_home=str(cache), parser="liac-arff").frame
    target = "FinancialDistressNextTwoYears"
    gmsc["default"] = (gmsc[target].astype(str) == "Yes").astype(int)
    gmsc = gmsc.drop(columns=[target]).head(GMSC_ROWS)
    for column in ("MonthlyIncome", "NumberOfDependents"):
        values = gmsc[column]
        gmsc[column] = values.map(lambda value: "" if value != value else (str(int(value)) if value == int(value) else repr(float(value))))
    gmsc.to_csv(out / "gmsc.csv", index=False, lineterminator="\n")

    shutil.copyfile(repo / "public/examples/classification/credit-risk.csv", out / "credit-risk.csv")

    for name in ("taiwan.csv", "gmsc.csv", "credit-risk.csv"):
        lines = (out / name).read_text(encoding="utf-8").splitlines()
        print(name, "lignes de données :", len(lines) - 1, "| colonnes :", len(lines[0].split(",")))


if __name__ == "__main__":
    main()
