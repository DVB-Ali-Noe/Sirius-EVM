# Audit : reproductibilité du runner et registre de datasets v5

- **Base auditée** : `origin/staging` = `f31a917bf48a51d8d8505b8a50cde9ed0a353853` (merge #124, 20 oct. 2026 16:27 +0200).
- **Branche** : `audit/reproductibilite`. Aucun code de production modifié, aucune PR, aucun déploiement.
- **Date** : 23 octobre 2026.
- **Environnement** : Windows 11, Node 22.16.0, `pnpm@11.18.0`, Docker Desktop 29.7.2 (buildx 0.36.1), Hardhat 2.29.0.
- **Règles respectées** : aucun `.env` ni `.ops/` lu, aucune transaction sur un vrai réseau, aucun wallet existant (seuls les comptes publics jetables de Hardhat, sur un nœud local), aucune session Phala.

Note d'installation : `npx -y pnpm@11.18.0 install` installe tout, puis le `postinstall` (`prisma generate`) échoue faute de `DATABASE_URL`. Volontaire : aucun `.env` n'a été lu. Les tests de cet audit n'utilisent pas Prisma.

## Résumé

1. **L'image qui tourne dans l'enclave est bien celle que nomme le compose attesté**, et le site le vérifie à chaque connexion (quote Intel, MRTD épinglé, rejeu de l'event log, hash du compose épinglé). Ce lien-là est solide.
2. **Le lien entre cette image et le code relu, lui, n'est vérifiable par personne.** Deux builds sans cache du même commit, sur la même machine, à deux minutes d'écart, donnent deux digests différents (REP-02). Le digest déclaré pour `c408221` ne peut donc pas être recalculé. La page de démonstration le dit déjà honnêtement (« declared, not proven »).
3. **Le build peut devenir reproductible, et l'essai le montre** : avec la base épinglée par digest, `SOURCE_DATE_EPOCH`, `rewrite-timestamp=true` et la suppression de deux fichiers d'état de pnpm, deux builds sans cache de `c408221` donnent **le même digest** (`b8a5eef5…`). Voir A.2.
4. **Registre v5 : sur mainnet, `deploy.ts` donne l'administration immuable du registre à la clé de déploiement, jamais au Safe** (REP-11). Reproduit en exécutant le vrai script contre un nœud Hardhat local qui se présente comme mainnet (chainId 4663). Rien n'est irréversible tant que ce script n'a pas tourné sur mainnet.

| Sévérité | Nombre | Constats |
|---|---|---|
| Critique | 0 | (REP-04 le deviendrait si un serveur SSH tourne dans l'image OS épinglée : NON VÉRIFIÉ) |
| Haute | 4 | REP-02, REP-03, REP-04, REP-11 |
| Moyenne | 4 | REP-01, REP-07, REP-08, REP-12 |
| Basse | 5 | REP-05, REP-06, REP-09, REP-10, REP-13 |

---

## A. Ce qui tourne dans l'enclave est-il le code relu ?

### A.1 Chaîne de confiance, maillon par maillon

| Maillon | Qui le garantit | Vérifié ici |
|---|---|---|
| Matériel TDX authentique, TCB à jour | Quote signée Intel (`quote.ts:136-144`) | Code relu. Pas de quote réelle rejouée (pas de CVM) |
| OS dstack attendu | MRTD épinglé `SIRIUS_EXPECTED_MRTD` (`quote.ts:92`) | Code relu |
| Compose attendu | Événement `compose-hash` unique dans RTMR3, rejoué (`identity.ts:90-121`), puis comparé à `SIRIUS_EXPECTED_COMPOSE_HASH` (`quote.ts:100`) | Code relu, tests existants verts |
| Image du runner | Le compose la nomme par digest (`ghcr.io/…@sha256:…`) ; Docker refuse un contenu d'un autre digest | Les 3 composes publiés : OK (test `release-inputs`) |
| **Image ⇄ commit source** | **Seulement la table `DECLARED_RELEASES` (`attestation.ts:29-42`), une déclaration** | **Non recalculable : REP-02** |
| Commit ⇄ code relu | Historique git | `c408221` est un ancêtre de `staging` ; depuis, seuls `attestation.ts` et un compose publié changent dans le contexte de l'image |

### A.2 Reconstruction de l'image depuis le commit déclaré

Cible : compose `2fdc0919…`, image déclarée `sha256:76fb0001…c914`, commit `c408221` (`attestation.ts:38-41`).

Docker était disponible. Ce qui a été fait :

1. Export du commit `c408221` par `git archive` (aucun checkout, aucun fichier `.env` dedans : seul `.env.example` existe, exclu par `.dockerignore`).
2. **Build « brut »**, deux fois, sans cache, `Dockerfile.runner` tel quel : `docker buildx build --platform linux/amd64 --no-cache --provenance=false --sbom=false -f Dockerfile.runner --output type=oci,dest=…`.
3. **Build « stable »**, deux fois : export en LF, base épinglée par digest, `SOURCE_DATE_EPOCH` = date du commit (1792496611), `rewrite-timestamp=true`.

Résultats :

| Essai | Réglage | Digest du manifeste | Couches différentes (sur 18) | Cause de l'écart |
|---|---|---|---|---|
| a / b | brut (export CRLF du poste) | `5cd130c5…` / `660f2ee2…` | 12 (toutes celles du Dockerfile) | Date du build sur le dossier `/workspace` (seule entrée qui diffère dans les couches `COPY`), sur `/var/lib/sirius-runner`, et sur les 84 991 entrées de `node_modules` |
| c / d | stable : LF, base épinglée, `SOURCE_DATE_EPOCH`, `rewrite-timestamp=true` | `3f3c5727…` / `203cf5f3…` | 1 (`node_modules`) | Seulement deux fichiers d'état de pnpm : `node_modules/.modules.yaml` (`prunedAt`) et `node_modules/.pnpm-workspace-state-v1.json` (`lastValidatedTimestamp`) |
| e / f | stable + suppression de ces deux fichiers après l'installation | `b8a5eef5…` / `b8a5eef5…` | **0** | **Aucune : digest de manifeste identique** (`sha256:b8a5eef51902e95759c4acbb9d77c254cf6038531062b0a77c61a0a55824868f`), deux builds sans cache à 15 minutes d'écart |

Ce que cela montre :

- Le contenu des fichiers est stable : sources, `package.json`, scripts et contenu de `node_modules` sont identiques d'un build à l'autre (comparaison fichier par fichier, script `compare-oci.py` et inspection des couches). Seules les **dates** et deux **fichiers d'état** changent.
- La base `node:22-bookworm-slim` tirée le 23 oct. a été construite à partir d'un instantané Debian daté du 20 oct. 21:32 UTC (`debian.sh … '@1792531975'`). C'est après le merge de `c408221` (20 oct. 11:43 UTC). Le CI a donc très probablement construit `76fb0001…` sur **une autre base** (heure exacte du job CI : NON VÉRIFIÉ). Même un build parfaitement déterministe d'aujourd'hui ne retomberait pas sur `76fb0001…` (REP-01).
- Sur ce poste, `core.autocrlf=true` : un `git archive` ordinaire donne des fichiers CRLF, donc d'autres octets que le CI Linux. Il faut `git -c core.autocrlf=false archive`.

**Comparaison avec le digest déclaré : NON VÉRIFIÉ.** L'image publiée est dans un registre GHCR privé. La tirer demande un jeton du dépôt, que cet audit n'utilise pas. Même avec ce jeton, elle ne serait pas recalculable, pour les raisons de REP-01 et REP-02.

### A.3 « Release prouvée » : ce que ça prouve, et ce que ça ne prouve pas

`resolveCodeRelease` (`attestation.ts:77-91`) renvoie `proven` quand un fichier `composes/<hash>.json` a pour SHA-256 le hash attesté et nomme une image runner épinglée par digest.

**Ce que ça prouve** (à condition que la quote soit vérifiée, ce que fait le transport RA-TLS) :

- Le fichier publié est, octet pour octet, l'`app-compose.json` mesuré au démarrage de la CVM.
- Donc l'image du runner, par son digest, est celle-là, et rien d'autre ne peut tourner sous ce nom.
- Tout ce qui est écrit **en clair** dans ce fichier est aussi prouvé : options de sécurité du conteneur (`read_only`, `cap_drop`, limites), variables en dur (`TEE_MODE=phala`, `SIRIUS_FAST_FINALITY_*`, `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`…), liste `allowed_envs`, `kms_enabled`, `local_key_provider_enabled=false`, `public_logs=false`, et le `pre_launch_script` complet (17 569 caractères, identique dans les trois composes).

**Ce que ça ne prouve pas** :

1. **Que l'image vienne du commit affiché.** Le commit vient de la table, et l'image n'est pas reconstructible (REP-02). L'interface le dit (`AttestationView.tsx:240`).
2. **Les valeurs de l'environnement chiffré** : RPC, adresses des contrats, origine de l'application, signataire de lock, profondeur de confirmation, passerelle IPFS (REP-03). L'exploitant peut les changer sans changer le hash.
3. **Le contenu de `/dstack/user_config`**, que le script de pré-lancement lit pour installer des clés SSH root (REP-04).
4. **L'heure de la CVM** : `secure_time=false` (REP-05).
5. **Le comportement de l'OS dstack et de la KMS** : couverts par le MRTD et par l'empreinte de chaîne KMS épinglée, pas par le compose.
6. **Que le site épingle bien ce compose-là.** `SIRIUS_EXPECTED_COMPOSE_HASH` vit dans l'environnement du site (Vercel), hors de cet audit.

### A.4 `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` : site et runner en désaccord

- **Côté site**, Next.js 16.3.8 remplace `process.env.NEXT_PUBLIC_*` par sa valeur **au moment de `next build`**, y compris dans le code serveur (doc `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:164-166`). `isModelOffered` (`registry.ts:99`), `MODEL_OPTIONS` (`registry.ts:104`), la publication (`create-request.ts:82`), le catalogue et les contrôles de déploiement (`deployment.ts:20-21`) voient donc la valeur figée au build.
- **Côté runner**, l'image tourne depuis les sources via `tsx`, sans build Next. La valeur est lue **à l'exécution**, depuis le compose actif (`render-phala-v7.mjs:68`). Elle est contrôlée à `seal-dataset`, `prepare-escrow-lock`, `run-loan-job` et `run-training` (`handler.ts:126`, `:131-134`, `:204`, `:239`, `:269`, `:475`).
- **Rien ne compare les deux valeurs.** `requireCurrentEvmDeployment` vérifie seulement que le registre on-chain accepte les profils proposés par le site.

Ce que voit l'utilisateur :

| Site (build) | Runner (compose) | Effet visible |
|---|---|---|
| arbres ON | arbres OFF | Le formulaire propose « Binary gradient-boosted trees ». La publication échoue au scellement avec « Modèle ou version non autorisé » (400), avant tout mint. Un achat d'un titre arbres déjà publié échoue à `prepare-escrow-lock`, avant paiement. Pas de perte, mais une erreur incompréhensible. |
| arbres OFF | arbres ON | Le profil disparaît du formulaire, du filtre du catalogue et de l'outil agent (`tools.ts:371`). Les titres arbres existants restent lisibles. L'achat reste possible si l'interface le permet : NON VÉRIFIÉ écran par écran. |
| ON → **OFF pendant un prêt** (retour arrière du compose) | | Un prêt déjà payé sous l'ancien compose est refusé à `run-loan-job` (400) : **l'argent reste bloqué jusqu'à l'échéance** (`challengeDays`), puis `refund` (REP-07). |

### A.5 Un changement d'image garde-t-il valides les anciens certificats ?

- Chaque nouvelle image donne un nouveau compose, donc un nouveau hash. Le site n'épingle que le compose courant. Un certificat antérieur n'est montré « verified » que si son compose figure dans `RETIRED_ENCLAVES` avec le bon `chainId`, et seulement pour un prêt réglé avant `retiredAt` (`retired-enclaves.ts:26-38`, `presentation.ts:205-211`). Sinon il retombe en « Enclave execution not fully confirmed » (« incomplete »), jamais en « failed ».
- Aujourd'hui, la liste a **une seule entrée** : le compose de lancement mainnet `ef605469…`, retiré le 8 oct. Les composes de démonstration testnet `61581af7…` et `0c3f6f87…` n'y sont pas. `docs/GBDT-PHASE2.md:57` justifie l'absence de `61581af7` (aucun événement d'escrow v7). Pour `0c3f6f87` (actif le 20 oct. entre `fdeb29f` et `c408221`) : NON VÉRIFIÉ qu'aucun prêt n'a été réglé dessus.
- **Si l'OS dstack change (nouveau MRTD), la liste ne sert à rien** : une entrée ne couvre que le compose. Il faut `baseImageMatches === true` contre le MRTD épinglé aujourd'hui (REP-08).
- Bon point : une entrée ne vaut ni pour le règlement ni pour le runner. Elle ne sert qu'à l'affichage du certificat.

---

## B. Registre de datasets v5 (`SiriusDatasetRegistry`, `sirius-dataset-v5`)

### B.1 Relecture ligne par ligne

| Point | Lignes | Constat |
|---|---|---|
| Contrôle d'accès `bindEscrow` | `:135-141` | Admin seul, une seule fois, refuse une adresse sans code. **Ne vérifie pas que l'escrow pointe vers ce registre** (REP-12). |
| Contrôle d'accès `addTrainingProfile` | `:152-156` | Admin seul, refuse le profil nul, idempotent (pas d'événement en double). Aucun retrait possible : choix assumé (`docs/GBDT-PHASE2.md:55`). |
| `admin` | `:74`, `:126-133` | `immutable`. Refuse l'adresse nulle, accepte une simple clé (EOA). Aucun transfert, aucune renonciation (test REP-B5/B6). Pas d'événement à l'installation : seul `admin()` le dit. |
| `kyb` | `:73` | `immutable`, refuse l'adresse nulle. |
| `mint` | `:180-207` | KYB valide exigé dans la même transaction. Identifiant dérivé de `msg.sender`, donc pas de préemption. Taille ≤ 16 MiB. Profil accepté exigé. |
| `destroy` | `:220-235` | Fournisseur seul, sans KYB (voulu, pour pouvoir effacer). Refusé s'il reste des prêts actifs, **mais seulement si un escrow est lié** (REP-B4). Avant la liaison, aucun prêt n'est possible : l'escrow v7 exige `datasets.escrow() == this` (`SiriusEscrowV7.sol:185`). Pas de faille donc, mais à garder en tête. |
| Événements | `:89-101` | `DatasetMinted`, `DatasetDestroyed`, `EscrowBound`, `TrainingProfileAdded`. Aucun champ libre, ce qui respecte la contrainte RGPD. |
| Lectures | `:241-280` | `isLiveForProviderAndProfile` et `matchesScope` ignorent l'acceptation du profil : un titre reste utilisable même si son profil devenait « non accepté » (impossible aujourd'hui, faute de retrait). |
| Arithmétique | `:202-204`, `:230-232` | `unchecked` sûr : l'incrément ne peut pas déborder en pratique, et le décrément suit toujours un titre vivant du même fournisseur. |

