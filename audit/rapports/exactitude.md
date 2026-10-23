# Audit d'exactitude — arbres boostés (GBDT) et leurs métriques

- Dépôt : DVB-Ali-Noe/Sirius-EVM, branche d'audit `audit/exactitude`
- Base auditée : `origin/staging` au SHA `f31a917bf48a51d8d8505b8a50cde9ed0a353853`
- Date : 23 octobre 2026
- Environnement : Node 22.16.0, Python 3.13.5, scikit-learn 1.7.2
- Fichiers audités : `src/lib/tee/train-gbdt.ts`, `src/lib/models/gbdt.ts`, `src/lib/models/registry.ts`,
  `src/lib/tee/output-gate.ts`, `src/lib/train/evaluation-client.ts`, `src/lib/tee/train.ts`

## Résumé

1. Les arbres Sirius sont exacts : AUC held-out à moins de 0,0005 de scikit-learn réglé pareil sur les 3 jeux publics (critère 0,01).
2. Le navigateur prédit exactement comme le modèle livré : écart maximal 1,1 × 10⁻¹⁶ sur 83 000 lignes (critère 1e-6).
3. Même fichier → même modèle, octet pour octet (même processus, deux processus, worker du runner).
4. Les doublons ne gonflent pas l'AUC affichée (≤ +0,001 apparié) grâce à la bride du profil, pas grâce au split.
5. Le contrôle `trainAuc >= heldOutAuc − 0,02` n'existe que dans un test, n'a qu'un sens, laisse passer une
   mémorisation flagrante (écart 0,24) et s'est déclenché à tort sur un tirage légitime de GMSC.
6. Aucun test ne liait les constantes de `gbdt.ts` à la version du profil : test ajouté, vérifié par mutation.
7. Sur données réelles, les arbres battent la logistique Sirius de +0,06 à +0,21 d'AUC et sont mieux calibrés ;
   gain de la règle d'octroi ×1,2 à ×3,8.
8. Ils sont inutiles ou pires sur une relation purement linéaire, sur 2 % de défauts (décision inchangée) et
   quand le futur ne ressemble pas au passé (le held-out entrelacé ne prévient pas).
9. Pièges trouvés : BOM d'Excel qui casse l'évaluation, colonnes avec une cellule vide écartées, délai en
   horloge murale (succès ou échec selon la charge), logistique sous-convergée (probabilités tassées).
10. Constats : 0 critique, 0 haute, 7 moyennes, 3 basses.

## Constats

