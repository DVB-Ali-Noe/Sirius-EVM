# Contexte : nouveaux modèles pour Sirius (12-13 octobre 2026)

Ce document reprend tout le contexte du travail sur les nouveaux modèles : la question de départ, les recherches, les décisions, les expériences, les résultats, les pièges rencontrés et ce qui reste ouvert. Il suffit à reprendre le sujet sans l'historique de la conversation.

Branche : `exp/agent-experience-lending`, créée depuis `main` (`e55c47d`). Rien de ce travail ne touche au code de production de Sirius : tout est dans `experiments/`.

## 1. La question de départ

Trouver de nouveaux modèles que Sirius pourrait proposer, en partant des agents Virtuals (Virtuals Protocol), et chercher ceux qui s'y adapteraient parfaitement.

Aujourd'hui, Sirius ne propose que la **régression linéaire** et la **régression logistique** (`src/lib/models/registry.ts`, `src/lib/tee/train.ts`). Les entrées sont limitées à 3 Mo, et les jobs v7 sont bornés entre 1 et 30 secondes.

## 2. Ce qu'on a appris sur Virtuals

- **ACP** (Agent Commerce Protocol) : les agents se vendent des services en USDC. Cycle : demande, négociation, séquestre, livraison, évaluation, règlement. Environ 18 000 agents. Depuis février 2026, le Revenue Network reverse jusqu'à 1 M$ par mois aux agents qui vendent via ACP.
- **Agents marquants** :
  - trading et signaux : aixbt, GigaBrain sur Hyperliquid, arène de trading DJClaw ;
  - épargne DeFi : Mamo ;
  - due diligence : wachAI ;
  - analyse de contrats : BevorAI ;
  - sentiment : Acolyt ;
  - orchestrateurs : Butler, Luna ;
  - veto GO/NO_GO sur Polymarket.
- **Les entrées et sorties des jobs ACP sont stockées on-chain**, donc publiques. Le rôle d'évaluateur (5 % de chaque transaction) n'était pas actif au moment des sources lues.
- **Virtuals est intégré à Robinhood Chain depuis son lancement en juillet 2026**, et le token Sirius y est déjà (`app.virtuals.io/virtuals/137992`, voir `docs/tweets.md`). Une première analyse supposait à tort que Virtuals vivait sur Base, d'où un « problème de réseau » qui n'existe pas.
- **Sur Robinhood Chain, les agents font surtout** du trading d'actions tokenisées, des indices sur mesure et du market-making.
- **Aucune API ni export public des jobs ACP** n'a été trouvé.

Sources principales : whitepaper Virtuals, dépôt GitHub ACP, Delphi Digital, Chain of Thought (« Markets for Machines »), communiqué du Revenue Network, Crypto Briefing et KuCoin pour l'intégration à Robinhood Chain.

## 3. Le raisonnement et les décisions de Noé

1. **Première liste de 7 idées** : arbres boostés, GO/NO_GO calibré, régression quantile, Isolation Forest, évaluateur ACP, learning-to-rank, modèle de décision type Kev.
2. **Noé a demandé de juger les idées sur le fond**, sans tenir compte de ce qui était déjà planifié (roadmap, expérience Kev). Trois idées ont été ajoutées : signaux sur données alternatives, modèle coopératif multi-agents, anti-arnaque sur labels privés.
3. **Critique décisive de Noé** : les données alternatives (panels de cartes, trafic web) relèvent du marché de la data réglementée et classique, déjà vendue, alors que **Sirius crée un nouveau marché de la donnée privée**. Le critère retenu devient : *une donnée qui existe, qui a de la valeur, et que son détenteur ne peut aujourd'hui pas monétiser sans la perdre*.
4. **Idée qui en découle : la location d'expérience entre agents.** L'actif privé d'un agent n'est ni sa stratégie ni les prix, mais le **contexte vu au moment de décider**, perdu s'il n'est pas enregistré. Robinhood Chain rend les résultats vérifiables on-chain alors que le contexte reste privé.
5. **Noé a demandé** de construire ce modèle, puis tous les modèles discutés, de les tester (qualité, extraction de données) avec un rapport détaillé et honnête par modèle, de tout auditer, d'affiner, puis de retester sur des **données réelles gratuites**.

