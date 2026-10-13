"""Markdown synthesis of runs/results.json. Usage: python3 summary.py runs/results.json > runs/summary.md"""
import json
import sys

SCENARIOS = [
    ("public_only", "Historique public seul (reconstructible depuis la chaîne, gratuit)"),
    ("own_only", "Historique propre du borrower (40 jours)"),
    ("rent_Atlas", "+ location d'Atlas"),
    ("rent_Kite", "+ location de Kite"),
    ("rent_Orion", "+ location d'Orion"),
    ("rent_Pine", "+ location de Pine (mauvais trader, meilleurs capteurs)"),
    ("pool", "+ pool des 4 providers honnêtes"),
    ("pool_linear", "Pool, régression linéaire au lieu des arbres"),
    ("pool_with_cheater", "Pool + Mirage (historique fabriqué), sans vérification"),
    ("pool_with_cheater_verified", "Pool + Mirage, engagements on-chain vérifiés"),
    ("ceiling", "Plafond : capteurs parfaits, tout l'historique"),
]
CAPACITY = {"free": "Libre (feuilles de 2, 600 itérations)", "standard": "Standard (profondeur 3, feuilles ≥ 200)",
            "capped": "Bridé (profondeur 2, feuilles ≥ 1000)"}
LEAK = {"outcome_pool": "Pool entraîné sur les résultats (avec Atlas)", "pool_without_provider": "Pool sans Atlas (témoin)",
        "public_only": "Historique public seul", "behaviour_clone": "Clonage des actions d'Atlas"}


def f(stat, digits=2, pct=False):
    if pct:
        return f"{100 * stat['mean']:.1f} % ± {100 * stat['std']:.1f}"
    return f"{stat['mean']:.{digits}f} ± {stat['std']:.{digits}f}"


def main():
    data = json.loads(open(sys.argv[1]).read())
    s = data["summary"]
    print(f"# Location d'expérience entre agents — synthèse ({data['seeds']} graines, moyenne ± écart-type)\n")
    print("## Valeur pour le borrower (période de test, sources live du borrower, coûts de 5 pb inclus)\n")
    print("| Scénario | IC | Sharpe annualisé | Couverture |\n|---|---|---|---|")
    for key, label in SCENARIOS:
        r = s["scenarios"][key]
        print(f"| {label} | {f(r['ic'], 3)} | {f(r['sharpe'])} | {f(r['coverage'], pct=True)} |")
    print("\n## Providers : historique vérifiable et valeur de leurs données\n")
    print("| Provider | Records | Sharpe annoncé | Sharpe vérifié on-chain | Shapley (IC) | Shapley si Mirage non vérifié |")
    print("|---|---|---|---|---|---|")
    for name, p in s["providers"].items():
        sh = s["shapley"].get(name)
        print(f"| {name} | {p['records']['mean']:.0f} | {f(p['claimed_sharpe'])} | {f(p['verified_sharpe'])} | "
              f"{f(sh, 4) if sh else '—'} | {f(s['shapley_unverified_cheater'][name], 4)} |")
    print("\n## Inférence d'appartenance sur les records d'Atlas (AUC 0,5 = aucun signal)\n")
    print("| Capacité du modèle | AUC | IC test | Sharpe test |\n|---|---|---|---|")
    for key, label in CAPACITY.items():
        m = s["membership"][key]
        print(f"| {label} | {f(m['auc'], 3)} | {f(m['ic'], 3)} | {f(m['sharpe'])} |")
    print("\n## Fuite de stratégie : accord avec les futurs trades d'Atlas\n")
    print("| Modèle livré | Accord de direction |\n|---|---|")
    for key, label in LEAK.items():
        print(f"| {label} | {f(s['strategy_leak'][key], pct=True)} |")


if __name__ == "__main__":
    main()
