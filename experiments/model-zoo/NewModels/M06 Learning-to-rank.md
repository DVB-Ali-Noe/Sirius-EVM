---
type: rapport-modele
projet: Sirius
modele: M06
sujet: Classer les agents candidats pour un orchestrateur (LambdaMART)
tags: [sirius, virtuals, ranking, lambdamart, lightgbm, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m06_learning_to_rank.py
resultats: experiments/model-zoo/results/m06_learning_to_rank.json
note: 4/10
livraison: modèle livré
decision: échec
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M05 Évaluateur ACP]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

> **Décision du 14 octobre 2026** : Échec. Le gain vient du générateur, aucun provider n'a intérêt à louer, et c'est la plus forte fuite des modèles bridés. Abandonné.

## Ce que c'est

Pour chaque tâche entrante, le modèle classe 10 agents candidats du plus au moins adapté. LambdaMART est un ensemble d'arbres boostés entraîné directement pour bien ordonner (optimiser le haut du classement), pas pour prédire une note.

## Le scénario testé

- **Variables publiques**, visibles sur ACP : note, prix, latence, adéquation de catégorie, volume de jobs.
- **Variables privées** de l'orchestrateur : satisfaction par segment de client, et taux d'échecs silencieux (jobs livrés mais inutilisables, non signalés on-chain).
- **L'utilité réelle** d'un agent dépend des deux, avec une interaction : l'urgence de la tâche triple le poids de la latence.
- **Le provider** loue 3 000 tâches classées (30 000 lignes).
- **Points de comparaison** : un tri par note publique, et un classeur entraîné sur 15 000 tâches publiques.

**Même biais de construction que [[M05 Évaluateur ACP]]** : j'ai donné beaucoup de poids aux variables privées, donc le gain mesuré en découle.

## Qualité (5 000 tâches de test)

| Modèle | NDCG@1 | NDCG@3 | Meilleur agent choisi | Regret (utilité perdue) |
|---|---|---|---|---|
| Tri par note publique | 0,411 | 0,469 | 16,9 % | 1,50 |
| Classeur sur données publiques (15 000 tâches) | 0,557 | 0,602 | 27,8 % | 1,01 |
| **LambdaMART privé, bridé** | **0,856** | **0,870** | **64,4 %** | **0,19** |
| LambdaMART privé, libre | 0,843 | 0,860 | 62,2 % | 0,22 |

- **Trier par note est presque inutile** : le meilleur agent n'est choisi que 17 % du temps.
- **Les variables privées font passer de 28 % à 64 % de bons choix**, et divisent par 5 l'utilité perdue. C'est le plus gros écart de la série, mais je l'ai construit.

## Extraction

| Modèle | Appartenance par tâche, AUC calibrée | Détectés à 1 % de faux positifs | Tâches-canaris ×1 (témoins) | ×5 (témoins) |
|---|---|---|---|---|
| Bridé | **0,578** | 2,2 % | 15 % (6 %) | 22 % (5 %) |
| Libre | 0,802 | 11,4 % | 100 % (6 %) | 100 % (4 %) |

- **C'est, à égalité avec les arbres quantiles de [[M03 Régression quantile]], le modèle bridé qui fuit le plus sur l'attaque d'appartenance standard** (AUC 0,578, contre 0,54 à 0,56 pour les autres arbres bridés). L'attaque se fait par tâche entière (10 lignes liées), ce qui accumule le signal.
- **Défaut trouvé à l'audit : LightGBM ne respecte pas le plancher demandé.** On impose au moins 200 records par feuille, et le fichier livré contient des feuilles de 44 à 78 records selon la graine (65 en moyenne). Le réglage n'est donc pas une garantie : **Sirius doit vérifier le modèle produit**, pas les paramètres.
- Le fichier LightGBM exporte aussi le nombre de records par feuille et par nœud.

## Avis honnête : 4/10

Techniquement, c'est la plus belle démonstration de la valeur d'une donnée privée. Mais :

- **Le gain dépend entièrement d'une hypothèse que j'ai posée.**
- **L'incitation du provider manque** : les seuls détenteurs de ces données sont les orchestrateurs (Butler, Luna), et leur avantage concurrentiel est justement de mieux router que les autres. Je ne vois pas pourquoi ils loueraient.
- **La fuite par tâche est la plus forte des modèles bridés**, et la bibliothèque viole silencieusement le plancher de confidentialité.

Je ne le développerais que si un orchestrateur le demande pour son propre usage, par exemple pour entraîner sur les données de plusieurs de ses propres instances.
