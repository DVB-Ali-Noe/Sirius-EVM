---
type: rapport-modele
projet: Sirius
modele: M03
sujet: Prévision P10 / P50 / P90 du rendement d'un perpétuel
tags: [sirius, quantile, risque, gbdt, lineaire, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m03_quantile.py
resultats: experiments/model-zoo/results/m03_quantile.json
note: 4/10
livraison: modèle livré
decision: retenu
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M01 Arbres boostés]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

> **Décision du 14 octobre 2026** : Retenu comme option de catalogue, en version linéaire uniquement.

## Ce que c'est

Au lieu d'une seule prédiction, le modèle renvoie une fourchette : un scénario bas (P10), médian (P50) et haut (P90). Si la fourchette est bonne, le vrai résultat tombe entre P10 et P90 dans **80 % des cas**, quelles que soient les conditions. Un agent s'en sert pour dimensionner ses positions et poser ses stops.

## Le scénario testé

- **Le provider** est un desk qui loue 8 000 heures d'historique sur un perpétuel : volatilité réalisée, funding, variation de l'open interest, momentum, heure, liquidations.
- **Le bruit est à queues épaisses** (loi de Student), et son ampleur dépend de la volatilité et des vagues de liquidation. C'est exactement là qu'une fourchette fixe échoue.
- **Cinq méthodes** :
  - quantiles fixes, la même fourchette pour tout ;
  - bande gaussienne autour d'une régression linéaire ;
  - **régression quantile linéaire** ;
  - arbres quantiles, bridés et libres.
- **Canaris** : 20 heures uniques suivies d'un krach de 8 écarts-types.

## Qualité (20 000 heures de test)

| Méthode | Perte (pinball, plus bas = mieux) | Couverture P10-P90 (cible 80 %) | En forte volatilité | Au calme | Largeur moyenne |
|---|---|---|---|---|---|
| Fourchette fixe | 0,482 | 80,3 % | **50,9 %** | 91,4 % | 1,35 |
| Gaussienne + linéaire | 0,503 | 91,2 % | 69,0 % | 97,6 % | 2,17 |
| **Quantile linéaire** | **0,445** | **79,9 %** | **79,3 %** | **79,7 %** | 1,36 |
| **Arbres quantiles bridés** | **0,443** | 78,4 % | 78,3 % | 78,2 % | 1,32 |
| Arbres quantiles libres | 0,480 | 64,6 % | 59,3 % | 63,4 % | 0,98 |

- **La fourchette fixe est un piège** : elle affiche 80 % en moyenne, mais seulement 51 % quand la volatilité est forte, c'est-à-dire quand on en a le plus besoin.
- **La bande gaussienne compense en étant deux fois trop large**, et rate quand même en forte volatilité.
- **La régression quantile linéaire fait presque aussi bien que les arbres** (0,445 contre 0,443), parce que dans ce scénario l'ampleur du risque croît à peu près linéairement avec la volatilité. Elle ne croise jamais ses quantiles (0,1 % des cas).
- **Les arbres libres sont dangereux** : des fourchettes trop étroites (65 % de couverture) et des quantiles qui se croisent dans 6 % des cas.

## Extraction

| Méthode | Appartenance, AUC calibrée | Détectés à 1 % de faux positifs | Krachs ×5 : AUC canaris | Krachs ×5 couverts (témoins) |
|---|---|---|---|---|
| Quantile linéaire | 0,509 | 1,1 % | 0,51 | 0 % (0 %) |
| Arbres bridés | 0,578 | 2,2 % | 0,76 | 3 % (0 %) |
| Arbres libres | 0,796 | 8,5 % | 1,00 | **75 % (0 %)** |

- **La version linéaire ne retient aucun krach individuel.**
- **Les arbres bridés laissent un signal** (l'attaquant distingue les heures de krach injectées avec une AUC de 0,76), mais n'élargissent la fourchette que pour 3 % d'entre elles.
- **Les arbres libres apprennent les krachs par cœur** : 75 % des heures de krach dupliquées sont « prévues » par la fourchette. Un attaquant peut ainsi retrouver les moments précis où le desk a subi un choc extrême, une information sensible pour un desk.

## Ce que Sirius devrait faire

- **Proposer d'abord la régression quantile linéaire** : c'est une extension directe de la régression linéaire du runner actuel, presque aussi bonne que les arbres ici, et sans fuite mesurable.
- **Réserver les arbres quantiles aux cas où le risque est vraiment non linéaire**, bridés, et en forçant l'ordre P10 ≤ P50 ≤ P90.
- **Livrer la couverture mesurée par régime de volatilité**, pas seulement la couverture moyenne, qui ment.

## Avis honnête : 5/10

**Techniquement, c'est la meilleure surprise de la série** : la version linéaire est presque gratuite à ajouter au runner, sûre, et elle corrige un vrai défaut des fourchettes naïves.

**Commercialement, c'est faible pour Sirius.** La cible naturelle (rendements de marché) repose surtout sur des données publiques : un agent peut entraîner ce modèle seul, sans louer quoi que ce soit. Il ne devient intéressant que si l'historique du provider contient des variables privées (flux propres, liquidations vues de l'intérieur), ce que mon scénario suppose sans l'avoir vérifié.

À ajouter au catalogue comme option bon marché, pas à vendre comme un produit.

## Mise à jour : sur données réelles (note 5 → 4)

Sur les rendements réels de 8 perpétuels Binance en 2025 (voir [[Données réelles]]) :

- **Les modèles quantiles ne gagnent que 1,6 % sur une fourchette fixe** (contre 8 % en synthétique), et les variables de carnet d'ordres n'apportent rien.
- **Les fourchettes restent justes** (80 % de couverture, 78 à 80 % en forte volatilité à 4 h). C'est le seul vrai service rendu.

**Nouvelle note : 4/10.** Option de catalogue, sans plus.