Tests Hardhat existants : **87 passants** (`cd contracts && npx hardhat test`), dont `dataset.test.ts` et `escrow-v7.test.ts`.

### B.2 Le script de déploiement garantit-il admin = Safe sur mainnet ?

**Non. Il garantit l'inverse.** `deploy.ts:262` déploie toujours `SiriusDatasetRegistry` avec `[kyb, account.address]`, c'est-à-dire la clé de déploiement. `deploy-policy.ts:96` n'exige un contrat (Safe) que pour l'admin **KYB**. Le pré-vol `phala-v7-preflight.ts:136-141` signale `datasets.admin_not_governance`, mais seulement **après** le déploiement, quand l'admin est déjà gravé. `docs/GBDT-PHASE2.md:55` écrit pourtant « Avant mainnet, l'admin doit être la multisig de gouvernance ». Rien ne l'impose, et le script ne peut pas le faire en l'état : `bindEscrow` exige l'admin, donc un registre gouverné par le Safe ferait échouer le script à la liaison. Reproduit : REP-11.

**Si un mauvais profil est ajouté** (faute de frappe, ou profil ajouté trop tôt) : il est accepté au mint **pour toujours**, sans retrait possible (test REP-B7). Conséquences :

- un hash erroné ne sera jamais produit par l'application (`trainingProfileHash`), donc aucun titre légitime ne l'utilise. Il ne reste qu'une entrée morte, visible on-chain ;
- un vrai profil ajouté trop tôt (par exemple `gradient_boosted_trees:1.0.0` avant que l'image sache l'entraîner) permet de publier des titres que le runner refuse ensuite. La seule coupure est hors chaîne : interrupteur du runner, tarif, interface ;
- un défaut découvert dans `gbdt 1.0.0` impose une version `1.0.1` (nouveau hash) et la coupure hors chaîne de `1.0.0` ;
- `deploy-policy.ts:103-107` limite les ajouts du script aux profils facultatifs connus, ce qui empêche la faute de frappe par ce chemin. Un appel direct par l'admin (clé ou Safe) n'a pas ce garde-fou.

