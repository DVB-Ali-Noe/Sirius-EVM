# Audit d'exactitude — arbres boostés (GBDT) et leurs métriques

- Dépôt : DVB-Ali-Noe/Sirius-EVM, branche d'audit `audit/exactitude`
- Base auditée : `origin/staging` au SHA `f31a917bf48a51d8d8505b8a50cde9ed0a353853`
- Date : 23 octobre 2026
- Environnement : Node 22.16.0, Python 3.13.5, scikit-learn 1.7.2
- Fichiers audités : `src/lib/tee/train-gbdt.ts`, `src/lib/models/gbdt.ts`, `src/lib/models/registry.ts`,
  `src/lib/tee/output-gate.ts`, `src/lib/train/evaluation-client.ts`, `src/lib/tee/train.ts`

> Travail en cours. Les sections sont remplies question par question.

## Résumé

(à remplir)

## Constats

(à remplir)

## Questions

### Q1. AUC held-out contre scikit-learn

**Réponse : oui, l'écart est ≤ 0,001 sur les 3 jeux (critère ≤ 0,01 respecté).**

Méthode : `audit/exactitude/compare_sklearn.py`. Même CSV, même séparation que Sirius (ligne d'index
`i % 5 == 4` → held-out), mêmes colonnes que le modèle Sirius, `HistGradientBoostingClassifier(max_iter=150,
learning_rate=0.1, max_depth=2, max_leaf_nodes=None, max_bins=64, min_samples_leaf=1000, l2_regularization=1.0,
early_stopping=False)`. L'AUC Sirius est celle livrée dans `metrics.heldOutAuc` ; elle a aussi été recalculée
par `sklearn.metrics.roc_auc_score` à partir des probabilités du navigateur (`predictModel`).

| Jeu | Lignes | Variables utilisées | AUC held-out Sirius (livrée) | Même AUC recalculée par sklearn | AUC held-out sklearn HGB | Écart Sirius − sklearn | AUC train Sirius / sklearn |
|---|---|---|---|---|---|---|---|
| credit-risk.csv (dépôt, synthétique) | 13 000 | 6 / 6 | 0,716932 | 0,716932 | 0,717420 | −0,00049 | 0,7283 / 0,7286 |
| OpenML 42477 Taïwan | 30 000 | 23 / 23 | 0,786757 | 0,786757 | 0,786288 | +0,00047 | 0,7888 / 0,7878 |
| OpenML 46929 GMSC (40 000 premières lignes) | 40 000 | **8 / 10** | 0,869507 | 0,869507 | 0,869935 | −0,00043 | 0,8634 / 0,8636 |

Remarques :
- La fonction `binaryAuc` de `gbdt.ts` donne exactement l'AUC de scikit-learn (à l'arrondi à 6 chiffres près).
- GMSC : Sirius a écarté **sans le dire** `MonthlyIncome` et `NumberOfDependents`, car ces colonnes ont des
  cellules vides (voir EXA-03). À colonnes égales, l'écart à sklearn reste −0,0004. Pour information, sklearn avec
  les 10 colonnes (valeurs manquantes gérées nativement) donne 0,8687 : sur ce jeu, perdre ces 2 colonnes ne coûte
  rien en AUC.
- GMSC complet (150 000 lignes) n'est pas entraînable : le parseur CSV s'arrête à 50 000 lignes
  (`MAX_CSV_ROWS`) et le budget arbres (300 M d'opérations) plafonne 8 variables à 125 000 lignes. D'où le
  sous-ensemble des 40 000 premières lignes, dans l'ordre OpenML.
- Durée d'entraînement mesurée sur ce poste (hors worker) : 0,6 s (credit-risk), 4,6 s (Taïwan), 3,0 s (GMSC),
  sous le délai par défaut de 15 s.

Reproduire :
```
python -I audit/exactitude/prepare_data.py <cache_openml> audit/exactitude/.data
NODE_OPTIONS="--conditions=react-server" node --import tsx audit/exactitude/sirius-run.ts audit/exactitude/.data/taiwan.csv audit/exactitude/.data/out/taiwan.json
python -I audit/exactitude/compare_sklearn.py audit/exactitude/.data/taiwan.csv audit/exactitude/.data/out/taiwan.json audit/exactitude/resultats/q1-q7-taiwan.json
```
(idem pour `credit-risk` et `gmsc`). Résultats bruts : `audit/exactitude/resultats/q1-q7-*.json`.

### Q2. Prédictions du navigateur contre modèle livré

**Réponse : oui. Écart maximal 1,1 × 10⁻¹⁶ (un ulp) sur 83 000 lignes, aucune étiquette différente (critère 1e-6 respecté).**

Test : `audit/exactitude/tests/browser-vs-enclave.test.ts`. Pour chaque jeu, le modèle sorti de
`trainGradientBoostedTrees` (avant output-gate) est parcouru par une implémentation indépendante ; le même modèle
passe ensuite par `gateModel` → JSON → `parseDeliveredModel` → `predictModel` (code du navigateur).

| Jeu | Lignes comparées | Écart max de probabilité | Étiquettes 0/1 différentes | Écart max métriques held-out (navigateur vs livrées) |
|---|---|---|---|---|
| credit-risk.csv | 13 000 | 1,1 × 10⁻¹⁶ | 0 | 4,1 × 10⁻⁷ (précision) |
| Taïwan | 30 000 | 1,1 × 10⁻¹⁶ | 0 | 4,4 × 10⁻⁷ (rappel) |
| GMSC (40 000) | 40 000 | 1,1 × 10⁻¹⁶ | 0 | 4,3 × 10⁻⁷ (F1) |

- L'output-gate ne modifie ni les seuils ni les feuilles (déjà arrondis pendant l'entraînement) : `deepEqual` exact.
- Les écarts de métriques (< 5 × 10⁻⁷) viennent uniquement de l'arrondi à 6 chiffres significatifs des métriques
  livrées ; ils restent sous 1e-6.
- Une valeur exactement égale au seuil part à droite des deux côtés ; « 1e3 », « 1000 » et « 1000.0 » donnent le même
  résultat.
- Limite : seul le moteur JavaScript V8 (Node 22) a été testé. Dans un autre navigateur (Firefox, Safari),
  `Math.exp` peut différer d'un ulp ; cela reste très loin de 1e-6, mais n'a pas été mesuré (NON VÉRIFIÉ).

Reproduire :
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/browser-vs-enclave.test.ts
```

### Q3. Doublons et split fixe

(à remplir)

### Q4. Contrôle trainAuc >= heldOutAuc − 0,02

(à remplir)

### Q5. Constantes de gbdt.ts et version du registre

(à remplir)

### Q6. Déterminisme

(à remplir)

### Q7. Arbres contre régression logistique sur données réelles et cas difficiles

(à remplir)

## Tests et scripts ajoutés

(à remplir)

## Points NON VÉRIFIÉS

(à remplir)