| ID | Sévérité | Fichier:ligne | Ce qui se passe | Comment le reproduire | Correction proposée |
|---|---|---|---|---|---|
| EXA-01 | Moyenne | `src/lib/tee/train-gbdt.test.ts:90`, `src/app/docs/page.tsx:147` | Le seul garde-fou train / held-out est `trainAuc >= heldOutAuc - 0.02`, dans un test unitaire (rien en production). Il n'a qu'un sens : il accepte une mémorisation (train 0,998 / held-out 0,754) et un held-out corrompu (étiquettes inversées, held-out 0,33). Sa marge fixe ignore la taille du held-out : il s'est déclenché à tort sur 1 tirage légitime sur 36 (GMSC, held-out meilleur de 0,021 = 2,2 erreurs types). La doc promet qu'« un écart important signale une mémorisation » sans dire ce qu'est « important ». | `python -I audit/exactitude/q4_gap.py 6` ; `node --import tsx --test audit/exactitude/tests/two-sided-gap.test.ts` | Contrôle à deux sens en erreurs types (`audit/exactitude/two-sided-gap.ts`) : alerte « held-out trop beau » si held − train > 3·SE, « mémorisation » si train − held > 0,02 + 3·SE. L'utiliser dans le test à la place de la ligne 90, et afficher l'alerte dans la page d'entraînement (les effectifs se déduisent des métriques livrées, `heldOutClassCounts`). |
| EXA-02 | Moyenne | `src/lib/tee/train.ts:16-18`, `:257-278` | La logistique « actuelle » fait 200 pas de gradient à 0,1 : son classement est proche de l'optimum (AUC −0,000 à −0,016 contre une logistique convergée) mais ses probabilités sont tassées vers la moyenne : pente de calibration 1,21 (Taïwan), 1,58 (GMSC), 3,88 (2 % de défauts) au lieu de ≈ 1. La règle « accorder si P < 1/6 » perd du gain (credit-risk 8,1 contre 11,5 pour 1 000 dossiers ; GMSC 123,1 contre 131,1). | `python -I audit/exactitude/compare_sklearn.py …` puis `python -I audit/exactitude/q7_logistic_ref.py` | Itérer jusqu'à convergence (Newton / IRLS, quelques itérations suffisent avec ≤ 32 paramètres) ; nouvelle version du profil logistique. |
| EXA-03 | Moyenne | `src/lib/tee/train.ts:34-36`, `:78` | Une colonne est utilisée seulement si **toutes** ses cellules sont numériques : une seule cellule vide l'écarte entièrement. Sur GMSC, `MonthlyIncome` et `NumberOfDependents` disparaissent (8 variables sur 10). L'assistant affiche le nombre de colonnes numériques, pas la raison de l'écart. Si la cible elle-même a une cellule vide, la cible devient en silence la colonne numérique précédente (les arbres refusent alors avec « la cible … doit être strictement 0 ou 1 », message trompeur). | `node --import tsx audit/exactitude/sirius-run.ts audit/exactitude/.data/gmsc.csv …` → `features` a 8 éléments | Dans l'assistant, lister les colonnes écartées et le nombre de cellules vides ; refuser explicitement une cible non entièrement numérique. (Gérer les valeurs manquantes dans les arbres serait un nouveau profil.) |
| EXA-04 | Moyenne | `src/lib/tee/train.ts:64`, `src/lib/sirius/metrics.ts:17`, `src/app/(app)/train/page.tsx:932` | Un CSV « UTF-8 avec BOM » (export Excel courant) : l'enclave lit les octets avec `Buffer.toString`, qui garde le BOM ; la 1re variable s'appelle `\uFEFFage_years`. Le navigateur lit le fichier de test avec `File.text()`, qui retire le BOM : l'évaluation échoue (« Le CSV de test doit contenir la cible et les mêmes features »). Le nom invisible sort aussi dans le modèle livré. | `node --import tsx --test audit/exactitude/tests/determinism.test.ts` (test « BOM ») | Retirer un `\uFEFF` initial dans `parseCsv` (des deux côtés). Les fichiers sans BOM ne changent pas d'un octet. |
| EXA-05 | Moyenne | `src/lib/tee/train.ts:38-48`, `src/lib/tee/train-gbdt.ts:41` | Le délai d'entraînement est une horloge murale (15 s par défaut, 30 s max). Le modèle n'en dépend pas, mais la réussite oui : Taïwan (30 000 × 23) prend 4,6 s au repos et a été refusé (« budget de calcul dépassé », 30 016 ms) quand le poste était chargé. Même fichier, même code, résultat différent selon la charge de la machine. | Lancer `sirius-run.ts` sur Taïwan pendant une autre charge CPU ; ou comparer `treesMs` au repos et en charge | Garder le budget en opérations (`GBDT_MAX_OPERATIONS`, déterministe) comme limite principale et une horloge large (≥ 4× le temps mesuré sur la CVM) comme simple filet ; mesurer le temps réel sur la CVM au plafond du budget. |
| EXA-06 | Moyenne | `src/lib/models/gbdt.ts:14-32`, `src/lib/models/registry.ts:27` | Rien n'empêchait de modifier une constante du profil (ou l'algorithme) sans changer `version` ; or la version entre dans `trainingProfileHash` publié on-chain : le même identifiant attesterait un autre algorithme. | `node --require ./audit/exactitude/tests/mutate-gbdt.cjs --import tsx --test audit/exactitude/tests/profile-version.test.ts` → échoue ; sans `--require` → passe | Intégrer `audit/exactitude/tests/profile-version.test.ts` à `pnpm test` ; ajouter un 2e fichier de référence à nombre de lignes non rond (la mutation `floor → round` des quantiles n'est pas vue sur 8 320 lignes). |
| EXA-07 | Basse | `src/lib/models/gbdt.ts:20-21`, `src/lib/tee/train-gbdt.ts:23`, `src/app/docs/page.tsx:147` | Le split `index % 5 === 4` ne déduplique pas : avec 20 % de doublons, 27 % (dispersés) à 34 % (adjacents) des lignes held-out ont leur copie exacte dans l'entraînement. Effet aujourd'hui ≤ +0,001 d'AUC grâce aux feuilles ≥ 1 000 lignes, mais +0,05 à +0,065 avec un modèle moins bridé. « Jamais utilisée pour l'entraînement » est vrai pour la ligne, pas pour son contenu. | `python -I audit/exactitude/q3_duplicates.py 4` puis `q3_paired.py` | Avant tout profil plus profond : séparer par empreinte de ligne (hash du contenu) plutôt que par position, ou dédupliquer avant le split. Préciser la doc. |
| EXA-08 | Moyenne | `src/lib/models/gbdt.ts:38-40`, `src/app/docs/page.tsx:142-147` | Le held-out est entrelacé (1 ligne sur 5 partout dans le fichier). Sur des données triées dans le temps, l'AUC affichée décrit la période passée, pas le futur : −0,054 d'écart (rupture : 0,734 affiché, 0,680 sur les 20 % les plus récents) ou +0,047 (dérive favorable). La calibration se dégrade aussi (ECE 0,021 → 0,119). Aucune mention dans la doc. | `python -I audit/exactitude/q7_hard_cases.py` et `… temporel-rupture` | Documenter que le held-out n'est pas un test « futur » ; conseiller au fournisseur de garder sa période la plus récente hors du fichier et à l'emprunteur d'évaluer sur un CSV récent (l'évaluation navigateur le permet déjà). |
| EXA-09 | Basse | `src/lib/tee/train-gbdt.ts:223-234` | Précision, rappel, F1 et accuracy held-out sont calculés au seuil 0,5. Sur 2 % de défauts : précision = rappel = F1 = 0, accuracy 0,981 (le modèle ne prédit jamais 1) alors que l'AUC vaut 0,758. Sur GMSC, rappel 0,18. Ces chiffres sont exacts mais trompeurs pour du crédit. | `python -I audit/exactitude/q7_hard_cases.py` (cas `desequilibre-2pct`) | Afficher à côté le taux de défaut held-out et préciser « au seuil 0,5 » ; dans un futur profil, livrer Brier et une métrique au seuil métier. |
| EXA-10 | Basse | `src/lib/tee/train.ts:289-320`, `src/app/(app)/train/page.tsx:641-642` | Les métriques de la logistique sont calculées sur les lignes d'entraînement, celles des arbres sur le held-out. La liste des entraînements affiche « Accuracy » pour l'une, « Held-out AUC » pour l'autre : comparer deux profils sur ces chiffres compare deux choses différentes. | lecture du code | Libeller « Accuracy (entraînement) » ; à terme, même split held-out pour tous les profils. |

