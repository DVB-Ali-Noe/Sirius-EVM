---
type: rapport-modele
projet: Sirius
modele: M01
sujet: Arbres boostés (gradient boosting) sur un portefeuille de crédit prêté
tags: [sirius, gbdt, credit, confidentialite, canaris]
date: 2026-10-13
script: experiments/model-zoo/m01_gbdt_credit.py
resultats: experiments/model-zoo/results/m01_gbdt_credit.json
note: 8/10
livraison: modèle livré
decision: retenu
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

> **Décision du 14 octobre 2026** : Retenu. Modèle livré au borrower, à construire en premier, avec le profil strict et la déduplication.

## Ce que c'est

Une suite de petits arbres de décision, chacun corrigeant les erreurs des précédents. C'est le modèle de référence sur les données en tableau, et le seul type de modèle non linéaire qui reste léger, rapide sur CPU et lisible. **C'est un moteur, pas un produit** : la plupart des autres idées (M02, M03, M05, M06, M10, location d'expérience) tournent dessus.

## Le scénario testé

- **Provider** : un petit prêteur qui loue son historique de remboursements (10 000 prêts, 17 % de défauts).
- **Borrower** : un autre prêteur qui veut un score de défaut.
- **Variables** : revenu, taux d'endettement, âge, ancienneté, retards, utilisation du crédit, montant, région. Le risque est construit avec des seuils et des interactions (jeune et très endetté, ratio prêt/revenu), comme dans la réalité.
- **Comparaison** : la régression logistique que Sirius propose aujourd'hui, des arbres bridés (profondeur 3, au moins 200 prêts par feuille) et des arbres libres.

## Qualité (20 000 prêts de test)

| Modèle | AUC | Brier | ECE | Automatisable à 5 % d'erreur |
|---|---|---|---|---|
| Logistique (Sirius actuel) | 0,711 | 0,131 | 0,009 | 6,6 % |
| **Arbres bridés** | **0,723** | **0,128** | 0,008 | **15,1 %** |
| Arbres libres | 0,667 | 0,149 | 0,107 | 0,3 % |

- **Le gain sur la logistique existe mais il est modeste** : +0,012 d'AUC. Sur un score de crédit, la logistique est déjà bonne, parce que la plupart des effets sont à peu près monotones.
- **Le vrai gain est sur les cas automatisables** : les arbres bridés décident 2,3 fois plus de dossiers sans dépasser 5 % d'erreur.
- **Les arbres libres sont pires sur tout** : ils apprennent le bruit par cœur (AUC de 1,0 sur l'entraînement) et sont mal calibrés.

## Extraction

| Modèle | Appartenance, AUC calibrée | Détectés à 1 % de faux positifs | Canaris ×1 extraits (témoins) | Canaris ×5 extraits (témoins) |
|---|---|---|---|---|
| Logistique | 0,505 | 1,1 % | 10 % (11 %) | 12 % (10 %) |
| Arbres bridés | 0,544 | 2,0 % | 20 % (13 %) | **70 % (27 %)** |
| Arbres libres | 0,697 | 8,5 % | **100 % (24 %)** | 100 % (29 %) |

Ce qu'on lit dans le fichier livré :

| Modèle | Plus petite feuille | Feuilles de moins de 5 prêts | Seuils dans les queues extrêmes |
|---|---|---|---|
| Arbres bridés | 200 prêts | 0 % | 0 |
| Arbres libres | 1 prêt | 27 % | 5 en moyenne (de 0 à 21 selon la graine) |

**Lecture :**

1. **La logistique ne fuit rien de mesurable**, même avec des records dupliqués : elle n'a pas la capacité de retenir un individu.
2. **Les arbres libres sont une fuite ouverte.** Chaque prêt unique injecté une seule fois est retrouvé, et un quart des feuilles du fichier décrivent moins de 5 personnes. Les seuils extrêmes révèlent par exemple qu'un client du provider a un revenu ou un nombre de retards hors norme.
3. **Brider les arbres supprime presque toute la fuite sur les records uniques** (20 % extraits contre 13 % par hasard) et l'attaque d'appartenance devient faible (2 % à 1 % de faux positifs).
4. **Mais les doublons restent le point faible** : un prêt présent 5 fois est retrouvé dans 70 % des cas, malgré les feuilles de 200. Cinq copies d'un profil inhabituel suffisent à déplacer les feuilles où il tombe.
5. **Le fichier scikit-learn contient le nombre de records de chaque feuille.** Inutile pour prédire, mais révélateur : il faut le supprimer avant livraison.

## Ce que Sirius devrait imposer

- **Un profil bridé non négociable** : profondeur 3 et au moins 200 records par feuille. Il est **meilleur et plus sûr** que les arbres libres : aucun arbitrage à faire.
- **Une déduplication avant l'entraînement**, dans l'enclave : c'est elle qui ramène la fuite ×5 au niveau ×1.
- **Une vérification du modèle après entraînement** (taille réelle des feuilles, seuils extrêmes), puis la suppression des comptes et des gains par nœud dans le fichier livré.
- **Un export dans un format minimal** (seuils, valeurs de feuilles), pas le fichier scikit-learn brut.

## Avis honnête : 7/10

C'est **la brique à construire en premier**, parce que presque toutes les autres idées en dépendent et qu'elle tient dans le runner CPU. Mais il faut être lucide sur deux points :

- **Le gain sur un cas tabulaire simple est petit** : la logistique fait l'essentiel du travail sur un score de crédit. L'argument « personne ne paie pour une régression » reste une hypothèse.
- **Les arbres ne sont sûrs que bridés et dédupliqués.** Livrés tels quels par un data scientist, ce serait l'un des pires modèles de la série pour la confidentialité.

## Mise à jour : sur données réelles (note 7 → 8)

Retesté sur 30 000 vrais clients d'une banque taïwanaise (voir [[Données réelles]]) :

- **Le gain est 4 fois plus fort qu'en synthétique** : AUC 0,771 contre 0,716 pour la logistique, et **2,4 fois plus de gain par client**. L'argument « la logistique fait l'essentiel du travail » ne tient pas sur de vraies données.
- **Prêté à une autre banque, le modèle rapporte 7,5 fois plus** que ce que celle-ci obtient avec 500 clients à elle.
- **La fuite sur les records atypiques est plus forte** : 67 % des canaris extraits contre 40 % par hasard, dès la première copie. Sur données réelles, il faut le **profil strict** (feuilles d'au moins 1 000) : la fuite redevient négligeable (+2 points) pour 2 % de gain en moins.

**Nouvelle note : 8/10.** C'est la brique la mieux validée de toute la série.
