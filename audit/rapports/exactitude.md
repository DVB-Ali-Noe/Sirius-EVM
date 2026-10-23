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

**Réponse : avec le profil actuel, le gonflement est négligeable : +0,001 d'AUC au plus en moyenne (max +0,003),
même avec 20 % de doublons. Ce n'est pas le split qui protège, c'est la bride du modèle : un modèle qui mémorise
gonflerait de +0,013 (5 %) à +0,065 (20 %).**

Protocole (`audit/exactitude/q3_duplicates.py`, puis `q3_paired.py`) sur Taïwan, 4 graines :
6 000 lignes tirées au hasard forment un test externe propre ; les 24 000 autres forment le fichier, auquel on
ajoute 5 % ou 20 % de copies exactes, soit dispersées au hasard, soit juste après l'original (export ou
jointure qui répète des lignes). Sirius s'entraîne avec son split `index % 5 === 4`.

Deux mesures du gonflement :
- **appariée** (même modèle, mêmes lignes) : AUC held-out affichée − AUC des seules lignes held-out sans copie
  dans l'entraînement. Peu bruitée.
- **externe** : AUC affichée − AUC sur le test externe propre. Bruitée (écart type ≈ 0,01 entre graines).

| Doublons | Placement | Lignes held-out ayant une copie dans l'entraînement | Gonflement apparié Sirius (moyenne / max) | Gonflement externe Sirius (moyenne ± écart type) | Gonflement externe modèle qui mémorise* |
|---|---|---|---|---|---|
| 0 % | — | 0,14 % (doublons naturels de Taïwan) | −0,0002 / −0,0000 | −0,0003 ± 0,011 | +0,001 ± 0,016 |
| 5 % | dispersés | 7,9 % | +0,0010 / +0,0030 | +0,0000 ± 0,010 | +0,014 ± 0,009 |
| 20 % | dispersés | 26,7 % | +0,0009 / +0,0012 | +0,0045 ± 0,008 | +0,053 ± 0,007 |
| 5 % | adjacents | 9,8 % | −0,0006 / +0,0023 | +0,0043 ± 0,011 | +0,024 ± 0,015 |
| 20 % | adjacents | 33,8 % | −0,0016 / +0,0018 | +0,0014 ± 0,014 | +0,065 ± 0,013 |

\* scikit-learn HGB sans bride (profondeur libre, 63 feuilles, 1 ligne par feuille, 100 arbres) sur le même split.

Lecture : avec 20 % de doublons adjacents, un tiers des lignes « jamais vues » ont en réalité leur copie exacte
dans l'entraînement. La phrase de la documentation « jamais utilisée pour l'entraînement » est vraie pour la
ligne, pas pour son contenu (EXA-07). Aujourd'hui sans effet mesurable grâce aux feuilles d'au moins 1 000 lignes ;
le jour où le profil s'assouplit (v2 plus profonde), l'AUC affichée deviendra optimiste de plusieurs points.

Reproduire :
```
python -I audit/exactitude/q3_duplicates.py 4
python -I audit/exactitude/q3_paired.py
```
Résultats bruts : `audit/exactitude/resultats/q3-doublons.json`.

### Q4. Contrôle trainAuc >= heldOutAuc − 0,02

(à remplir)

### Q5. Constantes de gbdt.ts et version du registre

**Réponse : aucun test du dépôt ne liait les constantes à la version (EXA-06). Test ajouté :
`audit/exactitude/tests/profile-version.test.ts`, vérifié par mutation.**

Principe :
1. `PUBLISHED_PROFILES["1.0.0"]` fige **toutes** les constantes numériques exportées par `gbdt.ts`, relevées
   automatiquement (`import * as gbdt`) : une constante modifiée, ajoutée ou retirée fait échouer le test.
2. Il fige aussi l'empreinte SHA-256 du modèle livré sur `public/examples/classification/credit-risk-train.csv`
   (`94c88d03…c865`, 27 950 octets) : un changement d'algorithme dans `train-gbdt.ts` à constantes égales
   fait aussi échouer le test.
3. Le test lit `MODEL_REGISTRY.gradient_boosted_trees.version` : pour changer le profil, il faut incrémenter
   la version **et** ajouter une entrée. Une version publiée ne peut plus changer de contenu.

Preuve par mutation (sans toucher au code de production : la source est modifiée au chargement par
`audit/exactitude/tests/mutate-gbdt.cjs`) :