Aucun constat critique ou haut : aucune fuite de données, aucune métrique livrée fausse, aucun écart enclave /
navigateur n'a été trouvé dans le périmètre.

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

**Réponse : non, il ne suffit pas (EXA-01).** Il n'existe que dans un test (`train-gbdt.test.ts:90`), il n'a qu'un
sens et sa marge est fixe alors que l'aléa de l'AUC held-out dépend de sa taille.

Mesure (`audit/exactitude/q4_gap.py 6`) : ordre des lignes mélangé (6 graines par jeu, 18 pour Taïwan à 10 000
lignes), donc split et modèle différents à chaque fois ; SE = erreur type de Hanley-McNeil de l'AUC held-out.

| Jeu | Tirages | Écart train − held-out : moyenne (min ; max) | Écart type de l'AUC held-out entre tirages | SE moyenne | Alertes contrôle actuel | Alertes contrôle proposé |
|---|---|---|---|---|---|---|
| credit-risk 13 000 | 6 | +0,009 (−0,005 ; +0,019) | 0,008 | 0,013 | 0 | 0 |
| Taïwan 30 000 | 6 | +0,011 (+0,007 ; +0,015) | 0,003 | 0,008 | 0 | 0 |
| GMSC 40 000 | 6 | +0,004 (−0,021 ; +0,021) | 0,012 | 0,010 | **1 (fausse alerte)** | 0 |
| Taïwan 10 000 | 18 | +0,020 (−0,014 ; +0,048) | 0,012 | 0,014 | 0 | 0 |
| Modèle qui mémorise (sklearn sans bride, Taïwan 10 000) | 3 | **+0,216 à +0,243** | — | 0,014 | **0 (raté)** | 3 / 3 |

