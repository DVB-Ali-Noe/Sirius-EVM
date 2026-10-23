---
type: rapport-modele
projet: Sirius
modele: M08
sujet: Signaux de trading tirés d'un panel de dépenses par carte, pour actions tokenisées
tags: [sirius, alt-data, trading, signaux, reconstruction, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m08_alt_data_signals.py
resultats: experiments/model-zoo/results/m08_alt_data_signals.json
note: 4/10
livraison: service depuis l'enclave
decision: écarté
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

> **Décision du 14 octobre 2026** : Écarté : sans le flux de données du vendeur, un modèle livré ne vaut rien, donc il faudrait un service de signaux depuis l'enclave. Hors périmètre, et marché déjà existant.

## Ce que c'est

Un vendeur de données alternatives possède un panel de dépenses par carte bancaire qui mesure en temps réel la croissance des ventes de chaque entreprise. Le marché, lui, ne l'apprend qu'aux publications trimestrielles. Un agent qui trade des actions tokenisées voudrait un signal tiré de ce panel.

## Le scénario testé

- **Marché** : 60 entreprises sur 312 semaines.
- **Ce que le marché sait déjà** : la croissance des ventes suit un facteur commun et une dynamique propre. Le marché intègre le dernier trimestre publié.
- **Ce que le panel apporte** : la surprise, c'est-à-dire l'écart entre la croissance réelle et celle déjà publiée, fait bouger le cours la semaine suivante. Le panel la mesure avec un petit bruit d'échantillonnage.
- **La vraie question n'est pas seulement la qualité, c'est la livraison.** Un modèle qui a besoin du panel en entrée est inutile à un borrower qui n'a pas le panel. Trois livraisons sont donc comparées :

| Livraison | Ce que reçoit le borrower |
|---|---|
| Modèle seul | Le modèle entraîné, sans le panel ensuite (il remplace les variables du panel par leur moyenne) |
| Modèle sur variables publiques | Un modèle entraîné sans le panel |
| **Signaux depuis l'enclave** | Chaque semaine, le score de chaque entreprise, calculé dans l'enclave avec le panel |

- **L'attaque testée** est la reconstruction du produit : le borrower essaie de rebâtir le panel, c'est-à-dire le produit du vendeur, en inversant les signaux reçus. Pour l'apprendre, il utilise les croissances que les publications rendent publiques plus tard. Hypothèse favorable à l'attaquant : il dispose des croissances hebdomadaires, pas seulement trimestrielles.

## Qualité (104 semaines de test)

| Livraison | IC | Sharpe long-short (quintiles) |
|---|---|---|
| Modèle sur variables publiques | 0,025 | 0,57 |
| Modèle livré, sans panel ensuite | 0,044 | 0,95 (très variable : ±0,47) |
| **Signaux depuis l'enclave** | **0,082** | **1,64** |
| Signaux grossiers (+1 / 0 / −1 sur les quintiles extrêmes) | 0,029 | **1,64** |
| Signaux grossiers, publiés avec une semaine de retard | 0,033 | 1,78 (très variable : ±0,77) |
| Le panel lui-même, comme signal | 0,080 | 2,79 |

- **Un modèle livré sans le panel ne vaut presque rien** : c'est le cœur du problème. Le modèle « classique » de Sirius (on livre le modèle, le borrower l'utilise chez lui) ne marche pas pour ce cas.
- **Seuls les signaux calculés dans l'enclave gardent la valeur.**
- **Les signaux grossiers ne coûtent rien à une stratégie par quintiles** : le Sharpe long-short est identique. L'IC baisse mécaniquement, mais la stratégie ne s'en sert pas.
- Le modèle capte environ 60 % du Sharpe du panel brut (1,64 contre 2,79) : les arbres bridés n'exploitent pas toute la relation.

## Extraction : le vendeur peut-il perdre son produit ?

| Livraison | Corrélation entre panel reconstruit et vrai panel |
|---|---|
| Variables publiques seules (référence) | 0,19 |
| **Signaux continus** | **0,71** |
| Signaux grossiers | 0,37 |
| Signaux grossiers avec une semaine de retard | 0,31 |

- **Avec des signaux continus, le borrower reconstruit une copie correcte du produit du vendeur** (corrélation de 0,71). Il pourrait la revendre, ou annuler son abonnement à Sirius. C'est exactement la crainte des vendeurs de données.
- **Grossir les signaux divise la fuite par deux et demi** (0,71 → 0,37, contre 0,19 sans rien louer) **sans perte pour une stratégie par quintiles**. C'est le résultat le plus actionnable de ce test.
- **Le retard d'une semaine ajoute peu** de protection.
- La confidentialité des panélistes individuels (les porteurs de carte) n'est pas testée : avec des agrégats sur des dizaines de milliers de personnes, le risque est faible, mais il devient réel pour une enseigne de niche avec peu de panélistes.

## Avis honnête : 4/10

Je le classais premier il y a deux jours. Les tests et ta remarque le font descendre :

1. **Ce n'est pas un nouveau marché** : ces vendeurs vendent déjà, Sirius ne serait qu'un canal de plus.
2. **Le modèle de prêt de Sirius ne s'applique pas** : livrer le modèle ne sert à rien sans flux de données. Il faut un **service de signaux permanent dans l'enclave**, donc une machine allumée en continu (coût Phala permanent) et une autre architecture que le prêt ponctuel.
3. **Même en service, le produit fuit** si les signaux sont continus. Les signaux grossiers règlent en partie le problème.

Ça reste techniquement faisable, et les signaux grossiers sont une bonne idée à garder pour n'importe quel service de signaux. Mais ce n'est pas la thèse de Sirius.
