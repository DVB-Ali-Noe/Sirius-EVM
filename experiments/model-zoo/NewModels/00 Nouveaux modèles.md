---
type: index
projet: Sirius
sujet: Nouveaux modèles pour Sirius, testés en qualité et en extraction de données
tags: [sirius, virtuals, ml, confidentialite, rapport]
date: 2026-10-13
branche: exp/agent-experience-lending
dossier: experiments/model-zoo/ et experiments/agent-experience-lending/
statut: prototypes synthétiques et données réelles, rien dans le runner
liens: ["[[Méthode de test]]", "[[Location d'expérience entre agents]]", "[[00 Index]]"]
---

## Ce dossier

Les 11 idées de modèles discutées pour Sirius et les agents Virtuals ont été construites et testées sur deux axes :

- **qualité** : est-ce que ça marche mieux que ce qu'un agent peut faire seul ?
- **extraction** : à quel point le modèle livré laisse fuir les données du provider ?

Le protocole commun est dans [[Méthode de test]]. Les modèles de décision Kev ont leur propre dossier : [[00 Index]].

**Données utilisées.** Tous les modèles ont d'abord été testés sur données synthétiques. Six d'entre eux ont ensuite été retestés sur **données réelles gratuites** : crédit bancaire taïwanais, 85 000 adresses Ethereum étiquetées, carnets d'ordres Binance de 2025. Voir [[Données réelles]]. Les notes ci-dessous tiennent compte des deux.

