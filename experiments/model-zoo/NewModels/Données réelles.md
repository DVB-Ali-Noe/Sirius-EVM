---
type: rapport
projet: Sirius
sujet: Les modèles retestés sur données réelles gratuites (crédit, fraude Ethereum, Binance)
tags: [sirius, donnees-reelles, credit, ethereum, binance, confidentialite]
date: 2026-10-13
scripts: experiments/model-zoo/real/
resultats: experiments/model-zoo/results/r1_credit_taiwan.json, r2_eth_scam.json, r3_binance_experience_4h.json, r3_binance_experience_24h.json
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

## En bref

| Test | Données | Ce que ça confirme | Ce que ça contredit |
|---|---|---|---|
| **R1, crédit** | 30 000 clients d'une banque taïwanaise (UCI) | Le bridage protège ; un modèle prêté vaut beaucoup plus que 500 données propres | Le gain des arbres est **bien plus grand** qu'en synthétique ; le recalibrage n'apporte rien ici |
| **R2, fraude Ethereum** | 85 000 adresses étiquetées (Hugging Face), labels publics Forta | Les labels privés ont une vraie valeur ; **la fuite de la liste secrète est réelle** ; l'Isolation Forest est faible | Sur 2021-2022, les labels publics rattrapent les privés |
| **R3, Binance** | 8 perpétuels, 2025, carnet d'ordres toutes les 30 s, open interest, ratios long/short | Les arbres bridés ne fuient presque rien | **La location d'expérience n'apporte aucun gain mesurable** : tout est dans le bruit |

**La leçon principale** : le synthétique avait bien prédit les **fuites** (mêmes ordres de grandeur), mais mal prédit la **valeur** (trop optimiste sur le trading, trop pessimiste sur le crédit).

## Un piège évité : le biais d'année dans les données Ethereum

Dans le dataset Ethereum publié, la part d'arnaques dépend énormément de l'année d'apparition de l'adresse : 3,6 % en 2017, 99,9 % en 2024. Un modèle entraîné tel quel apprend « adresse récente = arnaque », pas la fraude, et affiche une qualité trompeuse.

**Correction** : seules les adresses de 2017 à 2022 sont gardées, avec 5 % d'arnaques **dans chaque année**. L'entraînement porte sur 2017-2020, et 2021-2022 sert à mesurer la dérive. Toute publication de résultats sur ce dataset sans cette correction serait gonflée.

## R1, crédit taïwanais (M01 arbres, M02 calibrage)

**Source** : UCI « default of credit card clients » (OpenML 42477), 30 000 clients, 22 % de défauts, 23 variables (plafond, âge, statut des 6 derniers paiements, factures, remboursements). Chaque graine tire un nouveau découpage : 8 000 membres, 8 000 non-membres, 6 000 pour l'attaquant, 8 000 de test. Décision : accorder le crédit si P(défaut) < 1/6 (gain de 0,2 sur un bon client, perte de 1 sur un défaut).

### Qualité

| Modèle | AUC | ECE | Gain par client | Crédits accordés | Défauts parmi les accordés |
|---|---|---|---|---|---|
| Logistique (Sirius actuel) | 0,716 | **0,049** | 0,018 | 38 % | 12,8 % |
| **Arbres bridés** | **0,771** | 0,014 | **0,043** | 56 % | 10,3 % |
| Arbres stricts (feuilles ≥ 1 000) | 0,760 | 0,013 | 0,042 | 56 % | 10,3 % |
| Arbres libres | 0,747 | 0,124 | 0,025 | 77 % | 14,0 % |

- **Sur données réelles, les arbres valent bien plus que prévu** : +0,055 d'AUC (contre +0,012 en synthétique) et **2,4 fois plus de gain par client**. Ils accordent plus de crédits avec moins de défauts. Les vrais remboursements ont des seuils et des interactions qu'une logistique rate.
- **La logistique est mal calibrée sur les vraies variables** (ECE de 4,9 %, contre 0,9 % en synthétique), à cause des montants très asymétriques.
- **Le profil strict ne coûte presque rien** : 0,042 de gain contre 0,043.