**Plan v5 sans action irréversible non voulue** (proposé, rien exécuté) :

1. Ne pas lancer `deploy.ts` sur mainnet tant que REP-11 n'est pas corrigé.
2. Correction minimale, sans toucher au contrat : un paramètre `SIRIUS_DATASET_ADMIN` exigé sur mainnet, contrôlé comme contrat (Safe) et distinct du déployeur. Le script déploie le registre avec cet admin, puis l'escrow, **et s'arrête**. Il affiche le calldata de `bindEscrow(escrow)` et des `addTrainingProfile`, que le Safe signe ensuite. Entre-temps, aucun prêt n'est possible (l'escrow exige la liaison), donc la fenêtre est sans risque (REP-B4).
3. Avant que le Safe signe `bindEscrow`, vérifier on-chain que `escrow.datasets() == registre` et que `escrow.VERSION()` est attendue (REP-12).
4. Simuler d'abord le tout sur un nœud local qui annonce le chainId 4663 (test `deploy-mainnet-admin.test.ts`), puis en exécution à blanc sur le vrai RPC (`SIRIUS_DEPLOY_DRY_RUN=true`, lecture seule).

### B.3 Ce qu'un audit externe devra regarder en priorité

1. **SiriusEscrowV7** en entier : comptabilité `lockedUsdc`/`owedUsdc`, `recordExecution` (frais retenus bornés par `maxFailureFee`), `release`/`refund`/échéances, réentrance (`nonReentrant` maison), signatures EIP-712 de `lockAuthorizer` (rejeu, TTL `MAX_AUTHORIZATION_TTL`, domaine), compatibilité avec l'USDG (proxy ERC-1967 que Paxos peut mettre à niveau : pause, gel, frais éventuels).
2. **Couplage registre ⇄ escrow** : liaison unique, `activeLoansForDataset` comme verrou de `destroy`, et migration d'escrow, qui impose un nouveau registre et la republication de tous les titres (REP-12).
3. **Gouvernance** : qui détient l'admin du registre et l'admin KYB, comment on récupère une clé perdue (impossible pour le registre), signataires du Safe.
4. **Chaîne d'identité TEE** : `identity.ts` (rejeu RTMR3, unicité de l'événement `compose-hash`, cas « aucun `boot-mr-done` » à `identity.ts:121`), `ra-tls-client.ts` (liaison certificat ⇄ quote, cache de 5 min), épinglage MRTD et chaîne KMS.
5. **Entrées non attestées du runner** (REP-03) et **accès root par `user_config`** (REP-04) : présence de `sshd` dans l'image OS dstack correspondant au MRTD épinglé.
6. **Chaîne de build** : actions GitHub par tags mutables (`pipeline.yml:190-216`), base Docker flottante, attestations de provenance BuildKit, reproductibilité (REP-01, REP-02).
7. **KYB v3** (`SiriusKybRegistry`) : époques des vérificateurs, révocation, parrainage.

