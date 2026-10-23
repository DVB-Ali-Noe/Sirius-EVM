---
type: rapport-modele
projet: Sirius
modele: M02
sujet: Classifieur GO/NO_GO calibré pour un agent de marché prédictif
tags: [sirius, calibration, logistique, gbdt, decision, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m02_calibrated_go_no_go.py
resultats: experiments/model-zoo/results/m02_calibrated_go_no_go.json
note: 5/10
livraison: modèle livré
decision: retenu
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M01 Arbres boostés]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

> **Décision du 14 octobre 2026** : Retenu, comme étape de recalibrage côté borrower proposée en option sur chaque prêt, pas comme modèle à part.

## Ce que c'est

Un classifieur qui donne une **vraie probabilité de succès**, puis une décision : agir (GO) si cette probabilité dépasse le seuil de rentabilité, sinon s'abstenir (NO_GO). « Calibré » signifie que quand le modèle annonce 80 %, l'action réussit vraiment 8 fois sur 10.

## Le scénario testé

- **Un agent de marché prédictif** (type veto Polymarket) évalue des opportunités : prix, écart, profondeur du carnet, momentum, temps avant résolution, pic de volume, flux des baleines.
- **Pièges intégrés** : carnet mince avec pic de volume, momentum tardif près de la résolution, prix extrêmes.
- **Gain asymétrique** : +0,4 si l'action réussit, −1 si elle échoue. Il ne faut agir qu'au-dessus de 71 % de succès, donc une probabilité fausse coûte directement de l'argent.
- **Le provider** loue 8 000 opportunités passées.
- **Bloc de transfert** : on applique ensuite le modèle au marché du borrower, où les pièges sont plus fréquents (47 % de succès au lieu de 65 %), avant et après recalibrage sur 500 opportunités du borrower.

## Qualité chez le provider (même distribution)

| Modèle | AUC | ECE | Gain par opportunité | Taux de GO | Précision des GO |
|---|---|---|---|---|---|
| Toujours GO | | | −0,086 | 100 % | 65 % |
| Logistique (Sirius actuel) | 0,697 | 0,010 | +0,048 | 38 % | 80,5 % |
| Logistique + isotonique | 0,697 | 0,012 | +0,049 | 40 % | 80,2 % |
| **Arbres bridés** | **0,728** | 0,010 | **+0,062** | 45 % | 81,3 % |
| Arbres bridés + isotonique | 0,729 | 0,011 | +0,062 | 43 % | 81,8 % |

**Le calibrage n'apporte rien quand on reste dans la même distribution** : la logistique et les arbres entraînés sur la perte logistique sont déjà calibrés (ECE de 1 %). C'est le type de modèle qui fait la différence (+29 % de gain pour les arbres), pas le calibrage.

## Qualité chez le borrower (marché différent) : là où le calibrage compte

| Modèle | Modèle du provider tel quel | Recalibré (sigmoïde, 500 records du borrower) | Recalibré (isotonique) | Borrower seul (500 records) |
|---|---|---|---|---|
| Logistique | **−0,037** | +0,004 | −0,001 | +0,002 |
| Arbres bridés | **−0,040** | **+0,007** | +0,004 | 0,000 |

- **Le modèle du provider, appliqué tel quel, perd de l'argent** : il croit encore à 65 % de succès, prend trop de GO et sa précision tombe à 65 %.
- **Un recalibrage sur 500 records du borrower le rend rentable**, et fait mieux que ce que le borrower obtient seul avec ses 500 records.
- **Mais le gain absolu est mince** (+0,007 par opportunité) : sur ce marché difficile, l'agent agit très rarement (10 % des cas).
- **La sigmoïde (Platt) est plus stable que l'isotonique** avec si peu de données.

## Extraction

| Modèle | Appartenance, AUC calibrée | Détectés à 1 % de faux positifs | Canaris ×5 extraits (témoins) |
|---|---|---|---|
| Logistique | 0,505 | 1,0 % | 18 % (11 %) |
| Logistique + isotonique | 0,511 | 1,2 % | 20 % (14 %) |
| Arbres bridés | 0,558 | 1,6 % | 54 % (13 %) |
| Arbres bridés + isotonique | 0,558 | 1,7 % | 51 % (13 %) |

**Le calibrage n'ajoute pas de fuite mesurable.** La fuite vient du modèle de base (logistique sûre, arbres sensibles aux doublons), pas de l'étape de calibrage.

## Ce que Sirius devrait faire

- **Livrer chaque modèle avec une recalibration côté borrower** : une étape gratuite, sur ses propres données, qui ne touche pas aux données du provider. C'est la vraie valeur de ce travail.
- **Utiliser la sigmoïde par défaut**, l'isotonique seulement au-delà de quelques milliers de records.
- **Afficher le seuil de rentabilité et la précision attendue des GO**, plutôt qu'une simple probabilité.

## Avis honnête : 6/10

**Ce n'est pas un produit, c'est une fonctionnalité indispensable.** L'idée de départ (« calibrer la logistique ») ne vaut rien seule : les modèles sont déjà calibrés. L'expérience révèle autre chose de plus important : **un modèle prêté appliqué à un autre marché peut faire perdre de l'argent**, et seule une recalibration chez le borrower le corrige.

Ça devrait faire partie de chaque prêt Sirius, pour un coût quasi nul et sans risque de fuite supplémentaire.

## Mise à jour : sur données réelles (note 6 → 5)

Sur le vrai crédit taïwanais, avec un modèle prêté par une banque de jeunes clients à une banque de clients de plus de 45 ans (voir [[Données réelles]]) :

- **Le recalibrage n'apporte rien** : 0,0363 de gain par client contre 0,0367 sans recalibrage. Le décalage réel est modéré et les arbres sont déjà calibrés.
- **La logistique, elle, est mal calibrée sur les vraies variables** (ECE de 4,9 %) : le recalibrage reste utile pour le modèle actuel de Sirius.
- **La valeur vient du modèle prêté lui-même** : 7,5 fois le gain du borrower seul.

**Nouvelle note : 5/10.** À garder comme sécurité pour les marchés très différents, mais le synthétique exagérait son importance.
