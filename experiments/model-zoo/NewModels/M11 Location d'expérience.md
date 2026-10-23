---
type: rapport-modele
projet: Sirius
modele: M11
sujet: Location d'expérience entre agents (contexte point-in-time, résultats vérifiables on-chain)
tags: [sirius, virtuals, agents, gbdt, engagements, shapley, confidentialite]
date: 2026-10-13
script: experiments/agent-experience-lending/lend.py
resultats: experiments/agent-experience-lending/runs/summary.md
note: 6/10
livraison: modèle livré
decision: échec
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[Location d'expérience entre agents]]", "[[M09 Modèle coopératif multi-agents]]"]
---

Retour : [[00 Nouveaux modèles]] · Description complète : [[Location d'expérience entre agents]]

> **Décision du 14 octobre 2026** : Échec sur données réelles : aucun gain mesurable sur Binance. À ne rouvrir qu'avec de vraies données d'agent, un horizon à la minute et plusieurs années de test.

## Ce que c'est

Un agent qui démarre loue l'**expérience** d'agents plus anciens : le contexte éphémère qu'ils ont enregistré au moment de décider (sentiment, flux), que personne ne peut reconstruire après coup. Sirius entraîne des arbres bridés sur les **résultats** (jamais sur les actions des providers) et livre le modèle. Chaque record est engagé on-chain chaque jour, et l'enclave refuse tout record engagé après le résultat qu'il prédit.

## Résultats (10 graines, marché synthétique)

| Scénario | IC | Sharpe |
|---|---|---|
| Historique public seul (gratuit) | 0,007 | −0,89 |
| Historique propre, 40 jours | 0,040 | 1,37 |
| + 1 provider loué | 0,071 à 0,086 | 3,3 à 4,6 |
| + pool de 4 providers | 0,088 | 5,44 |
| Pool + historique fabriqué, non vérifié | 0,038 | 2,06 |
| Pool + historique fabriqué, engagements vérifiés | 0,088 | 5,44 |

## Extraction, toutes attaques confondues

| Attaque | Résultat | Source |
|---|---|---|
| Appartenance, arbres bridés | AUC 0,500 | Location d'expérience |
| Appartenance, arbres libres | AUC 0,663, et le modèle devient mauvais (IC 0,039) | Location d'expérience |
| Copie de la stratégie d'un provider | 82,6 % d'accord, contre 81,1 % sans ses données : **pas de fuite propre** | Location d'expérience |
| Reconstruction du sentiment privé | Corrélation 0,058, identique sans ses données : **aucune fuite** | [[M09 Modèle coopératif multi-agents]] |
| Historique fabriqué après coup | Exclu par la vérification des engagements | Location d'expérience |
| Copieur qui revend les records d'un autre | **Payé autant que l'original** : faille ouverte | [[M09 Modèle coopératif multi-agents]] |
| Profiteur qui enregistre du bruit | Valeur négative, non payé | [[M09 Modèle coopératif multi-agents]] |

**C'est le modèle le plus robuste de la série en confidentialité**, pour une raison structurelle : la cible (le rendement du lendemain) est surtout du bruit. Le modèle ne peut ni mémoriser un record, ni servir à remonter au contexte privé. La seule faille ouverte est économique (le copieur), pas de confidentialité.

## Avis honnête : 8/10

**C'est la meilleure idée testée**, pour quatre raisons :

- **Elle correspond exactement à la thèse de Sirius** : une donnée qui vaut 0 $ aujourd'hui et qui ne peut pas être partagée sans être perdue.
- **Elle s'appuie sur un atout propre à Robinhood Chain** : les résultats sont vérifiables on-chain alors que le contexte reste privé.
- **C'est le seul cas où le modèle livré reste utile chez le borrower** sans flux continu de données du provider, puisque le borrower a ses propres capteurs live. C'est ce qui manque à [[M08 Signaux sur données alternatives]] et à [[M10 Anti-arnaque sur labels privés]].
- **Elle passe tous les tests de confidentialité** avec le profil bridé.

**Ce qui l'empêche d'avoir 10 :**

- **Tout est synthétique**, avec un signal fort que j'ai choisi. Personne n'a vérifié que de vrais agents Virtuals enregistrent un contexte de valeur, ni qu'ils accepteraient de le louer.
- **Le marché doit être amorcé des deux côtés.**
- **Il faut construire une partie importante** : SDK d'enregistrement pour les agents, engagements quotidiens, entraînement multi-providers, détection des doublons et répartition des paiements.

**Prochaine étape utile** : demander à 3 ou 4 équipes d'agents Virtuals sur Robinhood Chain ce qu'elles enregistrent au moment de décider, avant d'écrire une ligne de plus.

## Mise à jour : sur données réelles (note 8 → 6)

Retesté sur Binance (8 perpétuels, 2025, carnet d'ordres et positionnement réels, voir [[Données réelles]]) : **aucun gain mesurable**.

- **À 4 h et à 24 h, tous les scénarios restent dans le bruit** (IC de −0,01 à 0,05, avec une erreur de ±0,03).
- **À 24 h, les 30 derniers jours du borrower font même mieux que l'historique loué** : le marché change de régime, et un vieil historique perd sa valeur.
- **Les tests de confidentialité restent bons** (appartenance à 0,53 en bridé).

**Limites du test** : les variables de contexte sont archivées publiquement par Binance, l'horizon horaire efface le signal du carnet d'ordres, qui vit à la minute, et 4 mois de test ne suffisent pas.

**Nouvelle note : 6/10.** L'idée reste la plus alignée avec la thèse de Sirius, mais elle **n'est pas validée**. Ses résultats synthétiques venaient du signal que j'avais mis dans le générateur. Avant d'y investir, il faut de vraies données d'agent et un horizon adapté.
