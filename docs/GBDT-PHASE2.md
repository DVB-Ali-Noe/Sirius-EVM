# Arbres boostés — phase 2 sur staging/testnet

État du 19 octobre 2026 : **préparation seulement**. Ce document ne vaut ni déploiement ni autorisation de dépense. Aucun contrat, aucune variable Vercel, aucun volume et aucune CVM n'ont été modifiés. Le code de la phase 1 est fusionné (#111), interrupteur `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` coupé partout.

Objectif : rendre `gradient_boosted_trees` utilisable de bout en bout sur la CVM staging/démo (`sirius-phala-production`, app `8e14a57b42bfeff1e3cb806a5a042c313874c79c`), testnet 46630. Jamais `main`, le projet Vercel `sirius-evm` ni la CVM `sirius-mainnet`.

## 1. État lu le 19 octobre (lecture seule)

| Élément | Valeur |
|---|---|
| KYB `0xc6ef…8c64` | `SiriusOpenKybRegistry` : pas de `VERSION`, `isKybValid(0x…dEaD)` vrai |
| Registre `0x99ea…4be5` | `sirius-dataset-v4`, admin = `0xb6ac…f919`, escrow lié = `0x5f9d…5f6c`, KYB lié = `0xc6ef…8c64` |
| Escrow `0x5f9d…5f6c` | `sirius-escrow-usdc-v7`, signataire `0x3b31…c8d`, USDC `0x1d6c…0213`, `accounting()` = (0, 0, 0, 0) : aucun fonds verrouillé, aucun crédit dû, aucun événement émis |
| Titres du registre v4 | 8 mintés, 0 détruits (4 fournisseurs) : 5 `linear_regression`, 3 `logistic_regression` |
| Déployeur `0xb6ac…f919` | 0,007872717 ETH testnet ; prix du gas 0,01 gwei |
| Signataire Phala `0x3b31…c8d` | 0,01 ETH testnet |

Empreintes de profil : linéaire `0xa38a…3190`, logistique `0x0b89…c6cc`, arbres `0xebbb…0a5c` (`keccak256("sirius.training-profile.v1:gradient_boosted_trees:1.0.0")`).

## 2. Contrats

**KYB réutilisé.** Le registre ouvert n'a aucun état (toute adresse est valide) : le réutiliser ne fait perdre aucune attestation, garde `SIRIUS_KYB_ADDRESS` et `NEXT_PUBLIC_SIRIUS_KYB_ADDRESS` inchangées partout et évite un contrat de plus à vérifier. `deploy.ts` vérifie avant toute transaction que l'adresse porte un contrat dans le mode demandé.

**Escrow v7 redéployé.** L'escrow fige l'adresse de son registre, le registre ne lie qu'un escrow une seule fois, et chaque verrouillage vérifie `datasets.escrow() == this` : un registre v5 impose un nouvel escrow. Même code v7, même signataire.

**Gas estimé** (`eth_estimateGas` du 19 octobre, liaison et ajout mesurés sur Hardhat) :

| Transaction | Gas |
|---|---|
| `SiriusDatasetRegistry` v5 | 933 167 |
| `SiriusEscrowV7` | 2 678 803 |
| `bindEscrow` | ≈ 48 000 |
| `addTrainingProfile(arbres)` | ≈ 46 000 |
| **Total** | **≈ 3,71 M**, soit ≈ 0,000037 ETH à 0,01 gwei |

La simulation (`SIRIUS_DEPLOY_DRY_RUN=true`) relit ces estimations sur le RPC et refuse si le solde couvre moins de trois fois le total.

**Administrateur du registre.** Immuable, égal à la clé du déployeur sur testnet : il lie l'escrow et peut ajouter des profils, jamais en retirer. Le pré-vol `phala:check-v7` lit `admin()` et signale `datasets.admin_not_deployer` (testnet) ou `datasets.admin_not_governance` (mainnet). **Avant mainnet, l'admin doit être la multisig de gouvernance** : `deploy.ts` devra alors recevoir un admin distinct et la gouvernance signera `bindEscrow` et les ajouts. Décision pour l'audit : **pas de désactivation de profil**, car un retrait rendrait inutilisables des titres déjà publiés. Un profil indésirable se coupe dans l'application (interrupteur, tarif), pas sur la chaîne.