---

## Constats

### REP-01 | Moyenne | `Dockerfile.runner:1`, `Dockerfile.runner:16`

**Ce qui se passe.** Les deux étapes partent de `node:22-bookworm-slim`, un tag qui bouge à chaque correctif Debian ou Node. Le CI n'enregistre pas le digest de base utilisé. On ne peut donc plus savoir sur quelle base l'image `76fb0001…` a été construite. Déjà noté dans `docs/AUDIT-2026-10-01.md:111`, toujours ouvert.

**Reproduire.**
```
grep -n '^FROM' Dockerfile.runner
docker buildx imagetools inspect node:22-bookworm-slim   # le digest change dans le temps
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts   # test « REP-01 attendu » en TODO
```

**Correction proposée.** Épingler l'index multi-architecture lu le 23 oct. 2026, et le faire évoluer par Dependabot/Renovate (mise à jour de digest) :
```diff
-FROM node:22-bookworm-slim AS dependencies
+FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS dependencies
 …
-FROM node:22-bookworm-slim AS runner
+FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runner
```
Ce digest n'est **pas** celui qu'a utilisé le CI pour `c408221` (inconnu). L'épingler change donc l'image : nouveau compose, nouvelle capture RA-TLS, entrée `RETIRED_ENCLAVES` si des prêts ont été réglés sur l'ancien.

