---
type: rapport-modele
projet: Sirius
modele: M04
sujet: Détection d'anomalies non supervisée sur l'activité de wallets
tags: [sirius, isolation-forest, anomalies, fraude, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m04_isolation_forest.py
resultats: experiments/model-zoo/results/m04_isolation_forest.json
note: 2/10
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M10 Anti-arnaque sur labels privés]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

## Ce que c'est

Une forêt d'arbres aléatoires qui coupe les données au hasard. Un point bizarre est isolé en peu de coupes, un point normal en beaucoup. Le score d'anomalie vient de cette profondeur. **Aucune étiquette n'est nécessaire** : c'est son avantage, et aussi sa limite.

## Le scénario testé

- **Population** : 20 000 wallets décrits par 8 comportements publics on-chain (nombre de transactions, âge, nombre de contreparties, valeur moyenne, part de nouveaux tokens, fonds venant de mixers, activité nocturne, prime de gas).
- **2 % d'arnaques**, de deux sortes :
  - **flagrantes** : déployeurs de rug pulls, wallets jeunes qui lancent beaucoup de tokens ;
  - **discrètes** : wallets anciens, activité presque normale, motifs ténus de financement et de contreparties.
- **6 % de wallets légitimes mais inhabituels** : bots et chasseurs d'airdrops. C'est la source réaliste de fausses alertes.
- **Adaptation** : les arnaqueurs discrets se rapprochent du comportement normal, comme ils le font une fois un détecteur connu.
- **Deux réglages** : le standard (256 wallets tirés par arbre) et le libre (tous les wallets par arbre).

## Qualité (50 000 wallets de test)

| Réglage | AUC | Arnaques flagrantes | Arnaques discrètes | Précision du top 1 % | Après adaptation |
|---|---|---|---|---|---|
| Standard | 0,868 | 0,963 | 0,802 | **14 %** | 0,73 (voir [[M10 Anti-arnaque sur labels privés]]) |
| Libre | 0,875 | 0,973 | 0,808 | 28 % | |

- **L'AUC flatteuse cache une précision catastrophique** : sur les 1 % de wallets les plus suspects, seuls 14 % sont de vraies arnaques. Les bots et chasseurs d'airdrops sont aussi « bizarres » que les arnaqueurs.
- **Les arnaques discrètes sont mal séparées** (0,80), et après adaptation des arnaqueurs, le score tombe à 0,57 (mesure M10) : presque le hasard.
- À titre de comparaison, un classifieur entraîné sur des étiquettes privées atteint **90 % de précision** sur le même top 1 % (M10).

## Extraction

| Réglage | Appartenance, tous wallets (AUC calibrée) | Appartenance, arnaques seules | Seuils dans les queues extrêmes | Feuilles d'un seul wallet |
|---|---|---|---|---|
| Standard | 0,503 | 0,501 | **45** | 84 % |
| Libre | 0,524 | 0,553 | **3 946** | 83 % |

- **L'attaque d'appartenance ne trouve presque rien** avec le réglage standard : chaque wallet n'apparaît que dans quelques arbres.
- **Mais le fichier livré décrit des individus.** L'algorithme est conçu pour isoler chaque point jusqu'à ce qu'il soit seul : 84 % des feuilles contiennent un seul wallet, et des dizaines de seuils (des milliers en réglage libre) tombent dans les 0,1 % extrêmes. Chacun de ces seuils dit « il existe dans les données du provider un wallet avec une valeur au-delà de ce point ». Pour des wallets, combiné aux données on-chain publiques, ça permet souvent de retrouver l'adresse.
- **Anomalie relevée à l'audit** : sur les canaris dupliqués en réglage libre, le signal est **inversé** (AUC de 0,37). Les doublons ne peuvent pas être séparés par les coupes et paraissent plus anormaux. Un attaquant qui connaît ce sens l'exploite aussi bien (écart de 0,13 au hasard).

## Avis honnête : 3/10

**Je déconseille ce modèle pour Sirius**, pour trois raisons :

1. **Il n'utilise aucune donnée privée** : il tourne sur des comportements on-chain publics. N'importe qui peut l'entraîner seul, donc Sirius n'apporte rien.
2. **Sa qualité réelle est faible** (14 % de précision) et se dégrade quand les arnaqueurs s'adaptent.
3. **Sa structure même isole des individus**, ce qui est l'inverse de ce que Sirius doit garantir.

La version qui a de la valeur, ce sont les étiquettes privées : voir [[M10 Anti-arnaque sur labels privés]].

## Mise à jour : sur données réelles (note 3 → 2)

Sur 85 000 vraies adresses Ethereum (voir [[Données réelles]]) : **AUC de 0,61, puis 0,55 sur les adresses plus récentes**, et 14 % de précision dans le top 1 %. Un classifieur sur les seuls signalements publics fait 0,80. Le fichier livré contient en moyenne 32 seuils dans les queues extrêmes.

**Nouvelle note : 2/10.** À abandonner.