Constats chiffrés :
- La seule alerte du contrôle actuel est une fausse alerte : GMSC, held-out meilleur que le train de 0,0212 par
  pur hasard (2,2 SE).
- Une mémorisation flagrante (train 0,998, held-out 0,754) passe le contrôle actuel.
- Un held-out corrompu (étiquettes inversées sur les lignes held-out, held-out 0,33) passe aussi le contrôle
  actuel (`two-sided-gap.test.ts`, test 2).
- À 10 000 lignes, l'écart normal monte jusqu'à +0,048 : une marge de mémorisation doit grandir avec la SE.

Contrôle proposé, à deux sens (`audit/exactitude/two-sided-gap.ts`) :
- **held-out trop beau** (fuite, split inversé, erreur de lignes) : `heldOutAuc − trainAuc > 3·SE` ;
- **mémorisation** : `trainAuc − heldOutAuc > 0,02 + 3·SE`.

Résultat : 0 fausse alerte sur les 36 tirages légitimes, 3 mémorisations sur 3 attrapées, held-out corrompu
attrapé. SE vaut 0,014 à 10 000 lignes et 0,008 à 30 000 : la marge s'adapte. Les effectifs nécessaires à la SE se
retrouvent à partir des métriques déjà livrées (`heldOutClassCounts`, vérifié exact sur credit-risk), donc le
navigateur peut afficher l'alerte sans changer le format du modèle.

Reproduire :
```
python -I audit/exactitude/q4_gap.py 6
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/two-sided-gap.test.ts
```
Résultats bruts : `audit/exactitude/resultats/q4-ecart-train-heldout.json`.

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

Les deux modèles sont ceux de Sirius (`trainGradientBoostedTrees`, `trainLogisticRegression`), entraînés sur les
mêmes lignes (index % 5 ≠ 4) et mesurés sur les mêmes lignes held-out. Gain : règle « accorder si P(défaut) < 1/6,
+0,2 par bon client accordé, −1 par défaut accordé », ramené à 1 000 dossiers. ECE : erreur de calibration sur
déciles. Pente : pente de calibration (1 = parfait ; > 1 = probabilités trop tassées vers la moyenne).

**Jeux réels (held-out)**

| Jeu | Modèle | AUC | Brier | ECE | Pente | Gain / 1 000 | Accorder à tous / oracle |
|---|---|---|---|---|---|---|---|
| credit-risk | arbres | **0,717** | **0,158** | **0,016** | 0,99 | **30,6** | −79,7 / 153,4 |
| credit-risk | logistique | 0,658 | 0,168 | 0,027 | 1,21 | 8,1 | |
| Taïwan | arbres | **0,787** | **0,134** | **0,019** | 1,08 | **44,3** | −69,8 / 155,0 |
| Taïwan | logistique | 0,727 | 0,146 | 0,060 | 1,21 | 15,6 | |
| GMSC 40 000 | arbres | **0,870** | **0,048** | **0,007** | 1,05 | **145,8** | 122,3 / 187,1 |
| GMSC 40 000 | logistique | 0,656 | 0,060 | 0,030 | 1,58 | 123,1 | |

Référence : une logistique convergée (scikit-learn) obtient 0,658 / 0,729 / 0,673 d'AUC et 11,5 / 17,2 / 131,1 de
gain : l'écart avec les arbres vient surtout de la forme de la relation (seuils, effets en U, valeurs extrêmes),
pas de la sous-convergence de la logistique Sirius, qui coûte en revanche en calibration (EXA-02).

**Cas difficiles**