### REP-02 | Haute | `.github/workflows/pipeline.yml:215-224`, `Dockerfile.runner:12-14`, `Dockerfile.runner:22-35`

**Ce qui se passe.** Le build n'est pas déterministe. Personne, membre du dépôt compris, ne peut recalculer le digest déclaré à partir du commit :

- horodatages réels dans chaque couche (y compris le dossier parent `/workspace`), aucune `SOURCE_DATE_EPOCH` ;
- `docker/build-push-action@v6` pousse par défaut une attestation de provenance BuildKit (horodatée), ce qui change le digest publié ;
- `pnpm install` dans l'image : contenu figé par le lockfile, mais pas les dates des fichiers ;
- base flottante (REP-01) et actions GitHub par tags mutables ;
- sous Windows avec `core.autocrlf=true` (cas de ce poste), un export ordinaire produit des fins de ligne CRLF, donc d'autres octets que le CI Linux.

**Reproduire.**
```
bash audit/reproductibilite/build-runner-twice.sh c408221 <dossier-temporaire> brut
bash audit/reproductibilite/build-runner-twice.sh c408221 <dossier-temporaire> stable
```
Résultats au paragraphe A.2.

**Correction proposée.** Dans `Dockerfile.runner:14`, ajouter `&& rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json` après `pnpm install`. Ces fichiers sont l'état interne de pnpm, et aucun Compose de `deploy/phala/` n'appelle pnpm. Démarrage du runner sur l'image ainsi modifiée : NON VÉRIFIÉ. Dans le CI : `provenance: false`, ou une provenance publiée à part, signée (cosign / attestation GitHub), sans entrer dans le digest déployé. Plus `SOURCE_DATE_EPOCH: ${{ commit timestamp }}` en `env`, `outputs: type=registry,rewrite-timestamp=true`, base épinglée (REP-01), actions épinglées par SHA. Publier pour chaque release le digest **et** la commande de rebuild, avec un job qui reconstruit deux fois et compare.

### REP-03 | Haute | `src/lib/phala-demo/composes/*.json` (`allowed_envs`, service `runner.environment`), `scripts/render-phala-v7.mjs:39`, `:67`

**Ce qui se passe.** Le hash attesté couvre `EVM_RPC_URL=${EVM_RPC_URL}`, pas sa valeur. Même chose pour `SIRIUS_ESCROW_ADDRESS`, `SIRIUS_DATASET_ADDRESS`, `SIRIUS_KYB_ADDRESS`, `SIRIUS_USDC_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `SIRIUS_EVM_CONFIRMATIONS`, `SIRIUS_APP_ORIGIN` (démonstration) et `PINATA_GATEWAY`. L'exploitant peut les changer par l'environnement chiffré sans changer le hash. Le site vérifie ses propres adresses et que le compte de règlement du runner est le `lockAuthorizer` de **son** escrow (`src/lib/runner/deployment.ts:13-33`). Rien n'atteste quelle chaîne, quel RPC ni quels contrats le runner lit pour accepter un paiement ou vérifier un titre. Un exploitant qui contrôle l'environnement chiffré pourrait faire lire au runner une chaîne fabriquée. Scénario d'exploitation complet : NON VÉRIFIÉ (non tenté).

**Reproduire.**
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts   # « REP-03 constat »
```