| Mutation | Résultat |
|---|---|
| aucune | 3 tests sur 3 passent |
| `GBDT_TREES = 150` → `149` dans `gbdt.ts` | tests 1 et 2 échouent : « constantes changées sans nouvelle version (GBDT_TREES: 150 → 149) » |
| dans `train-gbdt.ts`, une coupe presque aussi bonne remplace la meilleure (`mutate-train-gbdt.cjs`) | test 2 échoue : « modèle de référence changé sans nouvelle version » |
| dans `train-gbdt.ts`, `Math.floor` → `Math.round` dans le calcul des quantiles | **non détecté** : sur ce fichier, 8 320 lignes / 64 tombe juste, le modèle ne change pas |

Limite : l'empreinte ne couvre qu'un fichier de référence. Une modification qui ne change rien sur ce fichier
passe (dernière ligne). Ajouter un 2e fichier de référence à nombre de lignes « non rond » (par exemple
10 007 lignes) réduirait ce trou.

Pourquoi c'est important : la version entre dans `trainingProfileHash` (`registry.ts:122`), qui est publié
on-chain. Changer une constante sans changer la version ferait attester sous le même identifiant un algorithme
différent de celui que l'acheteur a choisi.

Reproduire :
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/profile-version.test.ts
NODE_OPTIONS="--conditions=react-server" node --require ./audit/exactitude/tests/mutate-gbdt.cjs --import tsx --test audit/exactitude/tests/profile-version.test.ts
NODE_OPTIONS="--conditions=react-server" node --require ./audit/exactitude/tests/mutate-train-gbdt.cjs --import tsx --test audit/exactitude/tests/profile-version.test.ts
```

### Q6. Déterminisme

**Réponse : oui, même fichier → même modèle octet pour octet (même processus, deux processus, worker du runner).
Mais « mêmes données » ne veut pas dire « même fichier » : l'ordre des lignes et un BOM changent le modèle.**

Test : `audit/exactitude/tests/determinism.test.ts` (6 tests, tous passent).

| Cas | Résultat |
|---|---|
| 5 entraînements successifs, même processus (credit-risk-train) | 1 seule empreinte SHA-256 |
| 2 processus Node distincts (credit-risk-train et Taïwan 30 000 lignes) | même empreinte, égale à celle du processus de test |
| `trainInWorker` (chemin du runner, limites mémoire) contre appel direct | même empreinte |
| fins de ligne LF / CRLF, avec ou sans retour final | même modèle |
| mêmes lignes en ordre inverse | autre modèle et autre AUC held-out (le split dépend de la position) |
| CSV UTF-8 avec BOM (export « CSV UTF-8 » d'Excel) | la 1re variable s'appelle `\uFEFFage_years` ; l'évaluation du navigateur échoue (EXA-04) |

Ce qui rend le calcul déterministe (lu dans le code) : aucun tirage aléatoire ; tri numérique de `Float64Array` ;
égalités départagées par l'index (`binaryAuc`) ou par la plus petite variable puis le plus petit seuil
(`bestSplit`, comparaison stricte `gain > bestGain`) ; ordre des sommes fixe.

Point d'attention : le délai d'entraînement est une **horloge murale** (`performance.now`, 15 s par défaut).
Le modèle ne dépend pas du temps, mais la *réussite* oui : sur ce poste chargé par d'autres calculs, Taïwan
(4,6 s au repos) a dépassé 30 s et a été refusé (« budget de calcul dépassé »). Même fichier, même code :
succès ou échec selon la charge (EXA-05). Pour les mesures, les scripts d'audit ralentissent l'horloge du délai
(`AUDIT_SLOW_CLOCK=10`), ce qui ne change pas le modèle (vérifié : empreintes identiques).

Non vérifié : autre version de Node, autre processeur, et la CVM Phala elle-même (aucune session lancée).
`Math.exp` est calculé par V8 ; une autre version de V8 pourrait changer un ulp des gradients, donc
potentiellement un départage de coupe et l'empreinte (NON VÉRIFIÉ).

Reproduire :
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/determinism.test.ts
```

### Q7. Arbres contre régression logistique sur données réelles et cas difficiles

(à remplir)

## Tests et scripts ajoutés

(à remplir)

## Points NON VÉRIFIÉS

(à remplir)