### Transfert vers une autre banque (M02)

Le provider prête un modèle entraîné sur ses clients de moins de 35 ans. Le borrower est une banque dont les clients ont 45 ans et plus.

| Modèle | Modèle prêté tel quel | Recalibré sur 500 clients du borrower | Borrower seul (500 clients) |
|---|---|---|---|
| Logistique | 0,0097 | 0,0105 | 0,0052 |
| **Arbres bridés** | **0,0367** | 0,0363 | 0,0049 |

- **Le modèle prêté rapporte 7,5 fois plus que ce que le borrower obtient seul** avec ses 500 clients. C'est la meilleure preuve de valeur du prêt de toute la série, sur données réelles.
- **Le recalibrage n'apporte rien ici** : le décalage entre jeunes et plus âgés est modéré, et les arbres sont déjà calibrés. Le synthétique (où il transformait une perte en gain) exagérait son rôle. Il reste une sécurité utile quand le marché du borrower diffère fortement.

### Extraction

| Modèle | Appartenance, AUC calibrée | Détectés à 1 % de faux positifs | Canaris ×1 extraits (témoins) | Canaris ×5 extraits (témoins) |
|---|---|---|---|---|
| Logistique | 0,507 | 1,1 % | 15 % (19 %) | 25 % (28 %) |
| Arbres bridés | 0,550 | 2,0 % | **67 % (40 %)** | **99 % (56 %)** |
| Arbres stricts | 0,519 | 1,4 % | 30 % (28 %) | 65 % (44 %) |
| Arbres libres | 0,696 | 7,0 % | 100 % (49 %) | 100 % (53 %) |

- **L'attaque d'appartenance donne les mêmes chiffres qu'en synthétique** (0,550 contre 0,544 pour les bridés).
- **Les canaris sont plus extraits sur données réelles** : +27 points au-dessus du hasard dès la première copie pour les arbres bridés (+7 en synthétique). Les vraies variables (factures, montants) ont des queues épaisses, donc un record atypique tombe plus facilement dans une région où il pèse seul.
- **Le profil strict ramène la fuite à presque rien** sur les records uniques (+2 points), pour 2 % de gain en moins. **Sur données réelles, c'est le profil strict qu'il faut imposer, pas le bridé.**
- Les taux « témoins » sont hauts (28 à 56 %) car les canaris tombent dans des régions vides où les modèles divergent. Seul l'écart entre injectés et témoins compte.

## R2, fraude Ethereum (M04 Isolation Forest, M10 labels privés)