## 4. Ce qui a été construit

| Dossier | Contenu |
|---|---|
| `agent-experience-lending/` | Marché synthétique et location d'expérience (M11) : engagements on-chain, tricheur, valeur de Shapley, fuite de stratégie |
| `model-zoo/` | `common.py` (mesures de qualité, attaques d'extraction), `wallets.py` (population de wallets synthétique), `m01` à `m10` (sauf `m07`), `run_all.sh`, `digest.py`, `results/` |
| `model-zoo/real/` | `fetch_binance.py` (téléchargement et agrégation horaire) et trois tests sur données réelles : `r1_credit_taiwan.py`, `r2_eth_scam.py`, `r3_binance_experience.py` |
| `model-zoo/NewModels/` | Les 14 rapports (format Obsidian), dont l'index `00 Nouveaux modèles.md`, `Méthode de test.md` et `Données réelles.md` |

**Le modèle M07 (Kev) n'a pas été relancé** : ses résultats viennent de `experiments/kev-decision-tune/runs-gpu/` (branche `exp/kev-decision-tune`, tests GPU du 12 octobre). Ce dossier n'est pas commité ici (environ 3 Go, dont des poids de modèles).

**Copie des rapports** : dans le vault Obsidian de Noé, `Projets/Sirius/NewModels/`, plus une mise à jour de `Projets/Sirius/Location d'expérience entre agents.md`. Un résumé est aussi sur le bureau, `~/Desktop/sirius-modeles-virtuals.md`.

## 5. La méthode de test (résumé de `NewModels/Méthode de test.md`)

- **Modèle de menace** : le borrower repart avec le modèle, donc l'attaquant a un accès complet au fichier livré et une population de référence de même distribution.
- **Découpage** : membres, non-membres, référence de l'attaquant, test. 5 graines (10 pour la location d'expérience, 3 pour Binance).
- **Attaques** :
  - inférence d'appartenance, simple et calibrée par un modèle de référence (AUC, taux de détection à 1 % et 0,1 % de faux positifs) ;
  - canaris uniques étiquetés à l'inverse du motif de la population, injectés une fois ou cinq fois ;
  - lecture du fichier livré (comptes par feuille, feuilles minuscules, seuils dans les queues extrêmes, plancher réel) ;
  - attaques propres à certains modèles : inférence d'attribut, reconstruction du produit d'un vendeur, fuite d'une liste secrète, attaques économiques (historique fabriqué, copieur, profiteur).
- **Réglages des arbres** :
  - libre : 63 feuilles, minimum 1 record par feuille ;
  - bridé : profondeur 3, minimum 200 records par feuille ;
  - strict : profondeur 2, minimum 1 000 records par feuille.

## 6. Résultats et classement final

| Note | Modèle | Testé sur réel | En une ligne |
|---|---|---|---|
| **8/10** | M01 Arbres boostés | Oui, crédit | Sur le crédit réel, AUC 0,771 contre 0,716 pour la logistique, gain par client ×2,4. Prêté à une autre banque, ×7,5 face au borrower seul. Profil strict nécessaire. |
| **7/10** | M10 Anti-arnaque sur labels privés | Oui, Ethereum | ×4 d'arnaques secrètes trouvées. Fuite de la liste confirmée (AUC calibrée 0,696, 4,2 % des secrets identifiés à 0,1 % de faux positifs). À servir depuis l'enclave, jamais à livrer. |
| 7/10 | M09 Modèle coopératif multi-agents | Non | Aucune fuite d'attribut. Faille : un copieur est payé autant que l'original par la valeur de Shapley. |
| 6/10 | M11 Location d'expérience | Oui, Binance | Synthétique : qualité doublée. Réel : aucun gain mesurable. Meilleure idée en théorie, non validée. |
| 5/10 | M02 GO/NO_GO calibré | Oui, crédit | Le recalibrage n'apporte rien quand le décalage est modéré. La logistique actuelle est mal calibrée sur de vraies variables (ECE 4,9 %). |
| 5/10 | M07 Modèle de décision type Kev | Partiel (CFPB) | Gains forts et transfert prouvé, mais mémorise les records répétés (AUC 0,915). La confidentialité différentielle tue l'utilité à 1 100 exemples. |
| 4/10 | M03 Régression quantile | Oui, Binance | Sur réel, seulement 1,6 % de mieux qu'une fourchette fixe, mais une couverture juste. |
| 4/10 | M06 Learning-to-rank | Non | Gain très fort mais construit par le générateur. LightGBM ne respecte pas le plancher de feuilles demandé. |
| 4/10 | M08 Signaux sur données alternatives | Non | Marché déjà existant. Un modèle livré sans flux de données ne sert à rien. Le produit du vendeur est reconstructible à 0,71 (0,37 avec des signaux grossiers). |
| 3/10 | M05 Évaluateur ACP | Non | Données publiques, rôle inactif. |
| 2/10 | M04 Isolation Forest | Oui, Ethereum | AUC 0,61 sur réel. Le fichier livré isole des individus. |

