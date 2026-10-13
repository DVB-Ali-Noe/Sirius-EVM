# Location d'expérience entre agents — synthèse (10 graines, moyenne ± écart-type)

## Valeur pour le borrower (période de test, sources live du borrower, coûts de 5 pb inclus)

| Scénario | IC | Sharpe annualisé | Couverture |
|---|---|---|---|
| Historique public seul (reconstructible depuis la chaîne, gratuit) | 0.007 ± 0.010 | -0.89 ± 0.98 | 28.8 % ± 27.5 |
| Historique propre du borrower (40 jours) | 0.040 ± 0.011 | 1.37 ± 0.95 | 36.8 % ± 32.6 |
| + location d'Atlas | 0.086 ± 0.011 | 4.61 ± 1.00 | 50.7 % ± 28.7 |
| + location de Kite | 0.071 ± 0.013 | 3.30 ± 1.42 | 59.9 % ± 34.5 |
| + location d'Orion | 0.077 ± 0.014 | 3.97 ± 1.28 | 50.8 % ± 27.7 |
| + location de Pine (mauvais trader, meilleurs capteurs) | 0.082 ± 0.013 | 4.31 ± 1.19 | 32.6 % ± 14.8 |
| + pool des 4 providers honnêtes | 0.088 ± 0.009 | 5.44 ± 1.14 | 50.9 % ± 17.7 |
| Pool, régression linéaire au lieu des arbres | 0.067 ± 0.010 | 3.04 ± 1.02 | 37.7 % ± 25.4 |
| Pool + Mirage (historique fabriqué), sans vérification | 0.038 ± 0.025 | 2.06 ± 2.10 | 47.7 % ± 10.1 |
| Pool + Mirage, engagements on-chain vérifiés | 0.088 ± 0.009 | 5.44 ± 1.14 | 50.9 % ± 17.7 |
| Plafond : capteurs parfaits, tout l'historique | 0.108 ± 0.011 | 6.67 ± 1.11 | 40.0 % ± 12.1 |

## Providers : historique vérifiable et valeur de leurs données

| Provider | Records | Sharpe annoncé | Sharpe vérifié on-chain | Shapley (IC) | Shapley si Mirage non vérifié |
|---|---|---|---|---|---|
| Atlas | 11400 | 6.30 ± 0.60 | 6.30 ± 0.60 | 0.0207 ± 0.0092 | 0.0209 ± 0.0083 |
| Kite | 6000 | 5.21 ± 0.98 | 5.21 ± 0.98 | 0.0091 ± 0.0118 | 0.0099 ± 0.0088 |
| Orion | 9250 | 5.77 ± 1.11 | 5.77 ± 1.11 | 0.0105 ± 0.0094 | 0.0138 ± 0.0075 |
| Pine | 7500 | -1.34 ± 0.75 | -1.34 ± 0.75 | 0.0170 ± 0.0103 | 0.0169 ± 0.0075 |
| Mirage | 11400 | 69.79 ± 2.90 | 5.16 ± 0.74 | — | -0.0868 ± 0.0530 |

## Inférence d'appartenance sur les records d'Atlas (AUC 0,5 = aucun signal)

| Capacité du modèle | AUC | IC test | Sharpe test |
|---|---|---|---|
| Libre (feuilles de 2, 600 itérations) | 0.663 ± 0.005 | 0.039 ± 0.010 | 0.98 ± 1.13 |
| Standard (profondeur 3, feuilles ≥ 200) | 0.500 ± 0.005 | 0.089 ± 0.009 | 5.13 ± 0.60 |
| Bridé (profondeur 2, feuilles ≥ 1000) | 0.499 ± 0.005 | 0.094 ± 0.012 | 5.41 ± 1.43 |

## Fuite de stratégie : accord avec les futurs trades d'Atlas

| Modèle livré | Accord de direction |
|---|---|
| Pool entraîné sur les résultats (avec Atlas) | 82.6 % ± 2.5 |
| Pool sans Atlas (témoin) | 81.1 % ± 2.8 |
| Historique public seul | 54.7 % ± 2.1 |
| Clonage des actions d'Atlas | 99.9 % ± 0.1 |