## 3. Ordre exact

`Moi` = cet agent (préparation, code, docs, lectures). `Noé` = signatures, Vercel, Phala. `Agent VPS` = l'agent qui a accès à `162.19.66.80`.

| # | Qui | Action | Contrôle de sortie |
|---|---|---|---|
| 1 | Noé | Relire puis fusionner la PR de préparation dans staging ; la pipeline publie une nouvelle image runner | Pipeline verte ; relever le digest `sirius-runner@sha256:…` dans le job Images |
| 2 | Agent VPS | Exécuter les requêtes d'inventaire (§4) sur la base de chaque instance branchée sur ces contrats | Prêts ouverts = 0 ; liste des datasets à retirer |
| 3 | Noé | `SIRIUS_DEPLOY_NETWORK=testnet SIRIUS_BILLING_VERSION=7 SIRIUS_KYB_MODE=open SIRIUS_KYB_EXISTING_ADDRESS=0xc6ef861119c097d135c85ff0988014d52cc78c64 SIRIUS_DATASET_TRAINING_PROFILES=gradient_boosted_trees SIRIUS_USDC_ADDRESS=0x1d6c58bb2f60b5a18ee4a72096f7743f01db0213 SIRIUS_USDC_CODE_HASH=0x4f86dc6f206ef3e02a21709f2e8330bf1439c450abe88b6a6cb1af071e6f9965 SIRIUS_LOCK_AUTHORIZER=0x3b31923ee7cb2a15fc85abbeeae1fc32afc08c8d SIRIUS_DEPLOY_DRY_RUN=true pnpm contracts:deploy:testnet` (clé dans l'environnement local, jamais dans le chat) | « Exécution à blanc », gas et solde affichés |
| 4 | Noé | Même commande **sans** `SIRIUS_DEPLOY_DRY_RUN` | Deux adresses, hashes conservés, profil arbres accepté ; pas de relance aveugle en cas de timeout |
| 5 | Moi | Relire on-chain : versions, liaisons, `isSupportedTrainingProfile` × 3, `admin()`, `accounting()` = 0 | Rapport dans la PR de suivi |
| 6 | Noé/Agent VPS | `pnpm phala:check-v7` avec les nouvelles adresses et `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS=gradient_boosted_trees` | `chainChecksPassed: true`, `datasetAdmin` = déployeur |
| 7 | Agent VPS | `pnpm contracts:check-upgrade` dans l'environnement **staging explicite** du VPS (le script charge `.env` du répertoire courant : jamais depuis le poste de Noé) | « Préflight … validé » |
| 8 | Moi | Rendre `demo-billing` et `demo-active --opt-in-models=gradient_boosted_trees` avec le digest de l'étape 1 | Deux fichiers 0600, aucune valeur interpolée |
| 9 | Noé | Préparer les fichiers d'environnement chiffrés (§5), sans les copier dans le chat ni Git ; préparer dans Vercel (staging et instance `/phala`) toutes les variables du §5 **sauf** `SIRIUS_EXPECTED_COMPOSE_HASH`, sans rebuild | Noms vérifiés par `ops:check-release` |
| 10 | Noé | Session Phala (§7) : le hash Compose n'est connu qu'après l'attestation ; un seul rebuild Vercel pendant la session | Mesures et arrêt confirmé |
| 11 | Noé | Rebuild de staging si elle n'a pas été reconstruite pendant la session | Arbres proposés seulement après le rebuild |
| 12 | Agent VPS | Mettre à jour les variables du reaper staging, du contrôleur et du moniteur, puis redémarrer le reaper | Reaper sain ; aucune commande CVM automatique |
| 13 | Moi | PR de suivi : `DECLARED_RELEASES`, `composes/<hash>.json`, journal, mesures | CI verte |

## 4. Inventaire staging (requêtes en lecture seule)

Aucun accès base n'existe dans les fichiers locaux (`.env.staging-db` est vide). À exécuter par l'agent VPS, en lecture seule, sur chaque base branchée sur `0x5f9d…5f6c` (staging et instance `/phala` si elle a sa propre base) :

```sql
-- Prêts par état et par escrow : ceux hors SETTLED/CANCELLED bloquent la bascule.
SELECT status, "evmEscrowAddress", count(*) FROM "Loan" GROUP BY 1, 2 ORDER BY 1, 2;
-- Titres à retirer puis republier (tous sur le registre v4 actuel).
SELECT status, "modelId", count(*) FROM "Dataset" WHERE "evmDatasetId" IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
-- Jobs self-train en cours (aucun ne doit l'être pendant la session).
SELECT status, count(*) FROM "TrainingJob" GROUP BY 1;
```

Lecture on-chain du 19 octobre : l'escrow v7 n'a jamais émis d'événement et ne doit rien, donc aucun crédit historique à retirer ni prêt à régler sur la chaîne. Les 8 titres v4 restent valides sur l'ancien registre, mais ne sont plus utilisables après la bascule : publication, emprunt et self-train lisent le registre configuré. Les modèles déjà livrés restent téléchargeables (capsule en base et IPFS).

Retrait des titres (mutation, par Noé après accord, dans la fenêtre de bascule) : passer en `SUSPENDED` les datasets `LISTED`, `UNLISTED` et `PRIVATE` qui ont un `evmDatasetId`, puis les fournisseurs les republient (nouveau titre v5). Les identifiants de l'ancien registre ne migrent pas.

## 5. Variables (noms seulement)

| Cible | Mettre à jour | Inchangées |
|---|---|---|
| Vercel staging et instance `/phala` | `SIRIUS_DATASET_ADDRESS`, `NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS`, `NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS`, `SIRIUS_LEGACY_ESCROW_ADDRESSES` (+ ancien escrow), `SIRIUS_BILLING_POLICY_JSON` (avec le profil arbres), `SIRIUS_EXPECTED_COMPOSE_HASH`, `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS=gradient_boosted_trees` (en dernier) | `SIRIUS_KYB_ADDRESS`, `NEXT_PUBLIC_SIRIUS_KYB_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_USDC_ADDRESS`, MRTD, chaîne KMS, empreinte d'ingestion |
| Reaper staging (VPS) | `SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS`, `SIRIUS_LEGACY_ESCROW_ADDRESSES`, `SIRIUS_EXPECTED_COMPOSE_HASH` | idem |
| Contrôleur (`/etc/sirius/operations/phala-demo-controller.env`) et moniteur (`runner-monitor.env`) | `SIRIUS_EXPECTED_COMPOSE_HASH` | les autres pins |
| Runner (environnement chiffré Phala) | `SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS`, `SIRIUS_LEGACY_ESCROW_ADDRESSES` ; `RUNNER_UPDATED_BILLING_POLICY` uniquement pour le Compose `demo-billing`, puis retirée | `SIRIUS_KYB_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_USDC_ADDRESS`, `SIRIUS_COMPUTE_RECIPIENT`, secrets |
| GitHub environnement `staging` | `SIRIUS_MIGRATION_ESCROW_ADDRESSES` si la pipeline la porte (ancien + nouvel escrow) | — |

`NEXT_PUBLIC_*` est figée au build : rebuild obligatoire. Le runner la reçoit **en clair** dans le Compose rendu (`--opt-in-models`), donc couverte par le hash attesté.

## 6. Tarif arbres

Proposition : profil `gradient_boosted_trees` **identique au profil logistique** de la politique installée (même `computeAmount`, `maxFailureFee`, `executionRateAtomicPerMs`, `maxExecutionMs`), nouvelle `tariffVersion`, même chaîne, jeton, précision et trésorerie. Justification : à 30 000 lignes, le calcul mesuré dans le worker est le même (0,8 s contre 0,8 s). `deploy/operations/tariff-proposal.json` porte le profil (non calibré), et `ops:tariffs` produit le même format.

- **Runner** : Compose `demo-billing` (service ponctuel `update-billing-policy`, sans réseau, volume budget seul). Il refuse un autre réseau, jeton ou trésorerie, un profil retiré, la même version ou une validité au-delà de la politique budgétaire, et conserve l'ancien fichier. Vérification sans journaux publics : champ `tariff` du rapport `/operations/budget` (version et profils, sans montants).
- **Next** : `SIRIUS_BILLING_POLICY_JSON` = le même JSON, sur staging **et** sur l'instance `/phala` (en v7, sinon `/api/datasets` refuse les arbres).
- **Échéance à vérifier avant tout** : la politique budgétaire sponsorisée vaut au plus 31 jours après son relevé (fin septembre). Si elle expire, le runner refuse les opérations, et le tarif ne peut pas lui survivre. Lire `check.expired` dans le rapport de supervision ; une politique budgétaire expirée demande une maintenance comptable distincte, hors de cette phase.

## 7. Session Phala (≤ 30 min, plafond 0,30 USD)

Tarif lu le 25 septembre : 0,060780 USD/h (compute et disque), soit ≈ 0,03 USD pour 30 min. Noé ouvre et ferme. Tout est prêt avant : contrats déployés, image publiée, Compose rendus, environnements chiffrés préparés, CSV de mesure généré.

| Minute | Action |
|---|---|
| 0 | Noé : relevé solde/coût Phala ; `phala cvms update` avec `demo-billing` et l'environnement chiffré (nouvelles adresses + `RUNNER_UPDATED_BILLING_POLICY`). La mise à jour démarre la machine. |
| ≈ 5 | Noé : `phala cvms update` avec `demo-active` (`--opt-in-models`) et l'environnement sans `RUNNER_UPDATED_BILLING_POLICY` |
| ≈ 10 | Noé/Agent VPS : `phala cvms attestation --json` → quote `UpToDate`, MRTD, RTMR3, SHA-256 de `tcb_info.app_compose` = hash attendu, image = digest de l'étape 1, signataire `0x3b31…c8d`. Pins mis à jour (contrôleur, moniteur, Vercel `SIRIUS_EXPECTED_COMPOSE_HASH`), puis rebuild de l'instance `/phala` (≈ 3 à 5 min). Rapport `/operations/budget` : `tariff.profiles` contient `gradient_boosted_trees`, `check.expired` faux. |
| ≈ 15 | Noé : `/operator` → Activer (le contrôleur vérifie les nouveaux pins et ouvre la session ; la machine tourne déjà). Puis, depuis l'instance `/phala` rebuildée : CSV `node scripts/operations/gbdt-benchmark-csv.mjs <fichier>` (30 000 lignes, 23 variables, 2 060 908 octets, sha256 `d25689ca…2c33`), profil arbres, un seul self-train. |
| ≈ 20 | Relevés : durée de bout en bout (chiffrement, IPFS et réseau compris) ; métriques livrées, qui **doivent être identiques** à la référence locale (`heldOutAuc` 0,841841, `trainAuc` 0,847003, `heldOutAccuracy` 0,778667) ; aucun 503 ni interruption du worker. Mémoire : non mesurable directement (`public_sysinfo` et `public_logs` désactivés) ; preuve indirecte = aucun arrêt du worker (128 Mio) ni du conteneur (768 Mio). |
| ≤ 30 | Noé : fermeture par le contrôleur (drainage), puis arrêt confirmé par l'API Phala ; relevé du coût après. |

Arrêt immédiat si l'attestation ne correspond pas, si le tarif n'apparaît pas ou si la session dépasse 30 minutes : fermeture normale, puis analyse hors session.

## 8. Retour arrière

- **Image et Compose** : redéployer exactement `composes/61581af7…950a.json` (image `78839668…6eff4`) avec l'ancien environnement chiffré ; repasser les pins à `61581af7…950a`. Le tarif mis à jour reste lisible par l'ancienne image (elle ignore un profil en plus) ; l'ancien fichier est dans le volume (`billing-policy.previous-*.json`). Le registre budgétaire n'est pas touché.
- **Contrats** : les anciens sont immuables et intacts. Remettre les anciennes adresses (Vercel, reaper, runner) et retirer l'interrupteur, puis rebuild. Les titres mintés sur le registre v5 deviennent inutilisables : les passer en `SUSPENDED`. Un prêt ouvert sur le nouvel escrow doit être réglé ou remboursé avant, ou cet escrow reste dans `SIRIUS_LEGACY_ESCROW_ADDRESSES`.
- **Interrupteur seul** : retirer `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` de Vercel et rebuild, et rendre `demo-active` sans `--opt-in-models` (nouveau hash). Les datasets arbres déjà publiés restent lisibles mais ne sont plus proposés ni entraînables.
- Ne jamais supprimer un volume ni réinitialiser un registre pour revenir en arrière.