**Ce que le réel a appris sur le synthétique** : il prédisait bien les **fuites** (mêmes ordres de grandeur), mais mal la **valeur**. Il était trop optimiste sur le trading (où j'avais mis le signal moi-même) et trop pessimiste sur le crédit.

## Classement

| Rang | Modèle | Note | Testé sur réel | Qualité | Extraction (version recommandée) | Verdict en une ligne |
|---|---|---|---|---|---|---|
| 1 | [[M01 Arbres boostés]] | **8/10** | Oui, crédit | Réel : AUC 0,771 contre 0,716 (logistique), gain par client ×2,4 ; prêté, ×7,5 face au borrower seul | Profil strict : fuite négligeable | La brique la mieux validée, à construire en premier |
| 2 | [[M10 Anti-arnaque sur labels privés]] | **7/10** | Oui, Ethereum | Réel : ×4 d'arnaques secrètes trouvées ; les labels publics rattrapent sur les années suivantes | **Fuite confirmée** : 4,2 % des secrets identifiés à 0,1 % de faux positifs | Vraie valeur, mais seulement en service de scores |
| 2 | [[M09 Modèle coopératif multi-agents]] | 7/10 | Non | Comme M11 | Aucune fuite d'attribut ; un copieur est payé autant que l'original | Le mécanisme de pool et de paiement, utile pour toute location multi-providers |
| 4 | [[M11 Location d'expérience]] | 6/10 | Oui, Binance | Synthétique : ×2 ; **réel : aucun gain mesurable** | Aucune fuite mesurée | La meilleure idée en théorie, non validée |
| 5 | [[M02 GO-NO_GO calibré]] | 5/10 | Oui, crédit | Réel : le recalibrage n'apporte rien quand le décalage est modéré | Aucune fuite ajoutée | Sécurité pour marchés très différents |
| 5 | [[M07 Modèle de décision type Kev]] | 5/10 | Partiel (CFPB) | Gains forts, seul modèle texte, transfert prouvé | Mémorise les records répétés (AUC 0,915) | Pour plus tard, en service, jamais en livrant l'adaptateur |
| 7 | [[M03 Régression quantile]] | 4/10 | Oui, Binance | Réel : 1,6 % de mieux qu'une fourchette fixe | Linéaire : rien | Option de catalogue |
| 7 | [[M06 Learning-to-rank]] | 4/10 | Non | Très fort, mais par construction | Fuite par tâche ; plancher LightGBM non respecté | Pas de provider qui aurait intérêt à louer |
| 7 | [[M08 Signaux sur données alternatives]] | 4/10 | Non | Utile seulement en service permanent | Produit reconstruit à 0,71 (0,37 avec signaux grossiers) | Ancien marché, et le prêt de modèle ne marche pas |
| 10 | [[M05 Évaluateur ACP]] | 3/10 | Non (aucune donnée ACP publique trouvée) | Inutile sans signaux privés supposés | Comme M01 | Données publiques, rôle inactif |
| 11 | [[M04 Isolation Forest]] | 2/10 | Oui, Ethereum | Réel : AUC 0,61 | Le fichier isole des individus | À abandonner |

## Le verdict, après les données réelles

**Ce qui est prouvé** : louer un modèle à arbres entraîné sur des données privées crée beaucoup de valeur. Sur le crédit réel, le modèle prêté rapporte **7,5 fois plus** que ce que le borrower obtient seul, et le profil strict rend la fuite négligeable. C'est la thèse de Sirius, validée sur un cas réel, avec le type de client déjà visé par les entretiens (petites fintechs, scoring crédit).

**Ce qui est prouvé aussi, mais avec un risque** : la liste privée d'arnaques (M10) a une vraie valeur, et elle fuit de façon mesurable même bridée. À servir depuis l'enclave, jamais à livrer.

**Ce qui n'est pas prouvé** : la location d'expérience entre agents de trading (M11). Elle reste l'idée la plus alignée avec Virtuals et Robinhood Chain, mais sur de vrais marchés crypto, le signal est trop faible pour qu'un historique loué fasse une différence mesurable. Pour la sauver, il faudrait de vraies données d'agent, un horizon à la minute et plusieurs années de test.

**Conséquence pour la stratégie** : le cas d'usage le plus solide est le plus classique (scoring tabulaire B2B), pas le plus « crypto-natif ». Pour Virtuals, la piste la plus défendable devient l'anti-arnaque (M10), en service de scores pour les agents.

## Ce que la série apprend, au-delà des modèles

1. **Brider les arbres ne coûte rien, ça rapporte.** Dans tous les cas supervisés, les arbres bridés sont **meilleurs** que les arbres libres, et fuient beaucoup moins :

| Modèle | Qualité, bridés / libres | Appartenance calibrée, bridés / libres |
|---|---|---|
| M01 crédit (AUC) | 0,723 / 0,667 | 0,544 / 0,697 |
| M03 quantile (pinball, plus bas = mieux) | 0,443 / 0,480 | 0,578 / 0,796 |
| M05 évaluateur (AUC) | 0,772 / 0,740 | 0,553 / 0,737 |
| M06 ranking (NDCG@3) | 0,870 / 0,860 | 0,578 / 0,802 |
| M10 arnaques (AUC) | 0,982 / 0,975 | 0,668 / 0,818 sur les secrets |

2. **Les doublons sont la fuite qui résiste au bridage.** Un record unique présent une fois est peu extrait par les arbres bridés (11 à 24 %, contre 5 à 15 % par hasard). Présent 5 fois, il l'est à 54 à 81 % dans les classifieurs (M01, M02, M05, M10). Le ranking (22 %) et les quantiles (3 %) y résistent mieux. **La déduplication dans l'enclave est obligatoire.**
3. **L'attaque d'appartenance globale ne suffit pas comme audit.** Elle ne voit rien sur M10 et M07, alors qu'une attaque ciblée (les secrets, les canaris répétés) trouve une fuite réelle. Un audit Sirius doit inclure des canaris et des attaques ciblées sur ce qui est sensible.
4. **Les fichiers livrés en disent plus que les prédictions.** scikit-learn, LightGBM et l'Isolation Forest exportent le nombre de records par feuille, et **LightGBM ne respecte pas le plancher demandé** (feuilles de 44 à 78 records pour un minimum de 200). Sirius doit vérifier le modèle produit, retirer ces champs et exporter dans un format minimal.
5. **La régression linéaire et la logistique ne fuient rien de mesurable**, même avec des doublons. Le catalogue actuel de Sirius est sûr ; le risque arrive avec la non-linéarité.
6. **Deux familles d'usages se dessinent :**
   - **Prêt de modèle** (le modèle actuel de Sirius) : M01, M02, M03, M09, M11. Le borrower repart avec un modèle qu'il utilise avec ses propres données.
   - **Service depuis l'enclave** : M07, M08, M10. Le modèle a besoin des données du provider en continu, ou est trop sensible pour être livré. Ça demande une machine allumée en permanence et une autre architecture.

## Ce que Sirius devrait faire, dans l'ordre

1. **Arbres au profil strict dans le runner** (feuilles d'au moins 1 000 records), avec déduplication, vérification du modèle produit et export minimal ([[M01 Arbres boostés]]). C'est validé sur données réelles.
2. **Recalibrage côté borrower en option**, surtout pour la logistique actuelle, mal calibrée sur vraies données ([[M02 GO-NO_GO calibré]]).
3. **Prototype de service de scores anti-arnaque** depuis l'enclave, avec requêtes limitées et journalisées ([[M10 Anti-arnaque sur labels privés]]). C'est la piste Virtuals la plus solide.
4. **Ne construire la location d'expérience qu'après avoir obtenu de vraies données d'agent** ([[M11 Location d'expérience]], [[M09 Modèle coopératif multi-agents]]).

## Code et relance

- `experiments/model-zoo/` : `m01` à `m10` (sauf `m07`), `common.py` (attaques et mesures), `wallets.py`, `run_all.sh`, `digest.py`, résultats dans `results/`.
- `experiments/model-zoo/real/` : téléchargement Binance et les trois tests sur données réelles (`r1`, `r2`, `r3`).
- `experiments/agent-experience-lending/` : marché synthétique et location d'expérience (M11).
- `experiments/kev-decision-tune/` : Kev (M07).
- Toute la série tourne en environ 20 minutes sur CPU : `./run_all.sh 5`.
