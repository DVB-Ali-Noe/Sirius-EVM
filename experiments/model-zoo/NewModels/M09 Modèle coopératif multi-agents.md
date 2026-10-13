---
type: rapport-modele
projet: Sirius
modele: M09
sujet: Modèle commun entraîné sur les historiques privés de plusieurs agents
tags: [sirius, virtuals, cooperatif, shapley, inference-attribut, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m09_cooperative.py
resultats: experiments/model-zoo/results/m09_cooperative.json
note: 7/10
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M11 Location d'expérience]]", "[[Location d'expérience entre agents]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]] · Expérience de base : [[Location d'expérience entre agents]]

## Ce que c'est

Plusieurs agents versent leur historique privé (le contexte vu, la décision, le résultat) dans l'enclave. Un modèle commun est entraîné sur l'ensemble, et chaque contributeur est payé selon son apport, mesuré par la **valeur de Shapley** (l'apport moyen d'un provider sur toutes les combinaisons possibles de providers). C'est la version « pool » de [[M11 Location d'expérience]], qui reprend le même marché synthétique.

## Le scénario testé

- **Même marché et mêmes agents** que [[Location d'expérience entre agents]] : 4 providers honnêtes (Atlas, Kite, Orion, Pine) et un borrower.
- **Trois attaques nouvelles** :
  1. **Inférence d'attribut** : le borrower essaie de retrouver le sentiment privé qu'Atlas avait enregistré à chaque instant, à partir du modèle livré et des variables publiques (prix, résultat, tous visibles on-chain).
  2. **Le copieur** : un nouvel agent soumet les records d'Atlas, à peine bruités, sous son propre nom, pour toucher une part du paiement.
  3. **Le profiteur** : un agent publie honnêtement ses engagements chaque jour, mais n'y enregistre que du bruit sans valeur.

## Qualité

Le pool atteint un IC de 0,083 (Sharpe 4,9 sur ce marché synthétique au signal volontairement fort), contre 0,040 pour le borrower seul. Les détails sont dans [[Location d'expérience entre agents]].

## Extraction : inférence d'attribut

| Ce que l'attaquant reconstruit | Corrélation avec le vrai sentiment d'Atlas |
|---|---|
| Records d'Atlas utilisés pour l'entraînement | 0,058 |
| Records d'Atlas jamais vus | 0,055 |
| Avec un modèle entraîné sans Atlas (référence) | 0,060 |
| Signe du sentiment retrouvé | 51,7 % (le hasard donne 50 %) |

**Aucune fuite.** Le résultat d'un trade est surtout du bruit, donc remonter du résultat au sentiment est impossible, que le record ait été vu ou non. C'est une propriété rassurante des données de trading : la cible bruitée protège le contexte.

## Attaques économiques : qui est payé ?

| Provider | Shapley, pool honnête | Avec le copieur | Avec le profiteur |
|---|---|---|---|
| Atlas | 0,015 | **0,011** | 0,020 |
| Kite | 0,008 | 0,006 | 0,009 |
| Orion | 0,012 | 0,010 | 0,016 |
| Pine | 0,017 | 0,014 | 0,020 |
| **Copieur** | | **0,012** | |
| **Profiteur** | | | **−0,019** |

- **Le copieur gagne autant qu'Atlas, qu'il a copié**, et Atlas perd un quart de sa part. La valeur de Shapley partage la valeur entre deux sources identiques : elle **récompense la duplication**. C'est une faille de paiement réelle et connue de cette méthode.
- **Le profiteur est démasqué** : sa valeur est négative, donc il n'est pas payé, et sa présence ne gêne pas les autres.

## Ce que Sirius devrait imposer

- **Détecter les quasi-doublons entre providers avant de payer** : comparer les records dans l'enclave (mêmes instants, mêmes actifs, contextes presque identiques), et ne payer que le premier engagement daté.
- **Les engagements on-chain datés servent aussi à ça** : le copieur ne peut engager les records d'Atlas qu'après les avoir obtenus, donc après Atlas.
- **Une fenêtre de valorisation longue** : la valeur de Shapley varie d'une graine à l'autre (écart-type de 0,004 à 0,007 pour des valeurs autour de 0,01).

## Avis honnête : 7/10

C'est la forme la plus naturelle du marché « expérience des agents », et elle tient bien les tests de confidentialité : aucune fuite d'attribut, et les fuites de records individuels sont maîtrisées par le profil bridé ([[M01 Arbres boostés]]).

**Ce qui la retient à 7** : la répartition des paiements est attaquable par simple copie tant que la détection des doublons n'existe pas. Il faut aussi entraîner sur plusieurs datasets à la fois, et calculer les valeurs de Shapley (des dizaines d'entraînements par pool). Rien de tout ça n'existe dans le runner.