**Correction proposée.** Écrire en clair dans le compose actif (donc dans le hash) le chainId, les adresses des contrats et la profondeur de confirmation, comme c'est déjà fait pour `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`. Les retirer d'`allowed_envs`. Pour le RPC : exiger le chainId et le hash d'un bloc finalisé de référence en dur, ou interroger deux fournisseurs indépendants. Exposer ces valeurs dans `/ra-tls` pour que le site les compare.

### REP-04 | Haute (Critique si un `sshd` tourne dans l'OS épinglé : NON VÉRIFIÉ) | `composes/*.json`, `pre_launch_script` (lignes 333-358 du script)

**Ce qui se passe.** Le script de pré-lancement Phala (v0.0.20), attesté, ajoute à `/home/root/.ssh/authorized_keys` les clés `ssh_authorized_keys` lues dans `/dstack/user_config`. Ce fichier n'est pas couvert par le hash du compose. Bon point : `DSTACK_ROOT_PASSWORD`, `DSTACK_ROOT_PUBLIC_KEY` et `DSTACK_AUTHORIZED_KEYS` ne sont pas dans `allowed_envs`, donc l'environnement chiffré ne peut pas les injecter. Si l'image OS dstack correspondant au MRTD épinglé lance un serveur SSH, un détenteur de `user_config` (l'exploitant de la CVM) aurait un accès root, donc aux données déchiffrées. Présence de `sshd` : NON VÉRIFIÉ (il faudrait l'image OS ou une CVM, hors périmètre).

**Reproduire.**
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts   # « REP-04 constat »
python -I -c "import json;s=json.load(open('src/lib/phala-demo/composes/2fdc091929e9080f3dba0730404858fe0fb9aa7e26c60c61c97d58b887b323d3.json','rb'))['pre_launch_script'];print('\n'.join(s.splitlines()[330:358]))"
```

**Correction proposée.** Confirmer que l'image OS épinglée est une image de production dstack sans `sshd`, et le documenter avec le MRTD. Sinon, rendre un compose avec un `pre_launch_script` propre, qui n'installe aucune clé (il fait partie du hash, donc c'est vérifiable).

### REP-05 | Basse | `composes/*.json` (`"secure_time": false`)

**Ce qui se passe.** L'heure de la CVM vient de l'hôte. Les délais on-chain utilisent `block.timestamp`, pas cette horloge. Les fenêtres locales du runner (budget de démonstration, sessions, expiration du tarif) dépendent en revanche de l'horloge de l'enclave. Impact exact : NON VÉRIFIÉ.

**Reproduire.** Test « REP-04 constat » (assertion `secure_time === false`).

**Correction proposée.** Évaluer `secure_time: true` (nouveau compose), ou borner chaque fenêtre locale par l'heure du dernier bloc finalisé.

### REP-06 | Basse | `src/lib/phala-demo/attestation.ts:32`, `:36`, `:40`

**Ce qui se passe.** Les commits déclarés sont des SHA abrégés à 7 caractères (`712fbb2`, `fdeb29f`, `c408221`). Ils sont uniques aujourd'hui, mais un SHA abrégé peut devenir ambigu, et il se lit mal comme preuve.

**Reproduire.** Test « REP-06 attendu » (TODO) de `release-inputs.test.ts`.

**Correction proposée.** Stocker le SHA complet (40 caractères) et n'afficher que la forme courte.

### REP-07 | Moyenne | `src/lib/models/registry.ts:99-104`, `src/runner/handler.ts:126`, `:131-134`, `:268-269`, `src/lib/evm/deployment.ts:20-21`

**Ce qui se passe.** Voir A.4. Le site fige l'interrupteur au build, le runner le lit à l'exécution, et rien ne les compare. Cas le plus coûteux : un retour arrière du compose (procédure « Interrupteur seul », `docs/GBDT-PHASE2.md:166`) pendant qu'un prêt arbres est payé mais pas encore entraîné. `run-loan-job` refuse alors le prêt (400), et l'acheteur attend l'échéance pour le `refund`. La procédure ne dit pas de vider d'abord les prêts en cours.

**Reproduire.**
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts   # deux tests « REP-07 constat »
```

**Correction proposée.** (a) Exposer la liste des profils actifs dans `/ra-tls` (elle est déjà dans le hash) et faire refuser au site un profil que le runner n'offre pas, avec un message clair. (b) À `run-loan-job`, ne pas revérifier l'interrupteur pour un prêt déjà verrouillé (le profil a été contrôlé à `prepare-escrow-lock`), ou émettre un reçu `finalFailure` pour rembourser tout de suite. (c) Ajouter à `docs/GBDT-PHASE2.md:166` : « attendre qu'aucun prêt arbres ne soit verrouillé ».

### REP-08 | Moyenne | `src/lib/certificate/retired-enclaves.ts:10-15`, `:17-24`, `src/lib/certificate/presentation.ts:205-211`

**Ce qui se passe.** Une entrée retirée ne porte que `chainId`, `composeHash` et `retiredAt`, pas de MRTD. Une mise à niveau de l'OS dstack (nouveau MRTD) déclasse donc tous les certificats antérieurs en « not fully confirmed », sans recours. La liste est tenue à la main, et ne compte qu'une entrée mainnet. Aucune entrée testnet, pas même pour `0c3f6f87…`, compose de démonstration remplacé le 20 oct. (prêts réglés dessus : NON VÉRIFIÉ). L'oubli d'une entrée ne produit jamais un faux « verified » : le défaut va dans le sens sûr.

**Reproduire.**
```
NODE_OPTIONS="--conditions=react-server" node --import tsx --test src/lib/certificate/presentation.test.ts   # cas « ancienne enclave : ne couvre ni une autre image… », baseImageMatches=false
```

**Correction proposée.** Ajouter `mrTd` à `RetiredEnclave` et comparer le MRTD de la quote à celui de l'entrée (et non au MRTD courant). Ajouter au runbook de mise à niveau une étape « inventaire des prêts réglés sur l'ancien compose → entrée `RETIRED_ENCLAVES` ».

### REP-09 | Basse | `src/components/phala-demo/AttestationView.tsx:86`, `:187`

**Ce qui se passe.** « checkable by repository members » laisse entendre qu'un membre du dépôt peut vérifier le lien image ⇄ commit. Il ne peut que lire le tag et le journal du CI, pas recalculer le digest (REP-02). Le reste de la page est juste (« declared, not proven », ligne 240).

**Reproduire.** `grep -n "checkable by repository members" src/components/phala-demo/AttestationView.tsx`

**Correction proposée.** « Recorded by the build pipeline (private repository); not independently reproducible yet. »

### REP-10 | Basse | `src/lib/models/registry.ts:243`

**Ce qui se passe.** `import { keccak256, stringToBytes, type Hex } from "viem";` est en dernière ligne du fichier, après le code qui l'utilise (`registry.ts:122-124`). Valide en ESM (les imports sont remontés), mais trompeur à la relecture.

**Reproduire.** `tail -n 1 src/lib/models/registry.ts`

**Correction proposée.** Remonter l'import en tête du fichier.

### REP-11 | Haute | `contracts/scripts/deploy.ts:259-262`, `scripts/deploy-policy.ts:89-96`, `scripts/phala-v7-preflight.ts:136-141`

**Ce qui se passe.** Voir B.2. Sur mainnet (chainId 4663, `SIRIUS_ALLOW_MAINNET=true`, v7, KYB strict, rôles distincts, Safe vérifié comme contrat), le script se termine **avec succès** : le KYB est gouverné par le Safe, mais `SiriusDatasetRegistry.admin()` vaut la clé de déploiement. C'est immuable (`SiriusDatasetRegistry.sol:74`). Une clé décrite par le script lui-même comme une clé qui « finit souvent partagée » (`deploy.ts:111-114`) garde à vie le droit d'ajouter des profils. Le seul recours est de redéployer registre et escrow, puis de republier tous les titres.

**Reproduire** (nœud Hardhat local, chainId 4663, comptes jetables, USDG et Safe simulés par `hardhat_setCode`, aucune transaction réelle) :
```
pnpm contracts:compile
node --import tsx --test audit/reproductibilite/deploy-mainnet-admin.test.ts
```
Résultat obtenu : test vert, `admin()` du registre = `0xf39f…2266` (déployeur), `admin()` du KYB = Safe simulé `0x…5afe`.

**Correction proposée.** Voir le plan en B.2 : `SIRIUS_DATASET_ADMIN` obligatoire sur mainnet, contrôlé comme contrat et distinct du déployeur ; liaison et profils signés ensuite par le Safe ; refus du script si l'admin du registre n'est pas un contrat. Garder ce test et inverser son assertion une fois la correction faite.

### REP-12 | Moyenne | `contracts/src/SiriusDatasetRegistry.sol:135-141`, `:226`

**Ce qui se passe.** `bindEscrow` accepte n'importe quel contrat qui a du code, une seule fois, sans vérifier `escrow.datasets() == address(this)`. Un mauvais contrat lié rend `destroy()` impossible pour toujours (revert à l'appel de `activeLoansForDataset`), donc plus d'effacement on-chain, et bloque tout verrouillage sur le bon escrow (`DatasetEscrowMismatch`). Aujourd'hui `deploy.ts` lie le bon escrow puis vérifie la liaison (`deploy.ts:263-272`, `:363-370`). Mais avec la correction de REP-11, la liaison passe par une signature manuelle du Safe, et le risque augmente. Corollaire : un registre ne sert qu'un escrow, donc toute migration d'escrow impose un nouveau registre (déjà écrit dans `docs/GBDT-PHASE2.md:41`).

**Reproduire.**
```
cd contracts && npx hardhat test test/audit-registry-v5.test.ts   # REP-B2 et REP-B3
```

**Correction proposée.** Pour un futur registre v6 : dans `bindEscrow`, exiger `ISiriusEscrow(escrow_).datasets() == address(this)`. En attendant (v5 inchangé) : contrôle hors chaîne obligatoire avant la signature du Safe (B.2, étape 3).

### REP-13 | Basse | `contracts/src/SiriusDatasetRegistry.sol:152-162`

**Ce qui se passe.** Un profil ajouté ne peut jamais être retiré (choix documenté). Un hash erroné reste accepté au mint pour toujours (test REP-B7). Le seul garde-fou est hors chaîne : `deploy-policy.ts:103-107` pour le script, et le runner qui refuse un profil inconnu. Aucun événement n'annonce l'admin à la construction (`:126-133`).

**Reproduire.** `cd contracts && npx hardhat test test/audit-registry-v5.test.ts` (REP-B5, REP-B7).

**Correction proposée.** Pas de changement on-chain pour la v5. Faire passer tout ajout par un outil qui recalcule le hash avec `trainingProfileHash` et refuse un identifiant hors `MODEL_REGISTRY`, y compris pour une transaction Safe préparée à la main. Dans une future version : `event AdminSet(address)` au constructeur.

---

## Tests ajoutés

| Fichier | Contenu | Commande |
|---|---|---|
| `contracts/test/audit-registry-v5.test.ts` | 7 tests Hardhat (REP-B1 à B7) : accès et unicité de `bindEscrow`, mauvais escrow ⇒ `destroy` bloqué, registre lié à un seul escrow, `destroy` avant liaison, admin sans transfert, admin EOA accepté, profil erroné permanent | `cd contracts && npx hardhat test test/audit-registry-v5.test.ts` |
| `audit/reproductibilite/deploy-mainnet-admin.test.ts` + `hardhat.mainnet-sim.config.js` | Lance le vrai `deploy.ts` contre un nœud Hardhat local (chainId 4663) et lit `admin()` | `pnpm contracts:compile && node --import tsx --test audit/reproductibilite/deploy-mainnet-admin.test.ts` |
| `audit/reproductibilite/release-inputs.test.ts` | Composes prouvés, entrées non attestées, clés SSH par `user_config`, interrupteur des profils, `COPY src`, plus 2 tests « attendus » en TODO (base épinglée, SHA complets) | `NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts` |
| `audit/reproductibilite/build-runner-twice.sh` + `compare-oci.py` | Double build sans cache d'un commit, modes `brut` et `stable`, comparaison couche par couche | `bash audit/reproductibilite/build-runner-twice.sh c408221 <dossier> brut\|stable` |

## Résultats

- Hardhat, suite existante : **87 passants**, 0 échec.
- Hardhat, `audit-registry-v5.test.ts` : **7 passants**.
- `deploy-mainnet-admin.test.ts` : **1 passant**. Le script termine en succès et l'admin du registre est le déployeur (REP-11 confirmé).
- `release-inputs.test.ts` : **6 passants, 2 TODO** (attendus REP-01 et REP-06, qui échouent comme prévu).
- Tests existants liés (`attestation`, `render-phala-v7`, `retired-enclaves`, `presentation`, `deploy-policy`, `phala-v7-preflight`, `train-gbdt`) : **57 passants**.
- Builds Docker (A.2) : brut, 2 digests différents ; stable, 1 couche différente ; stable avec suppression de l'état pnpm, **digest identique** `b8a5eef5…`.

## Points NON VÉRIFIÉS

1. Égalité entre une image reconstruite et le digest déclaré `76fb0001…` (registre privé, pas de jeton utilisé ; build non reproductible de toute façon).
2. Digest de la base `node:22-bookworm-slim` réellement utilisé par le CI pour `c408221`.
3. Présence d'un serveur SSH dans l'image OS dstack du MRTD épinglé (REP-04).
4. Valeurs réelles de l'environnement chiffré de la CVM et des variables Vercel (`SIRIUS_EXPECTED_COMPOSE_HASH`, `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` au dernier build) : non lues, par règle.
5. Prêts réglés sous le compose `0c3f6f87…` (besoin éventuel d'une entrée `RETIRED_ENCLAVES` testnet).
6. Comportement écran par écran du site quand l'interrupteur est coupé côté site mais actif côté runner.
7. Exploitation de bout en bout de REP-03 (runner pointé vers un RPC fabriqué) : non tentée.
8. Version de registre réellement déployée sur mainnet et son `admin()` : aucune lecture on-chain faite.