**Sources** : [fesevu/ethereum_fraud_dataset_by_activity](https://huggingface.co/datasets/fesevu/ethereum_fraud_dataset_by_activity) (activité mensuelle de 85 000 adresses, labels Etherscan et listes d'arnaques, CC-BY-4.0) et [Forta labelled datasets](https://github.com/forta-network/labelled-datasets) (6 700 adresses de phishing publiquement signalées).

- **Rôle des deux listes** : les adresses signalées par Forta jouent les « signalements publics » (62 % des arnaques retenues), les autres arnaques jouent la « liste privée de l'exchange ».
- **Variables** : 25 agrégats de comportement par adresse (nombre et types de transactions, contreparties, tokens, montants, échecs, durée d'activité).
- **Volumes** : 12 700 adresses par lot, dont environ 550 arnaques.

### Qualité (2017-2020)

| Modèle | AUC | Arnaques secrètes contre saines (AUC) | Précision top 1 % | Arnaques secrètes trouvées dans le top 5 % |
|---|---|---|---|---|
| Isolation Forest | 0,606 | 0,635 | 14 % | 21 % |
| Arbres sur signalements publics | 0,799 | 0,583 | **93 %** | 8 % |
| **Arbres sur liste privée, bridés** | **0,902** | **0,870** | 90 % | **34 %** |
| Arbres sur liste privée, stricts | 0,881 | 0,834 | 85 % | 27 % |
| Arbres sur liste privée, libres | 0,907 | 0,885 | 92 % | 42 % |

### Dérive (adresses de 2021-2022, jamais vues)

| Modèle | AUC | Arnaques secrètes trouvées dans le top 5 % |
|---|---|---|
| Isolation Forest | 0,550 | 17 % |
| Arbres sur signalements publics | 0,913 | 48 % |
| **Arbres sur liste privée, bridés** | **0,930** | 48 % |
| Arbres sur liste privée, stricts | 0,820 | 38 % |

- **La liste privée apporte une vraie valeur sur la période d'entraînement** : 4 fois plus d'arnaques secrètes trouvées que les signalements publics (34 % contre 8 %).
- **Mais sur la période suivante, les signalements publics rattrapent les labels privés** (0,913 contre 0,930), probablement parce que les arnaques de 2021-2022 ressemblent davantage aux cas signalés publiquement. La valeur d'une liste privée dépend donc de sa fraîcheur et de sa différence avec ce qui est public.
- **L'Isolation Forest est faible sur données réelles** (AUC 0,61, puis 0,55 en dérive) : le 3/10 du synthétique était généreux.
- **Le profil strict perd beaucoup en dérive** (0,82 contre 0,93) : sur ce cas, il coûte cher.

### Extraction de la liste secrète

| Modèle | Secrets signalés s'ils étaient dans les données / sinon | Appartenance sur les secrets, AUC calibrée | Détectés à 1 % de faux positifs | à 0,1 % |
|---|---|---|---|---|
| Bridé | 47 % / 36 % | **0,696** | 8,3 % | **4,2 %** |
| Strict | 32 % / 30 % | 0,607 | 3,3 % | 0,4 % |
| Libre | **100 %** / 44 % | 0,859 | 30 % | 23 % |

- **La fuite prédite en synthétique est confirmée, et même un peu plus forte** (0,696 contre 0,668). À 0,1 % de faux positifs, l'attaquant identifie 4 % des wallets secrets du modèle bridé avec quasi-certitude : **sur une liste de 10 000 enquêtes, ça fait 400 suspects prévenus**.
- **Le profil strict réduit la fuite de moitié**, mais coûte 11 points d'AUC en dérive. Il n'existe pas de réglage qui garde à la fois la qualité et la confidentialité : **la seule vraie protection est de ne pas livrer ce modèle et de servir des scores depuis l'enclave**.

## R3, Binance (M11 location d'expérience, M03 quantile)

**Source** : [Binance Public Data](https://github.com/binance/binance-public-data/), perpétuels USD-M, 8 cryptos (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK), toute l'année 2025, agrégée à l'heure. Environ 66 000 heures-symboles.

- **Variables publiques** : momentum, volatilité, volume, part acheteuse, heure.
- **Variables de contexte**, dans le rôle de « l'expérience de l'agent » : déséquilibre et profondeur du carnet (instantanés toutes les 30 s), variation de l'open interest, ratios long/short.
- **Calendrier** : quatre providers enregistrent différents symboles de janvier à août, le borrower n'a que ses 30 derniers jours (août), test de septembre à décembre.

**Limite essentielle de ce test** : Binance archive ces variables, donc elles ne sont pas vraiment perdues après coup. Le test mesure la mécanique (louer un historique de contexte plus long aide-t-il ?), pas la rareté.

### Qualité (septembre à décembre 2025, coûts de 4 pb inclus)

| Scénario | IC à 4 h | Sharpe à 4 h | IC à 24 h | Sharpe à 24 h |
|---|---|---|---|---|
| Historique public seul | −0,001 | 0,68 | 0,017 | 1,72 |
| Ses 30 derniers jours seulement | 0,002 | −2,18 | **0,054** | 0,82 |
| + location d'un provider | 0,004 à 0,032 | −1,66 à −0,54 | −0,001 à 0,020 | −0,92 à 0,18 |
| + pool de 4 providers | 0,002 | −0,63 | 0,027 | 0,09 |
| Pool, linéaire | −0,008 | −0,11 | 0,031 | 1,55 |
| Toutes les données, tous les symboles | 0,001 | −0,84 | 0,030 | 0,55 |

**Lecture honnête :**

1. **Rien n'est statistiquement distinguable du bruit.** Avec 4 mois de test, l'erreur sur un IC est d'environ ±0,03 à 24 h, ce qui couvre tous les écarts du tableau. Les Sharpe sautent d'un signe à l'autre selon le seuil de décision.
2. **La location d'expérience n'apporte aucun gain mesurable.** À 24 h, les 30 derniers jours du borrower font même mieux que l'historique loué : le marché change de régime, et un historique ancien vieillit vite.
3. **Le contexte le plus prédictif, mesuré sur toute l'année, est le ratio de comptes long/short des particuliers à 24 h** (IC de −0,068, signal contrarian). Le carnet d'ordres agit à l'échelle de la minute et disparaît dans les moyennes horaires.
4. **L'extraction reste faible** : appartenance sur les records d'Atlas à 0,534 (bridés) contre 0,608 (libres).

### Régression quantile (M03)

| Méthode | Pinball à 4 h | Couverture 80 % | En forte volatilité |
|---|---|---|---|
| Fourchette fixe | 1,744 | 79 % | 88 % |
| Quantile linéaire, variables publiques | 1,719 | 80 % | 78 % |
| Arbres quantiles bridés, variables publiques | **1,716** | 80 % | **80 %** |
| Arbres quantiles bridés, + contexte | 1,715 | 79 % | 78 % |

- **Sur données réelles, les modèles quantiles ne gagnent que 1,6 % sur une fourchette fixe**, contre 8 % en synthétique.
- **Le contexte n'apporte rien.**
- **La couverture reste juste**, ce qui est le vrai service rendu : une fourchette honnête, pas une meilleure prédiction.

## Ce qui change dans les notes

| Modèle | Avant | Après | Pourquoi |
|---|---|---|---|
| [[M01 Arbres boostés]] | 7 | **8** | Gain réel 4 fois plus fort qu'en synthétique ; profil strict validé |
| [[M02 GO-NO_GO calibré]] | 6 | 5 | Le recalibrage n'a rien apporté sur données réelles ; c'est le modèle prêté qui crée la valeur |
| [[M03 Régression quantile]] | 5 | 4 | 1,6 % de gain seulement, le contexte n'aide pas |
| [[M04 Isolation Forest]] | 3 | 2 | AUC 0,61 sur données réelles |
| [[M10 Anti-arnaque sur labels privés]] | 6 | **7** | Valeur confirmée (×4 sur les arnaques secrètes), fuite quantifiée et mitigation connue ; la seule réserve est la fraîcheur des labels |
| [[M11 Location d'expérience]] | 8 | **6** | Aucun gain mesurable sur Binance ; l'idée reste la meilleure en théorie mais n'est pas validée |

## Ce qu'il faudrait pour trancher sur M11

- **Un test plus long** : deux ou trois ans, pour descendre l'erreur sur l'IC sous ±0,01.
- **De vraies données d'agent**, non archivées publiquement : décisions et contexte de vrais agents Virtuals, ou de vrais traders qui accepteraient de partager.
- **Le bon horizon** : le carnet d'ordres à l'échelle de la minute, ce qui demande des données tick par tick (payantes chez Tardis, sauf le premier jour de chaque mois).

## Relancer

```bash
cd experiments/model-zoo
uv run real/fetch_binance.py --start 2025-01-01 --end 2025-12-31 --out data/binance   # ~10 min, 10 Mo agrégés
uv run real/r1_credit_taiwan.py --seeds 5
uv run real/r2_eth_scam.py --seeds 5            # données Ethereum dans data/eth (voir le script)
uv run real/r3_binance_experience.py --seeds 3 --horizon 4
uv run real/r3_binance_experience.py --seeds 3 --horizon 24
```
