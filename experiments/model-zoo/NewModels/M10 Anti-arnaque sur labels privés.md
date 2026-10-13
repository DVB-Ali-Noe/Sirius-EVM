---
type: rapport-modele
projet: Sirius
modele: M10
sujet: Classifieur anti-arnaque entraîné sur la liste privée de wallets frauduleux d'un exchange
tags: [sirius, fraude, wallets, gbdt, labels-prives, confidentialite]
date: 2026-10-13
script: experiments/model-zoo/m10_scam_private_labels.py
resultats: experiments/model-zoo/results/m10_scam_private_labels.json
note: 7/10
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[M04 Isolation Forest]]"]
---

Retour : [[00 Nouveaux modèles]] · Protocole : [[Méthode de test]]

## Ce que c'est

Un exchange ou une société de conformité possède une liste privée de wallets frauduleux, confirmés par ses enquêtes. Les comportements on-chain sont publics, **seules les étiquettes sont privées**. Sirius entraînerait un classifieur sur ces étiquettes, et les agents obtiendraient un score de risque avant d'acheter un token ou d'accepter une contrepartie.

## Le scénario testé

- **Même population que [[M04 Isolation Forest]]** : 40 000 wallets par lot, 2 % d'arnaques (flagrantes ou discrètes), 6 % de bots légitimes.
- **Signalements publics** : 60 % des arnaques flagrantes, mais seulement 5 % des discrètes.
- **Liste privée de l'exchange** : 90 % de toutes les arnaques.
- **Le secret à protéger** : « ce wallet est dans la liste privée » pour les wallets confirmés par l'exchange mais jamais signalés publiquement. C'est une information d'enquête : la divulguer prévient le suspect et peut exposer l'exchange juridiquement.
- **L'attaquant le plus fort** : quelqu'un qui possède sa propre liste privée (un autre exchange) et entraîne le même modèle pour comparer.

## Qualité (60 000 wallets de test)

| Modèle | AUC | Arnaques discrètes | Précision du top 1 % | Arnaques discrètes trouvées dans le top 1 % | Discrètes après adaptation |
|---|---|---|---|---|---|
| Isolation Forest (sans étiquette) | 0,868 | 0,805 | 14 % | 0,6 % | 0,573 |
| Arbres sur signalements publics | 0,953 | 0,923 | 86 % | 6,8 % | 0,704 |
| **Arbres sur liste privée, bridés** | **0,982** | **0,973** | **90 %** | **15,6 %** | **0,850** |
| Arbres sur liste privée, stricts | 0,980 | 0,969 | 87 % | 12,9 % | 0,819 |
| Arbres sur liste privée, libres | 0,975 | 0,960 | 87 % | 12,6 % | 0,807 |

*Le top 1 % ne peut contenir au mieux que la moitié des arnaques (2 % de la population), d'où des taux de détection plafonnés.*

- **La liste privée apporte une vraie valeur**, surtout là où ça compte : 2,3 fois plus d'arnaques discrètes dans le top 1 %, et une bien meilleure tenue quand les arnaqueurs s'adaptent (0,85 contre 0,70).
- **Les signalements publics suffisent pour les arnaques flagrantes.** La valeur de Sirius est entièrement sur les discrètes.

## Extraction : la liste secrète fuit-elle ?

| Modèle | Secrets signalés dans le top 1 %, s'ils étaient dans les données | ... s'ils n'y étaient pas | Appartenance sur les secrets, AUC calibrée | Secrets détectés à 1 % de faux positifs |
|---|---|---|---|---|
| Bridé | 37,5 % | 31,7 % | **0,668** | 5,1 % |
| Strict (feuilles de 1 000) | 31,8 % | 29,2 % | 0,606 | 2,4 % |
| Libre | **100 %** | 28,8 % | **0,818** | **28,2 %** |