**Verdict** : le cas le mieux prouvé est le plus classique, le scoring tabulaire B2B (crédit), sur lequel portent déjà les entretiens prévus. Pour Virtuals, la piste la plus défendable est l'anti-arnaque en service de scores. La location d'expérience reste à valider avec de vraies données d'agent.

### Décision de Noé du 14 octobre 2026

Tout ce qui devrait être servi depuis l'enclave est écarté : M07, M08, M10.

- **Retenus**, en prêt de modèle : M01, M02 (étape de recalibrage en option), M03 (version linéaire).
- **En attente** : M09, conditionné à de vraies données d'agent.
- **Échecs** : M04, M05, M06 et M11 (aucun gain sur Binance).

Chaque rapport porte désormais `livraison` et `decision` dans son en-tête, ainsi qu'un encadré de décision.

## 7. Enseignements transversaux

1. **Brider les arbres améliore à la fois la qualité et la confidentialité**, dans tous les cas supervisés. Les arbres libres sont pires sur les deux plans.
2. **Les doublons sont la fuite qui résiste au bridage** : un record présent 5 fois est extrait à 54-81 % (synthétique), jusqu'à 99 % sur le crédit réel. La déduplication dans l'enclave est obligatoire.
3. **L'attaque d'appartenance globale ne suffit pas comme audit** : elle ne voit rien sur M10 et M07, alors que des attaques ciblées (secrets, canaris répétés) trouvent une fuite réelle.
4. **Les fichiers livrés en disent plus que les prédictions** : scikit-learn, LightGBM et l'Isolation Forest exportent le nombre de records par feuille, et LightGBM ne respecte pas le plancher demandé (feuilles de 44 à 78 records pour un minimum de 200). Sirius doit vérifier le modèle produit, retirer ces champs et exporter un format minimal.
5. **La logistique et la régression linéaire actuelles ne fuient rien de mesurable.**
6. **Deux familles d'usage** :
   - prêt de modèle, le modèle actuel de Sirius (M01, M02, M03, M09, M11) ;
   - service depuis l'enclave, avec une machine allumée en permanence (M07, M08, M10).
7. **Le synthétique prédit bien les fuites, mal la valeur** : trop optimiste sur le trading, trop pessimiste sur le crédit.

## 8. Audit et corrections en cours de route

- **Canaris** : la première version donnait des étiquettes au hasard, donc le niveau du hasard dépendait du taux de base. Ils sont désormais étiquetés à l'inverse du motif de la population, et toute la série a été relancée.
- **LightGBM** : le minimum de records par feuille n'est pas garanti (contournement aussi d'un plantage avec `min_child_samples=1`).
- **Isolation Forest** : sur les canaris dupliqués, le signal d'appartenance est inversé (AUC 0,37), mais tout aussi exploitable par un attaquant.
- **Biais d'année du dataset Ethereum** : 3,6 % d'arnaques en 2017, 99,9 % en 2024. Neutralisé en ne gardant que 2017-2022, avec 5 % d'arnaques dans chaque année ; entraînement sur 2017-2020, dérive mesurée sur 2021-2022.
- **Binance** : le carnet d'ordres agit à la minute, et son signal disparaît dans les moyennes horaires. Le signal réel le plus fort est le ratio long/short des comptes particuliers à 24 h (IC −0,068 sur l'année).
- **Location d'expérience, version synthétique** : les ajouts successifs (coûts de transaction, tricheur dont l'historique dit vraiment faux, témoin « pool sans le provider » pour la fuite de stratégie) ont été faits avant les chiffres finaux.

