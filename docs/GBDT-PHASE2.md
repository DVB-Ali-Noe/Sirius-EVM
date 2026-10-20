# Arbres boostés — phase 2 sur staging/testnet

État du 20 octobre 2026 : **préparation seulement**. Cette PR doc/outillage est destinée à staging en brouillon, sans fusion sans accord de Noé. Aucun contrat, aucune variable distante, aucun volume et aucune CVM ne sont modifiés par cette préparation. Phase 1 fusionnée (#111), outillage de renouvellement fusionné (#116), interrupteur `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` coupé partout.

Objectif : d'abord prolonger le budget de la démonstration avant son échéance, ensuite rendre `gradient_boosted_trees` utilisable de bout en bout sur la CVM staging/démo (app `8e14a57b42bfeff1e3cb806a5a042c313874c79c`), testnet 46630. Jamais `main`, le projet Vercel `sirius-evm` ni la CVM `sirius-mainnet`.

## 1. État lu (lecture seule)

| Élément | Valeur |
|---|---|
| Adresses servies | `phala.sirius-data.tech` et `demo.sirius-data.tech` : KYB `0xc6ef…8c64`, registre `0x99ea…4be5`, escrow v7 `0x5f9d…5f6c` (relevé de Noé) |
| KYB `0xc6ef…8c64` | `SiriusOpenKybRegistry` : pas de `VERSION`, `isKybValid(0x…dEaD)` vrai |
| Registre `0x99ea…4be5` | `sirius-dataset-v4`, admin = `0xb6ac…f919`, escrow lié = `0x5f9d…5f6c`, KYB lié = `0xc6ef…8c64` |
| Escrow `0x5f9d…5f6c` | `sirius-escrow-usdc-v7`, signataire `0x3b31…c8d`, USDC `0x1d6c…0213`, `accounting()` = (0, 0, 0, 0) : aucun fonds verrouillé, aucun crédit dû, aucun événement |
| Titres du registre v4 | 8 mintés, 0 détruits (4 fournisseurs) : 5 `linear_regression`, 3 `logistic_regression` |
| Déployeur `0xb6ac…f919` | 0,007872717 ETH testnet ; gas à 0,01 gwei |
| Budget et tarif du volume démo | `demo-budget-policy.json` et `demo-billing-policy.json` (VPS) : **fin le 2026-10-26 à 14:12 UTC** |
| Inventaire base staging transmis par l'agent principal | 0 prêt ouvert ; prêts uniquement `SETTLED`/`CANCELLED` sur `0x2634…`, `0xede8…`, `0xc51e…` ; 10 jobs `DONE` |
| Datasets actifs en base | 8 sur `0x99ea…` (7 `PRIVATE`, 1 `LISTED`) et 2 sur `0x4075…` (1 `PRIVATE`, 1 `LISTED`) : **10 lignes à suspendre en B10** |
| Reaper staging observé | Escrow `0xc51e…`, registre `0x4075…` : configuration historique v6, différente de Vercel et du runner |
| Financement | Politique actuelle : crédits et plafond 14 USD ; solde Phala relevé : 9,73 USD. Décision : crédits et plafond **9 USD**, quotas 20 / 4 / 1 inchangés |
| Image publiée après #116 | `ghcr.io/dvb-ali-noe/sirius-runner@sha256:a497d9339d8f0d00c28f573931af3cfeec868c16b6c631b6bba84a01025ec0eb` |

Empreintes de profil : linéaire `0xa38a…3190`, logistique `0x0b89…c6cc`, arbres `0xebbb…0a5c` (`keccak256("sirius.training-profile.v1:gradient_boosted_trees:1.0.0")`).

## 2. Échéance du budget

- **2026-10-23 à 14:07 UTC** : dernier devis possible. Un devis réserve son flux jusqu'à `expiresAt + 3 jours` (`reserveWorkflow`, `budget-ledger.ts`), borné par la politique. `check.canQuote` intègre désormais cette marge (3 jours + 300 s) et le rapport expose `quotesUntilMs` et `quoteWindowClosed`. La CVM de démonstration refuse les prêts : cette limite ne bloque pas le self-train.
- **2026-10-26 à 14:12 UTC** : budget et tarif expirent. Le runner refuse alors de démarrer (`src/runner/config.ts`), et `/phala` est hors service.

**Outil de prolongation** (`scripts/renew-runner-budget-policy.ts`, mode `demo-budget` ou `demo-renewal`) :
- Il agit dans le registre réel (`ledger.sqlite`), en une transaction SQLite. Seuls `validUntil` et `sponsored.observedAtMs` changent, et le changement est journalisé dans `sponsored_policy_changes`.
- Il ne touche ni aux compteurs, ni aux réservations, ni aux flux, ni à l'anti-rejeu (volume budget seul monté, sans réseau).
- La demande ne contient que `{"validUntil": …, "observedAtMs": …}`. Tout autre champ est refusé : le financement et les plafonds ne changent que par la commande opérateur existante.
- Refus : échéance raccourcie ou passée, plus de 31 jours après le relevé, relevé antérieur au relevé en vigueur, autre réseau ou autre wallet, financement non sponsorisé.
- Reprise : une coupure avant la validation laisse l'ancienne politique ; après la validation, rejouer la même demande répond « déjà appliquée » sans rien réécrire.
- `observedAtMs` = date du relevé des crédits Phala refait le jour de la session. Le relevé doit couvrir le nouveau plafond de 9 USD ; suivre l'ordre ci-dessous, sans admission sous le plafond historique de 14 USD.
- Le checkpoint SQLite après validation est hors du chemin d'échec : un checkpoint manqué n'annonce pas « rien n'a été modifié » à tort.

Le tarif est ensuite prolongé jusqu'à la même date au plus : l'outil de tarif lit désormais la validité dans le registre réel, pas dans la copie `budget-policy.json` de l'installation. En mode `demo-renewal`, le tarif n'est remplacé qu'après une prolongation réussie (`depends_on: service_completed_successfully`). Rejouer `demo-renewal` (ou redémarrer la CVM dessus) est sans effet : les deux outils répondent « déjà appliqué » et sortent en 0. Le `tariff.sha256` attendu se calcule sur la valeur exacte de `RUNNER_UPDATED_BILLING_POLICY`, sans saut de ligne final (`printf %s`). `canQuote` suppose le délai de contestation standard de 3 jours : un devis à délai plus long serait refusé malgré `canQuote` vrai.

### A. Financement à 9 USD puis ouverture

Ordre de maintenance retenu : préparer le financement à 9 USD, prolonger hors admission, puis appliquer les 9 USD par `configure` avant `open`. Ce n'est pas une baisse du registre avant la prolongation : le registre garde transitoirement 14 USD, **session fermée**, jusqu'à Activer.

1. Avant A4, session fermée et opérations réconciliées, refaire le relevé Phala ; noter son horodatage **T1** et confirmer au moins 9 USD disponibles. Sinon arrêter et soumettre un nouveau plafond à approbation.
2. Préparer le fichier privé désigné par `PHALA_DEMO_FUNDING_FILE` sur le VPS (0600) avec `funding: "credits"`, `creditsUsdMicros: "9000000"`, `cashUsdMicros: "0"`, `ceilingUsdMicros: "9000000"`, `maxOperations: 20`, `maxOperationsPerWallet: 4`, `maxConcurrent: 1`, `observedAtMs: T1` (nombre en millisecondes).
3. Dans A2, fixer `RUNNER_BUDGET_RENEWAL` à `{"validUntil": T1 + 31 jours en millisecondes, "observedAtMs": T1}` (remplacer les expressions par des nombres JSON). Tarif : échéance au plus égale à celle-ci. A4 applique `demo-renewal`, puis `demo-active`, **sans ouvrir la session**.
4. En A5, lire le registre réel via le rapport runner-monitor `/operations/budget` : `check.allocatedUsd + fixedReserveUsdMicros ≤ 9000000` ; avec le plafond historique de 14 USD inchangé, cela équivaut à `check.remainingUsd ≥ 5000000`. Vérifier aussi l'absence d'opérations réservées ; les réconcilier avant `configure`, qui les refuse.
5. En A6, Activer fait exécuter par le contrôleur `configure` depuis le fichier, **puis** `open`. Vérifier le plafond 9 USD et les quotas avant le self-train. Un échec de configuration bloque l'ouverture ; ne pas contourner ce refus.

Le fichier doit porter **le même T1 que la prolongation** (ou un relevé ultérieur réel encore valide). Conserver le relevé de septembre ferait dépasser `validUntil − observedAtMs ≤ 31 jours` et bloquerait Activer. `configureSponsored` vérifie les engagements et cette fenêtre ; la prolongation interdit de reculer le relevé. Les deux ordres avec le même T1 sont couverts par `scripts/renew-runner-budget-policy.test.ts`, ainsi que le fichier périmé, le plafond insuffisant et le rejeu. Baisser effectivement le registre avant de prolonger demanderait un démarrage supplémentaire avec l'ancienne politique encore valide ; cet ordre n'est pas nécessaire sans admission intermédiaire.

### C. Compteur d'opérations

`maxOperations = 20` n'est **pas** un compteur cumulatif depuis septembre : `session-store.ts` compte les opérations de la dernière révision `open`. Chaque nouvelle activation repart avec 20 opérations, dont au plus 4 par wallet et 1 simultanée. Le nombre de self-trains n'est pas nécessairement égal au nombre d'opérations.

Avant l'ouverture, lire `session.usedOperations`, `activeOperations` et `available` via `GET /operations/demo` authentifié à travers le contrôleur ; `/operator` affiche « Opérations de la session ». Le compteur affiché avant une nouvelle ouverture peut encore être celui de la session précédente. Après ouverture, vérifier la nouvelle révision et son compteur. La limite USD, elle, reste cumulative dans le registre : lire `check.allocatedUsd`, `check.remainingUsd`, `check.expired`, `check.quotesUntilMs` et `tariff` via runner-monitor. CVM arrêtée : ne pas présenter ces valeurs comme une lecture actuelle.

## 3. Contrats

**KYB réutilisé.** Le registre ouvert n'a aucun état (toute adresse est valide) : le réutiliser ne fait perdre aucune attestation, garde `SIRIUS_KYB_ADDRESS` et `NEXT_PUBLIC_SIRIUS_KYB_ADDRESS` inchangées et évite un contrat de plus. `deploy.ts` vérifie, avant toute transaction, que l'adresse porte un contrat dans le mode demandé.

**Escrow v7 redéployé.** L'escrow fige l'adresse de son registre, le registre ne lie qu'un escrow une seule fois, et chaque verrouillage vérifie `datasets.escrow() == this` : un registre v5 impose un nouvel escrow. Même code v7, même signataire.

**Gas : dry run B2 confirmé par l'agent principal sur staging `e1b9cfb`**, cohérent avec la lecture RPC du 19 octobre à 16:05 UTC (bloc 138 822 216, registre v4 de référence). Solde déployeur relevé : environ 0,00787 ETH ; à relire avant B3, aucune transaction autorisée par cette estimation.

| Transaction | Gas |
|---|---|
| `SiriusDatasetRegistry` v5 | 933 167 |
| `SiriusEscrowV7` | 2 678 803 |
| `bindEscrow` (majoré) | 60 000 |
| `addTrainingProfile(gradient_boosted_trees)` (majoré) | 60 000 |
| **Total** | **3 731 970**, soit 0,0000373197 ETH à 0,01 gwei |

La simulation précédente estimait l'escrow avec le déployeur comme registre : `InvalidRegistry`, échec systématique. Elle exige désormais `SIRIUS_DEPLOY_ESTIMATE_DATASETS`, un registre déjà déployé dont elle lit `kyb()`. Le test `contracts/test/deploy-estimate.test.ts` vérifie que l'estimation couvre le gas réellement consommé.

**Administrateur du registre.** Immuable, égal à la clé du déployeur sur testnet : il lie l'escrow et peut ajouter des profils, jamais en retirer. Le pré-vol `phala:check-v7` lit `admin()` et signale `datasets.admin_not_deployer` (testnet) ou `datasets.admin_not_governance` (mainnet). **Avant mainnet, l'admin doit être la multisig de gouvernance.** Décision pour l'audit : **pas de désactivation de profil**, car un retrait rendrait inutilisables des titres déjà publiés. Un profil indésirable se coupe dans l'application (interrupteur, tarif).

**`RETIRED_ENCLAVES`** : aucune entrée nécessaire. La liste ne sert qu'aux certificats de prêts réglés ; l'escrow v7 testnet n'a émis aucun événement, donc aucun certificat ne se réclame du Compose `61581af7…`.

## 4. Deux sessions, pas une

Recommandation : **session A (prolongation) seule, avant le 26 octobre ; session B (arbres) ensuite.**

- A est contrainte par une date ; B dépend du déploiement des contrats, de l'inventaire, de la mise en pause des titres, de Vercel et du gel des fusions. Les regrouper ferait dépendre l'échéance de la tâche la plus fragile.
- Un échec de B se rattrape en revenant à l'état de A ; un échec dans une session combinée mêlerait deux causes possibles.
- Coût : ≈ 0,03 USD par session de 30 minutes (0,060780 USD/h relevé le 25 septembre), soit ≈ 0,06 USD pour les deux.
- Combiner reste possible seulement si tous les prérequis de B sont faits avant le 25 octobre. Il faudrait alors valider A (rapport de supervision) avant de continuer, avec arrêt si quelque chose diverge.

## 5. Ordre exact

`Moi` = cet agent (code, docs, lectures, rendus). `Noé` = approbations, ouverture et fermeture de session dans `/operator`. `Agent principal` = l'agent qui a accès à `162.19.66.80` et à la CLI Phala. Décision de Noé (19 octobre) : tout ce qui passe par le VPS ou la CLI Phala (A2, A4, A5, B5–B6, B8, B10, partie commandes de B11) est exécuté par l'agent principal, après l'accord de Noé ; les mentions « Noé » et « Agent VPS » de ces lignes désignent alors l'agent principal pour les commandes.

### Préparation commune

| # | Qui | Action | Contrôle de sortie |
|---|---|---|---|
| 1 | Noé | Outillage #116 déjà fusionné, pipeline 39301902225 verte ; conserver le digest du §1. Cette PR doc/outillage reste draft jusqu'à approbation | Aucun nouveau déploiement requis pour les corrections documentaires |
| 2 | Noé | Plafond 9 USD décidé ; approuver le tarif arbres (= logistique) et l'échéance T1 + 31 jours ; refaire le relevé le jour de la session | Relevé couvrant 9 USD, fichier privé préparé selon §2 A |

### Session A — prolongation (avant le 2026-10-26 14:12 UTC, viser le 24)

| # | Qui | Action | Contrôle de sortie |
|---|---|---|---|
| A1 | Moi | Rendus déjà contrôlés avec le digest du §1 : `demo-active` sans option ne diffère du Compose actif que par l'image ; `--opt-in-models` ajoute l'interrupteur ; `demo-renewal` enchaîne renouvellement sans réseau, tarif (`service_completed_successfully`), puis runner | Préparation seulement, pas un déploiement ; fichiers 0600 |
| A2 | Agent principal | Préparer le financement privé à 9 USD et T1 (§2 A), puis l'environnement chiffré actuel + `RUNNER_BUDGET_RENEWAL` + `RUNNER_UPDATED_BILLING_POLICY` (mêmes profils, arbres si approuvés, nouvelle version, échéance ≤ T1 + 31 jours). Les quatre noms requis ont été confirmés : `EVM_NETWORK`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_USDC_ADDRESS`, `SIRIUS_COMPUTE_RECIPIENT` ; adresses actuelles `0x99ea…` / `0x5f9d…` / `0xc6ef…` | Même T1 dans le fichier et la demande ; SHA-256 du tarif noté |
| A3 | Noé | Gel des fusions vers staging jusqu'à la fin de A4–A6 | Annoncé |
| A4 | Noé | `phala cvms update` avec `demo-renewal`, puis avec `demo-active` et l'environnement sans les deux variables de maintenance | CVM démarrée |
| A5 | Noé/Agent VPS | Attestation : quote `UpToDate`, SHA-256 de `tcb_info.app_compose` lu (pas supposé), image = digest de l'étape 1 ; pins mis à jour (contrôleur, moniteur, `SIRIUS_EXPECTED_COMPOSE_HASH` Vercel staging et instance `/phala`), puis rebuild ; rapport `/operations/budget` : `check.expired` faux, `quotesUntilMs` = nouvelle échéance − 3 j − 300 s, `tariff.sha256` = celui de A2 | Tout concorde |
| A6 | Noé | Après les contrôles de financement de A5 : Activer applique 9 USD puis ouvre ; vérifier plafond et compteurs (§2 A/C), lancer un self-train linéaire court sur `/phala`, puis fermer par le contrôleur | Arrêt confirmé par l'API Phala, coût relevé |
| A7 | Moi | PR de suivi : `DECLARED_RELEASES`, `composes/<hash>.json` depuis `tcb_info.app_compose`, journal | CI verte |
| A8 | Noé | `vercel alias set demo.sirius-data.tech <nouveau déploiement>` ; noter l'ancien déploiement comme cible de retour | Alias vérifié |

### Session B — arbres (après A)

| # | Qui | Action | Contrôle de sortie |
|---|---|---|---|
| B1 | Agent VPS | Inventaire en lecture seule déjà transmis (§6), à rafraîchir avant la bascule sur chaque base concernée | 0 prêt ouvert ; 10 titres actifs, dont 8 sur v4 et 2 sur l'ancien registre |
| B2 | Noé | Simulation : `SIRIUS_DEPLOY_NETWORK=testnet SIRIUS_BILLING_VERSION=7 SIRIUS_KYB_MODE=open SIRIUS_KYB_EXISTING_ADDRESS=0xc6ef861119c097d135c85ff0988014d52cc78c64 SIRIUS_DATASET_TRAINING_PROFILES=gradient_boosted_trees SIRIUS_DEPLOY_ESTIMATE_DATASETS=0x99ea98be5c439809a918115764bcabf089ef4be5 SIRIUS_USDC_ADDRESS=0x1d6c58bb2f60b5a18ee4a72096f7743f01db0213 SIRIUS_USDC_CODE_HASH=0x4f86dc6f206ef3e02a21709f2e8330bf1439c450abe88b6a6cb1af071e6f9965 SIRIUS_LOCK_AUTHORIZER=0x3b31923ee7cb2a15fc85abbeeae1fc32afc08c8d SIRIUS_DEPLOY_DRY_RUN=true pnpm contracts:deploy:testnet` (clé dans l'environnement local, jamais dans le chat ; hash du code USDC relu sur le RPC le 19 octobre) | « Exécution à blanc », ≈ 3,73 M gas |
| B3 | Noé | Même commande sans `SIRIUS_DEPLOY_DRY_RUN` ni `SIRIUS_DEPLOY_ESTIMATE_DATASETS` | Deux adresses, hashes conservés ; pas de relance aveugle après un timeout |
| B4 | Moi | Relecture on-chain : versions, liaisons, `isSupportedTrainingProfile` × 3, `admin()`, `accounting()` = 0 | Rapport dans la PR de suivi |
| B5 | Noé/Agent VPS | `pnpm phala:check-v7` avec les nouvelles adresses et l'interrupteur | `chainChecksPassed: true` |
| B6 | Agent VPS | `pnpm contracts:check-upgrade` dans l'environnement **staging explicite** du VPS (le script charge le `.env` du répertoire courant, jamais depuis le poste de Noé) | « Préflight … validé » |
| B7 | Moi | Rendre `demo-active --opt-in-models=gradient_boosted_trees` (et `demo-billing` si le tarif arbres n'a pas été posé en A) | Fichiers 0600 |
| B8 | Noé | Préparer l'environnement chiffré (nouvelles adresses) et, dans Vercel (staging et instance `/phala`), toutes les variables du §7 sauf `SIRIUS_EXPECTED_COMPOSE_HASH`, sans rebuild. Pour `demo-billing` : vérifier `EVM_NETWORK`, `SIRIUS_USDC_ADDRESS`, `SIRIUS_COMPUTE_RECIPIENT` | Noms vérifiés |
| B9 | Noé | **Gel des fusions vers staging de B8 à la fin de B12** : une fusion relance la pipeline, qui reconstruit Vercel et le reaper avec d'autres variables | Annoncé |
| B10 | Agent VPS | Après accord de Noé : passer en `SUSPENDED` les titres actifs de l'inventaire (§6), y compris ceux de `0x4075…`, **avant** le rebuild Vercel | **10 lignes attendues**, sinon annuler la transaction et réconcilier l'inventaire |
| B11 | Noé | Session Phala (§8) ; reaper basculé (§7) dans la même fenêtre que Next, juste après le rebuild | Mesures et arrêt confirmé |
| B12 | Noé | `vercel alias set demo.sirius-data.tech <nouveau déploiement>` ; cible de retour = déploiement noté en A8 | Alias vérifié |
| B13 | Moi | PR de suivi : `DECLARED_RELEASES`, `composes/<hash>.json`, mesures, journal | CI verte |

## 6. Inventaire staging

Inventaire staging transmis en lecture seule : 0 prêt ouvert ; uniquement `SETTLED`/`CANCELLED` sur `0x2634…`, `0xede8…`, `0xc51e…` ; 10 `TrainingJob` tous `DONE`. Titres actifs : 8 sur `0x99ea…` (7 `PRIVATE`, 1 `LISTED`) et 2 sur `0x4075…` (1 `PRIVATE`, 1 `LISTED`). Ces deux derniers sont déjà inutilisables avec le front actuel ; la requête B10 les inclut volontairement. Rafraîchir ces lectures avant exécution, sur chaque base concernée :

```sql
-- Prêts par état et par escrow : ceux hors SETTLED/CANCELLED bloquent la bascule.
SELECT status, "evmEscrowAddress", count(*) FROM "Loan" GROUP BY 1, 2 ORDER BY 1, 2;
-- Titres à inventorier : registre v4 ET ancien registre, sans exclure les titres historiques.
SELECT id, status, "modelId", "evmDatasetId" FROM "Dataset" WHERE "evmDatasetId" IS NOT NULL ORDER BY "createdAt";
-- Jobs self-train en cours : aucun ne doit l'être pendant une session.
SELECT status, count(*) FROM "TrainingJob" GROUP BY 1;
```

Mise en pause (B10, après accord de Noé), dans une transaction, en vérifiant que le nombre de lignes égale celui de l'inventaire :

```sql
UPDATE "Dataset" SET status = 'SUSPENDED'
WHERE "evmDatasetId" IS NOT NULL AND status IN ('LISTED', 'UNLISTED', 'PRIVATE');
```

Lecture on-chain : l'escrow `0x5f9d…` ne doit rien et n'a jamais émis d'événement ; cela ne prouve pas l'absence de crédits sur les escrows historiques. Conserver ces derniers dans les liaisons de lecture autorisées. Les titres v4 restent valides on-chain mais ne servent plus après la bascule ; ceux de `0x4075…` sont déjà hors du registre configuré. Les modèles livrés restent téléchargeables (capsule en base et IPFS). Les fournisseurs republient sur v5 ; les identifiants ne migrent pas.

## 7. Variables (noms seulement)

| Cible | Mettre à jour | Inchangées |
|---|---|---|
| Vercel staging et instance `/phala` | `SIRIUS_DATASET_ADDRESS`, `NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS`, `NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS`, `SIRIUS_LEGACY_ESCROW_ADDRESSES` (+ ancien escrow), `SIRIUS_BILLING_POLICY_JSON` (avec arbres), `SIRIUS_EXPECTED_COMPOSE_HASH`, `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS=gradient_boosted_trees` | `SIRIUS_KYB_ADDRESS`, `NEXT_PUBLIC_SIRIUS_KYB_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_USDC_ADDRESS`, MRTD, chaîne KMS, empreinte d'ingestion |
| Reaper staging, `/opt/sirius-staging/.env.vps`, en B11 | `SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS` (nouvelles adresses B3), `SIRIUS_LEGACY_ESCROW_ADDRESSES`, `SIRIUS_BILLING_VERSION=7`, `SIRIUS_EXPECTED_COMPOSE_HASH` | Vérifier aussi KYB, USDC, signataire, URL runner et pins ; ne pas supposer l'alignement de cette ancienne configuration v6 |
| Contrôleur (`/etc/sirius/operations/phala-demo-controller.env`) et moniteur (`runner-monitor.env`) | `SIRIUS_EXPECTED_COMPOSE_HASH` (en A et en B) | les autres pins |
| Runner (environnement chiffré Phala) | B : `SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS`, `SIRIUS_LEGACY_ESCROW_ADDRESSES`. Maintenance seulement, puis retirées : `RUNNER_BUDGET_RENEWAL`, `RUNNER_UPDATED_BILLING_POLICY`, `RUNNER_BILLING_ALLOW_PROFILE_CHANGES` (si un prix installé change) | `SIRIUS_KYB_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_USDC_ADDRESS`, `SIRIUS_COMPUTE_RECIPIENT`, secrets |
| GitHub environnement `staging` | Aucune variable GitHub ne bascule les adresses du reaper dans la pipeline actuelle | `SIRIUS_MIGRATION_ESCROW_ADDRESSES` ne sert qu'au préflight d'une ancienne migration, déjà appliquée sur staging |

`NEXT_PUBLIC_*` est figée au build : rebuild obligatoire. Le runner reçoit l'interrupteur **en clair** dans le Compose rendu (`--opt-in-models`), donc couvert par le hash attesté.

### B. Bascule réelle du reaper

La pipeline `.github/workflows/pipeline.yml` ne réécrit dans `.env.vps` que `SIRIUS_WORKER_IMAGE`, copie le Compose puis lance `docker compose`. Modifier des variables d'adresses dans GitHub `staging` **ne modifie donc pas le reaper**.

En B11, dans la fenêtre du rebuild Next et avant toute activation, l'agent principal sauvegarde la configuration privée et modifie `/opt/sirius-staging/.env.vps` avec les noms ci-dessus, puis exécute depuis ce répertoire `docker compose -p sirius-staging --env-file .env.vps up --detach`. `SIRIUS_LEGACY_ESCROW_ADDRESSES` doit conserver les adresses complètes vérifiées de `0xc51e…`, `0x5f9d…`, `0x2634…` et `0xede8…` (les abréviations de ce document ne sont pas des valeurs de configuration), dans Next et le reaper. Contrôler la configuration effective du conteneur et ses journaux de démarrage sans exposer les secrets. Les prochains déploiements conservent ces adresses ; seul un autre mécanisme externe, non établi ici, pourrait les réécrire.

## 8. Tarif arbres et session B

Proposition : profil `gradient_boosted_trees` **identique au profil logistique** de la politique installée, avec une nouvelle `tariffVersion`. Écart de calcul local à 30 000 lignes : 931 ms (pire cas au budget) pour les arbres contre 282 ms pour la logistique, très en dessous des `maxExecutionMs` ; non calibré sur Phala. L'outil refuse toute modification d'un prix déjà installé sans `RUNNER_BILLING_ALLOW_PROFILE_CHANGES=true`, écrit les octets fournis tels quels et publie leur SHA-256 dans `/operations/budget`. Next : même JSON dans `SIRIUS_BILLING_POLICY_JSON`, sur staging **et** sur l'instance `/phala`.

Session B, ≤ 30 min. **Elle teste le self-train (plafond de 15 s), pas le chemin facturé** (devis, verrouillage, règlement), que la démonstration refuse.

| Minute | Action |
|---|---|
| 0 | Noé : relevé solde/coût Phala ; `phala cvms update` avec `demo-active --opt-in-models` et l'environnement chiffré aux nouvelles adresses (précédé de `demo-billing` si le tarif arbres n'a pas été posé en A) |
| ≈ 5 | Noé/Agent VPS : attestation ; SHA-256 de `tcb_info.app_compose` lu ; pins mis à jour (contrôleur, moniteur, Vercel) ; rebuild de l'instance `/phala` et de staging ; reaper basculé ; rapport `/operations/budget` : `tariff.profiles` contient `gradient_boosted_trees`, `check.expired` faux |
| ≈ 12 | Noé : quota restant lu, **wallet neuf** ; `/operator` → Activer. CSV `node scripts/operations/gbdt-benchmark-csv.mjs <fichier>` (30 000 lignes, 23 variables, 2 060 908 octets, sha256 `d25689ca…2c33`), profil arbres, un seul self-train |
| ≈ 18 | Relevés : durée de bout en bout ; métriques livrées **identiques** à la référence (test `gbdt-benchmark-csv.test.mjs`) : `heldOutAuc` 0,8418414855712508, `trainAuc` 0,8470032294457094, `heldOutAccuracy` 0,7786666666666666. Mémoire : non mesurable directement (`public_sysinfo` et `public_logs` désactivés). Preuve retenue : aucun arrêt du worker (128 Mio) ni du conteneur (768 Mio), plus le résultat identique |
| ≤ 30 | Noé : fermeture par le contrôleur (drainage), arrêt confirmé par l'API Phala, coût relevé |

Arrêt immédiat si l'attestation ou le tarif ne correspondent pas, ou si la session dépasse 30 minutes : fermeture normale, puis analyse hors session.

## 9. Retour arrière

- **Image, Compose et adresses vont ensemble.** L'ancienne image `78839668…6eff4` n'accepte que `sirius-dataset-v4` (`src/lib/evm/deployment.ts` au commit `712fbb2`). Revenir à l'image impose donc de revenir aussi aux anciennes adresses : Vercel (staging et instance `/phala`), reaper et environnement chiffré du runner, puis rebuild et `vercel alias set demo.sirius-data.tech <déploiement noté en A8>`.
- **Redéploiement** : `composes/61581af7…950a.json` avec l'ancien environnement chiffré. Le hash doit être **relu** dans `tcb_info.app_compose` de l'attestation, puis les pins remis à cette valeur ; ne pas le supposer.
- **Volume** : la prolongation du budget et le tarif restent lisibles par l'ancienne image (même format de politique ; elle ne valide que linéaire et logistique et ignore un profil en plus). L'ancien tarif reste dans le volume (`billing-policy.previous-*.json`). On ne raccourcit jamais une prolongation : il suffit de ne plus ouvrir de session.
- **Contrats** : les anciens sont immuables et intacts. Les titres v5 passent en `SUSPENDED`. Un prêt ouvert sur le nouvel escrow doit être réglé ou remboursé avant, sinon cet escrow reste dans `SIRIUS_LEGACY_ESCROW_ADDRESSES`.
- **Interrupteur seul** : retirer `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` de Vercel et rebuild, puis rendre `demo-active` sans `--opt-in-models` (nouveau hash, relu à l'attestation). Les datasets arbres publiés restent lisibles mais ne sont plus proposés ni entraînables.
- Ne jamais supprimer un volume ni réinitialiser un registre pour revenir en arrière.