| Cas | Lignes | Mesure | AUC arbres | AUC logistique | ECE arbres / logistique | Gain / 1 000 arbres / logistique | Lecture |
|---|---|---|---|---|---|---|---|
| Relation purement linéaire (synthétique) | 20 000 | held-out | 0,802 | **0,812** | 0,019 / 0,023 | 34,4 / **37,4** | logistique meilleure (−0,010 d'AUC pour les arbres) |
| 2 % de défauts (Taïwan rééchantillonné) | 23 841 | held-out | **0,758** | 0,721 | **0,003** / 0,044 | 176,4 / 176,8 | meilleur classement, mais même décision : à 2 %, presque tout le monde passe sous 1/6 (accorder à tous = 176) ; précision / rappel / F1 = 0 au seuil 0,5 (EXA-09) ; pente logistique 3,88 |
| Colonne de bruit à queue lourde (Taïwan + Cauchy × 10⁶) | 30 000 | held-out | **0,786** | 0,726 | 0,019 / 0,060 | **45,0** / 15,7 | aucun des deux n'est dérangé (arbres 0,787 → 0,786 ; logistique 0,727 → 0,726) |
| Temps, dérive favorable | 20 000 + 5 000 futurs | held-out affiché → futur | 0,707 → 0,755 | 0,685 → **0,795** | futur 0,025 / 0,082 | futur 26,3 / 20,7 | l'AUC affichée sous-estime le futur de 0,047 ; dans le futur la logistique classe mieux |
| Temps, rupture (le seuil de risque se déplace) | 20 000 + 5 000 futurs | held-out affiché → futur | 0,734 → 0,680 | 0,725 → 0,688 | futur 0,119 / 0,119 | futur 5,6 / 3,2 | l'AUC affichée surestime le futur de 0,054 et la calibration s'effondre (EXA-08) |
| Taïwan, 10 000 lignes pile | 10 000 (+ 20 000 de test) | test externe | **0,766** | 0,718 | 0,011 / 0,054 | **43,2** / 15,8 | les arbres gardent l'avantage au plancher ; held-out affiché 0,788 (2 000 lignes, SE 0,014) |
| credit-risk, 10 000 lignes pile | 10 000 (+ 3 000 de test) | test externe | **0,707** | 0,647 | 0,016 / 0,026 | **21,5** / 7,5 | idem |
| Taïwan, 9 999 lignes | 9 999 | — | refusé | — | — | — | message attendu : « Les arbres boostés demandent au moins 10 000 lignes ; utilise la régression logistique pour ce fichier. » |

Sous le plancher (plancher abaissé à 2 000 au chargement, `q7_below_floor.py`, test externe) : Taïwan 3 000 lignes
arbres 0,651 contre logistique 0,719, 5 000 lignes 0,696 contre 0,719, 8 000 lignes **0,761** contre 0,719 ;
credit-risk 3 000 : 0,623 contre 0,650, 5 000 : **0,685** contre 0,649. Le commentaire de `gbdt.ts:22-25` (« sous
10 000 lignes, les arbres font moins bien ») est vrai vers 3 000 à 5 000 lignes ; le plancher de 10 000 est
prudent, pas faux.

**Où les arbres sont meilleurs, inutiles ou pires**

| Situation | Verdict | Chiffres clés |
|---|---|---|
| Crédit réel avec seuils, effets en U, valeurs extrêmes (Taïwan, GMSC, credit-risk) | **Meilleurs** | +0,06 à +0,21 d'AUC, ECE 1,7 à 4 fois plus faible, gain ×1,2 à ×3,8 |
| Colonne très bruitée ou à valeurs extrêmes | **Meilleurs** (et robustes) | aucune perte d'AUC avec la colonne de bruit |
| 10 000 lignes pile | **Meilleurs** | +0,05 à +0,06 d'AUC sur test externe |
| Classes très déséquilibrées (2 %) | **Inutiles pour la décision** | AUC +0,04 et bien mieux calibrés, mais gain identique (176,4 contre 176,8) ; métriques au seuil 0,5 nulles |
| Relation purement linéaire | **Pires** (un peu) | −0,010 d'AUC, gain 34,4 contre 37,4 |
| Données triées dans le temps, futur différent du passé | **Pires ou trompeurs** | AUC affichée fausse de ±0,05 pour le futur ; dans les deux scénarios, la logistique fait aussi bien ou mieux sur le futur |
| Moins de ~5 000 lignes (hors profil aujourd'hui) | **Pires** | Taïwan 3 000 : 0,651 contre 0,719 |

Reproduire :
```
python -I audit/exactitude/compare_sklearn.py audit/exactitude/.data/<jeu>.csv audit/exactitude/.data/out/<jeu>.json audit/exactitude/resultats/q1-q7-<jeu>.json
python -I audit/exactitude/q7_logistic_ref.py
python -I audit/exactitude/q7_hard_cases.py
python -I audit/exactitude/q7_hard_cases.py temporel-rupture
python -I audit/exactitude/q7_below_floor.py
```
Résultats bruts : `audit/exactitude/resultats/q1-q7-*.json`, `q7-cas-difficiles.json`, `q7-logistique-convergee.json`,
`q7-sous-le-plancher.json`.

## Tests et scripts ajoutés

Tout est sous `audit/exactitude/` ; aucun fichier de production n'a été modifié. Les jeux téléchargés et les
sorties intermédiaires vont dans `audit/exactitude/.data/` (ignoré par git).

| Fichier | Rôle | Résultat |
|---|---|---|
| `prepare_data.py` | télécharge OpenML 42477 et 46929, écrit les 3 CSV au format Sirius | 30 000 / 40 000 / 13 000 lignes |
| `sirius-run.ts` | pilote : entraîne arbres + logistique avec le vrai code Sirius, écrit les prédictions | — |
| `sirius_lib.py`, `metrics_lib.py` | appel du pilote ; AUC, Brier, ECE, pente, gain d'octroi, SE de Hanley-McNeil | — |
| `compare_sklearn.py` | Q1 et Q7 jeux réels | écart ≤ 0,0005 |
| `tests/browser-vs-enclave.test.ts` | Q2 | 4 / 4 passent |
| `q3_duplicates.py`, `q3_paired.py` | Q3 | 20 entraînements |
| `q4_gap.py`, `two-sided-gap.ts`, `tests/two-sided-gap.test.ts` | Q4 | 4 / 4 passent ; 39 tirages |
| `tests/profile-version.test.ts`, `tests/mutate-gbdt.cjs`, `tests/mutate-train-gbdt.cjs` | Q5 et sa preuve par mutation | 3 / 3 passent ; échouent sous mutation |
| `tests/determinism.test.ts` | Q6 | 6 / 6 passent |
| `q7_hard_cases.py`, `q7_logistic_ref.py`, `q7_below_floor.py`, `tests/mutate-min-rows.cjs` | Q7 | 8 cas + 6 sous le plancher |

Lancer tous les tests ajoutés :
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/browser-vs-enclave.test.ts audit/exactitude/tests/profile-version.test.ts audit/exactitude/tests/determinism.test.ts audit/exactitude/tests/two-sided-gap.test.ts
```
Les tests existants `src/lib/tee/train-gbdt.test.ts` et `src/lib/train/evaluation-client.test.ts` passent
(18 / 18) sur la base auditée.

Note sur le poste : la machine était partagée avec d'autres calculs lourds. Les scripts limitent scikit-learn à
1 thread (`OMP_NUM_THREADS=1`) et ralentissent ×10 l'horloge du délai d'entraînement (`AUDIT_SLOW_CLOCK`) ; cela
ne change pas les modèles (empreinte identique, vérifiée dans `determinism.test.ts`).

## Points NON VÉRIFIÉS

- Comportement sur la CVM Phala (temps réel, version de Node de l'image, empreinte du modèle) : aucune session
  lancée, conformément aux règles. NON VÉRIFIÉ.
- Déterminisme entre versions de Node / V8 ou entre processeurs : seul Node 22.16.0 (Windows, x64) a été testé.
  NON VÉRIFIÉ.
- Égalité des prédictions dans Firefox et Safari (autres moteurs `Math.exp`) : seul V8 a été testé. L'écart
  attendu est de l'ordre de 10⁻¹⁶, mais NON VÉRIFIÉ.
- GMSC complet (150 000 lignes) : non entraînable par Sirius (plafond CSV 50 000 lignes) ; seules les 40 000
  premières lignes, dans l'ordre OpenML, ont été utilisées. Les conclusions sur GMSC portent sur ce sous-ensemble.
- Ordre des lignes d'OpenML 42477 : supposé identique au fichier d'origine ; sans effet sur les conclusions (les
  expériences Q3, Q4 et Q7 mélangent l'ordre avec des graines fixes).
- Cas « temporel » : données synthétiques (aucun jeu public daté parmi les 3 autorisés). L'ampleur de l'écart
  (±0,05) dépend du scénario choisi ; le sens du constat (le held-out entrelacé ne mesure pas le futur), non.
- Q3 : 4 graines seulement ; le gonflement externe de Sirius reste dans le bruit (écart type ≈ 0,01) ; la mesure
  appariée (≤ +0,003 au maximum) est la plus fiable.
- Le contrôle à deux sens proposé (Q4) est calibré sur 39 tirages ; son taux de fausses alertes réel sur d'autres
  jeux n'est pas mesuré.