## 9. Données réelles utilisées

| Source | Usage | Accès |
|---|---|---|
| UCI « default of credit card clients » (OpenML 42477) | R1, M01 et M02 | `fetch_openml`, sans compte |
| `fesevu/ethereum_fraud_dataset_by_activity` (Hugging Face, CC-BY-4.0) : `lstm_dataset/monthly.parquet`, `gnn_dataset/labels/targets_global.parquet` | R2, M04 et M10 | Téléchargement direct |
| Forta `labelled-datasets`, `labels/1/phishing_scams.csv` | R2, rôle des « signalements publics » | GitHub raw |
| Binance Public Data, perpétuels USD-M : klines 1 h, `bookDepth`, `metrics`, 8 symboles, 2025 | R3, M11 et M03 | `real/fetch_binance.py`, environ 10 min |

Les données téléchargées vont dans `model-zoo/data/`, ignoré par Git. Pour R2, voir les URL dans le docstring de `r2_eth_scam.py` et ce tableau.

Autres sources repérées, non utilisées : ULB Credit Card Fraud (OpenML 1597), Polymarket (Hugging Face `SII-WANGZJ/Polymarket_data`), Opportunity Insights Economic Tracker (dépenses par carte agrégées), API Hyperliquid (funding testé), Fear & Greed Index.

## 10. Relancer

```bash
cd experiments/agent-experience-lending && uv run --python 3.13 lend.py --seeds 10 --out runs && python3 summary.py runs/results.json > runs/summary.md
cd experiments/model-zoo && ./run_all.sh 5 && python3 digest.py
cd experiments/model-zoo && uv run --python 3.13 real/fetch_binance.py --start 2025-01-01 --end 2025-12-31 --out data/binance
uv run --python 3.13 real/r1_credit_taiwan.py --seeds 5
uv run --python 3.13 real/r2_eth_scam.py --seeds 5
uv run --python 3.13 real/r3_binance_experience.py --seeds 3 --horizon 4
uv run --python 3.13 real/r3_binance_experience.py --seeds 3 --horizon 24
```

Tout tourne sur CPU, sans dépense : environ 20 minutes pour la série synthétique et 10 minutes pour les tests réels. Les scripts déclarent leurs dépendances en tête de fichier (PEP 723), et `uv` les installe.

## 11. Ce qui reste ouvert

1. **Arbres au profil strict dans le runner Sirius** (recommandé) : registre des modèles, profil d'entraînement v2, déduplication, vérification du modèle produit, export minimal sans comptes par feuille. C'est du code de production, avec tests et journal.
2. **Prototype de service de scores anti-arnaque depuis l'enclave**, avec requêtes limitées et journalisées.
3. **Valider la location d'expérience** :
   - obtenir de vraies données d'agent (décisions et contexte de vrais agents Virtuals ou de traders) ;
   - travailler à l'horizon de la minute ;
   - tester sur plusieurs années. Les données tick par tick sont payantes chez Tardis, sauf le premier jour de chaque mois.
4. **Faille de paiement du pool** : détecter les quasi-doublons entre providers avant de payer, et ne payer que le premier engagement daté.
5. **Rien de ce travail n'a été présenté à de vrais utilisateurs.** Les gains de M05 et M06 dépendent d'hypothèses posées dans les générateurs.

## 12. Notes d'environnement

- **Python 3.13 via `uv`**. Le Python système de Homebrew (3.14) n'a ni numpy ni scikit-learn.
- **Accès au vault iCloud** : il a été bloqué un temps par macOS (« Operation not permitted »), puis rétabli. Si ça recommence, autoriser le terminal dans Réglages Système, puis Confidentialité et sécurité, puis Accès complet au disque.
- **Affichage des chemins accentués** : le panneau « fichiers modifiés » de Claude Code les montre en octal (`\303\251`) tant que `git config --global core.quotePath false` n'est pas posé.
- **`experiments/kev-decision-tune/`** reste non suivi sur cette branche (environ 3 Go, dossier `.vendor` et sorties GPU).