Sur l'ensemble des wallets, l'attaque d'appartenance ne voit rien (AUC 0,50 à 0,52). **Elle ne devient visible que si on cible les secrets** : un exemple concret de fuite qu'un audit global ne détecte pas.

**Lecture :**

1. **Une partie de la « fuite » est le service rendu.** Un wallet suspect est signalé dans 29 à 32 % des cas, qu'il soit dans la liste ou non : c'est le modèle qui fait son travail. Ce n'est pas une fuite de la liste.
2. **La fuite propre à la liste est l'écart entre les deux colonnes.** Elle est faible en version bridée (+6 points) et stricte (+3 points)...
3. **... mais l'attaque calibrée reste significative même bridée** (AUC 0,668) : c'est **la plus forte fuite de tous les modèles bridés de la série**. Les arnaques discrètes sont rares et dispersées, donc chacune pèse sur les feuilles où elle tombe.
4. **La version libre est inacceptable** : tous les wallets de la liste secrète sont signalés, et 28 % sont identifiés à coup sûr. Livrer ce modèle reviendrait à publier la liste.
5. **Canaris** (wallets ordinaires étiquetés arnaque sans raison visible) : version bridée, 11 % extraits une fois injectés, mais **81 % quand ils sont dupliqués 5 fois** (témoins 5 à 14 %). Un même wallet signalé plusieurs fois dans la liste se retrouverait dans le modèle.

## Ce que Sirius devrait imposer

- **Ne pas livrer ce modèle** : le servir depuis l'enclave, sous forme de score de risque. Le borrower n'a alors plus d'accès complet au modèle, ce qui coupe l'attaque calibrée.
- **Profil strict** (feuilles d'au moins 1 000 wallets) : la fuite calibrée tombe de 0,668 à 0,606 pour une perte de qualité minime (AUC 0,982 → 0,980).
- **Dédupliquer la liste** avant l'entraînement.
- **Limiter et journaliser les requêtes** : sinon un attaquant peut tester une à une les adresses qui l'intéressent.

## Avis honnête : 6/10

**C'est le cas qui correspond le mieux à la thèse de Sirius** : une donnée réellement privée (les enquêtes), qui vaut 0 $ aujourd'hui parce qu'elle ne peut pas être partagée, et une valeur claire et mesurée pour les agents.

**C'est aussi le plus risqué des modèles bridés.** La liste privée est précisément ce qu'un attaquant veut, et même bridé le modèle en laisse filtrer une partie mesurable. Il ne peut être proposé que sous forme de service de scores, pas de modèle livré. Ça éloigne du modèle de prêt ponctuel de Sirius, comme pour [[M08 Signaux sur données alternatives]].

Je le garde comme deuxième piste derrière la location d'expérience, à condition d'accepter cette forme « service ».

## Mise à jour : sur données réelles (note 6 → 7)

Sur 85 000 vraies adresses Ethereum, avec la liste de phishing publique Forta comme « signalements publics » (voir [[Données réelles]]) :

- **La valeur est confirmée** : AUC 0,902 contre 0,799 sur signalements publics, et **4 fois plus d'arnaques secrètes trouvées** dans le top 5 % (34 % contre 8 %).
- **Mais elle dépend de la fraîcheur** : sur les adresses de 2021-2022, les signalements publics rattrapent presque la liste privée (0,913 contre 0,930).
- **La fuite est confirmée et un peu plus forte** : AUC calibrée de 0,696 sur les secrets. À 0,1 % de faux positifs, **4,2 % des wallets secrets sont identifiés à coup sûr**.
- **Le profil strict divise la fuite par deux**, mais coûte 11 points d'AUC sur les adresses récentes.
- **Piège à connaître** : le dataset publié contient un fort biais d'année d'apparition qu'il a fallu neutraliser.

**Nouvelle note : 7/10.** C'est la seule idée dont la valeur ET le risque sont mesurés sur données réelles. Toujours à servir depuis l'enclave, jamais à livrer.
