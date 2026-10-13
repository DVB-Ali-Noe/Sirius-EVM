# Location d'expérience entre agents

Hypothèse : l'actif privé d'un agent de trading n'est ni sa stratégie ni les prix (publics), mais le **contexte qu'il a vu au moment de décider**. Ce sont des signaux éphémères (sentiment, déséquilibre de flux) que personne ne peut reconstruire après coup. Un agent qui démarre loue cet historique à des agents plus anciens. Sirius entraîne le modèle dans l'enclave, sur les **résultats** observés et non sur les actions des providers, puis livre le modèle au borrower.

```bash
uv run --python 3.13 lend.py --seeds 10 --out runs     # ~5 min sur CPU
python3 summary.py runs/results.json > runs/summary.md
```

- `world.py` : marché synthétique, avec 40 actions tokenisées, un régime caché et un rendement non linéaire.
- **Les agents :**
  - quatre providers honnêtes, dont Pine, qui a les meilleurs capteurs mais une mauvaise règle de trading ;
  - Mirage, un tricheur qui fabrique son historique après coup ;
  - le borrower, qui ne dispose que de 40 jours d'historique.
- **Engagements :** chaque record porte l'heure de son engagement on-chain. Un record n'est accepté que s'il a été engagé avant le résultat qu'il prédit.
- `lend.py` : scénarios, valeur de Shapley des providers, inférence d'appartenance selon la capacité du modèle et fuite de stratégie.

## Résultats (10 graines, voir `runs/summary.md`)

Toutes les données sont synthétiques et le signal est volontairement fort : les Sharpe absolus sont gonflés. Seules les comparaisons entre scénarios comptent.

| Scénario | IC test | Sharpe |
|---|---|---|
| Historique public seul (gratuit) | 0,007 | −0,89 |
| Historique propre (40 jours) | 0,040 | 1,37 |
| + 1 provider loué | 0,071 – 0,086 | 3,3 – 4,6 |
| + pool de 4 providers | 0,088 | 5,44 |
| Pool + tricheur non vérifié | 0,038 | 2,06 |
| Pool + tricheur, engagements vérifiés | 0,088 | 5,44 |
| Plafond (capteurs parfaits) | 0,108 | 6,67 |

## Ce que ça montre

1. **Louer l'expérience vaut bien plus que l'historique public.** Une seule location double l'IC du borrower, et le pool atteint 80 % du plafond. Les prix publics seuls ne donnent presque rien, car la valeur est dans le contexte éphémère.
2. **La valeur des données n'est pas le talent de trading.** Pine perd de l'argent (Sharpe vérifié −1,34), mais ses données sont les deuxièmes plus utiles selon la valeur de Shapley. Un agent médiocre peut donc vendre son expérience.
3. **Les engagements on-chain sont indispensables.** Mirage affiche un Sharpe annoncé de 69,8, alors que son Sharpe vérifié sur ses vrais trades est de 5,2. Sans vérification, son historique fabriqué divise l'IC du pool par plus de deux. Avec la règle « engagé avant le résultat », ses records sont exclus et le pool redevient intact.
4. **La valeur de Shapley détecte aussi le tricheur** (−0,087), et peut servir de clé de répartition des paiements entre providers honnêtes. Elle reste bruitée d'une graine à l'autre : il faut une fenêtre de valorisation plus longue avant d'en faire une règle de paiement.
5. **Les arbres sont nécessaires.** Une régression linéaire sur le même pool perd environ un quart de l'IC, parce que le signal dépend du régime.
6. **Brider le modèle protège contre l'inférence d'appartenance, sans coût d'utilité.** Avec des arbres libres, l'AUC monte à 0,66 et le modèle surapprend (IC 0,039). Avec la profondeur 3 et des feuilles d'au moins 200 records, l'AUC tombe à 0,50 et l'IC monte à 0,089.
7. **Ce qui ressemble à une fuite de stratégie est surtout un signal commun.** Le pool reproduit 82,6 % des trades d'Atlas, mais le même pool *sans* Atlas en reproduit déjà 81,1 %. Entraîner sur les résultats ne livre pas la règle d'Atlas, alors que cloner ses actions la copie à 99,9 %. Règle produit : louer l'expérience, jamais la politique.

## Limites

- **Marché simulé.** Signal fort, un seul type d'actif, coûts simples (5 pb par unité de position changée). Rien ne garantit ces ordres de grandeur sur Robinhood Chain.
- **Ce que l'engagement prouve, et ce qu'il ne prouve pas.** Il prouve qu'un contexte a été engagé avant le résultat. Il ne prouve pas que ce contexte est sincère : un provider pourrait engager chaque jour du bruit sans valeur. La valeur de Shapley et la réputation doivent couvrir ce cas.
- **Fuite des données.** L'attaque testée est la plus simple (seuil sur la perte). Les attaques plus fortes et la reconstruction des contextes éphémères à partir du modèle ne sont pas testées.
- **Écart avec le runner actuel.** Les engagements quotidiens, l'entraînement sur plusieurs datasets à la fois et la répartition des paiements n'existent pas dans le runner Sirius. Cette expérience ne valide pas leur implémentation.

## Sur données réelles (13 octobre)

Retesté sur Binance (8 perpétuels, 2025, carnet d'ordres, open interest et ratios long/short réels) dans `../model-zoo/real/r3_binance_experience.py` : **aucun gain mesurable**. À 4 h et à 24 h, tous les scénarios restent dans le bruit (IC de −0,01 à 0,05, erreur d'environ ±0,03). À 24 h, les 30 derniers jours du borrower font mieux que l'historique loué. Les gains ci-dessus viennent du signal mis dans le générateur synthétique. Détails : `../model-zoo/NewModels/Données réelles.md`.
