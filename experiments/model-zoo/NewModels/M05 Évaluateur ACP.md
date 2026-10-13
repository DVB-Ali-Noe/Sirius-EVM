---
type: rapport-modele
projet: Sirius
modele: M05
sujet: Prédire l'acceptation d'un job ACP avant la décision de l'évaluateur
tags: [sirius, virtuals, acp, evaluateur, gbdt, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m05_acp_evaluator.py
resultats: experiments/model-zoo/results/m05_acp_evaluator.json
note: 3/10
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

## Ce que c'est

Un classifieur qui prédit si un job livré sur ACP sera accepté ou rejeté. Il servirait aux futurs agents évaluateurs (5 % de chaque transaction) et aux systèmes de réputation.

## Le scénario testé, et pourquoi il est construit ainsi

**Les jobs ACP, leurs mémos et leurs résultats sont on-chain.** Le point de comparaison honnête n'est donc pas « rien », mais **un modèle entraîné sur un scraping public** de 50 000 jobs, que n'importe qui peut faire.

Pour donner une chance à Sirius, j'ai supposé qu'un orchestrateur détient en plus deux signaux **hors chaîne** : la satisfaction du client (remontée par son support) et l'historique de litiges. Le provider loue 10 000 jobs avec ces deux signaux.

**Attention, biais de construction** : c'est moi qui ai décidé que ces signaux privés pèsent lourd dans l'acceptation. Le gain mesuré ci-dessous en découle directement, et rien ne dit que ces signaux existent ou pèsent autant en réalité.

## Qualité (20 000 jobs de test)

| Modèle | AUC | Brier | Automatisable à 5 % |
|---|---|---|---|
| Heuristique (note > 4 et délai respecté) | 0,615 | 0,267 | 0 % |
| Scraping public, 50 000 jobs | 0,662 | 0,199 | 0,2 % |
| Données louées, variables publiques seules (10 000) | 0,652 | 0,201 | 0,2 % |
| **Données louées avec signaux privés, logistique** | **0,773** | **0,170** | **10,5 %** |
| Données louées avec signaux privés, arbres bridés | 0,772 | 0,171 | 9,9 % |
| Données louées avec signaux privés, arbres libres | 0,740 | 0,198 | 4,0 % |

- **Sans signal privé, louer ne sert à rien** : 10 000 jobs loués font moins bien que 50 000 jobs scrapés gratuitement.
- **Avec signaux privés, le gain est fort** (+0,11 d'AUC), mais c'est l'hypothèse du scénario qui le crée.
- **La logistique suffit** : les arbres n'apportent rien ici.

## Extraction

| Modèle | Appartenance, AUC calibrée | Détectés à 1 % de faux positifs | Canaris ×1 (témoins) | Canaris ×5 (témoins) |
|---|---|---|---|---|
| Logistique | 0,504 | 1,0 % | 7 % (12 %) | 6 % (15 %) |
| Arbres bridés | 0,553 | 1,8 % | 24 % (15 %) | 59 % (18 %) |
| Arbres libres | 0,737 | 6,9 % | 100 % (25 %) | 100 % (27 %) |

Même schéma que [[M01 Arbres boostés]] : la logistique ne retient rien, les arbres bridés retiennent les doublons, les arbres libres retiennent tout. Ici, ce qui fuirait, c'est la satisfaction et les litiges de clients identifiables par leur job on-chain.

## Avis honnête : 3/10

- **La donnée est publique** : le cœur du problème se résout sans Sirius, avec un scraping.
- **La seule version utile repose sur des signaux privés supposés.** Je ne sais pas qui les détient, ni s'ils seraient loués : un orchestrateur n'a aucun intérêt à aider ses concurrents à mieux choisir.
- **Le rôle d'évaluateur n'est pas actif** sur ACP.
- **Le risque de fuite touche des clients identifiables**, puisque chaque job est on-chain.

À abandonner, sauf si un acteur précis se présente avec des données de satisfaction qu'il veut monétiser.
