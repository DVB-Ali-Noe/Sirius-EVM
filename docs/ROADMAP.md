# Roadmap

Reconstruction propre du POC `PBW26/Sirius2.0`, mainnet-ready, TEE-first. Pas de deadline dure → incréments propres et testables. Dev technique solo (Noé), business (Ali).

## Validation actuelle — 14 août 2026
- [x] Next.js `16.2.11`, lockfile figé et Prisma Client généré
- [x] 17 migrations Prisma, jusqu'à la persistance de `cancelTxHash`
- [x] Anciens datasets `LISTED`/`UNLISTED` suspendus : recréation et rescellement obligatoires pour émettre un reçu liant prix + délai
- [x] Tests automatisés et TypeScript valides
- [x] ESLint sans erreur ni avertissement
- [x] Audit statique de sécurité : aucune vulnérabilité exploitable démontrée ; sessions, CSRF, grants anti-rejeu, ownership API, chiffrement, runner RA-TLS, escrows XRPL et dépendances vérifiés (`pnpm audit --prod` sans alerte)
- [x] Configuration Docker Compose validée
- [x] Smoke test runtime Docker Next→runner authentifié
- [x] 5 scénarios Playwright locaux isolés : dashboard, lifecycle dataset, catalogue, réconciliation escrow et registre d'audit
- [ ] Parcours réel complet avec deux wallets XRPL testnet et Pinata

## MVP — incréments

### Inc. 0 — Scaffold ✅
- [x] Repo `~/VSCode/XRPL-PROJECTS/MakesWave/Sirius` + structure
- [x] Next.js 16.2.11 + Tailwind 4 + Prisma 7 + ESLint/TS
- [x] Schéma Prisma : `Dataset`, `Loan`, `KeyGrant`, `Credential`, `Reputation` (+ migration `init`)
- [x] Client XRPL **testnet/mainnet** (singleton + retry, `server-wallets` seed-based)
- [x] **Wallet multi-wallet** (xrpl-connect : Crossmark/GemWallet/Otsu/Xyra/Ledger + Xaman/WalletConnect si clé) + disconnect + garde-fou réseau
- [x] Briques POC assainies : `crypto` (AES-256-GCM + Merkle, testés), composants UI de base, **Blob 3D**. L'ancien `key-store` volatile a été abandonné au profit des DEK wrappées et reçus runner
- [x] `.env.example` propre

> Mint MPT / Credentials / Domains : déplacés vers inc.1 (avec le pipeline provider).

### Inc. 1 — Pipeline provider ✅
- [x] Upload → AES-256 → IPFS (Pinata) → Merkle (`lib/sirius/pipeline`, `lib/ipfs/pinata`), ensuite durci en 3d-B.3 : chiffrement navigateur pour la clé d'ingestion du runner, Next ne reçoit plus le CSV en clair
- [x] Métriques publiques limitées aux volumes globaux (lignes/colonnes ; parser CSV RFC4180, `lib/sirius/metrics`) ; aucune ligne brute, statistique par colonne ni schéma n'est stocké par Next
- [x] Mint MPT + Credentials KYB + Permissioned Domain (`lib/xrpl/{mpt,credentials,domains}`). Publication MPT idempotente via état `LISTING`, blob signé et réconciliation exacte par hash/`LastLedgerSequence`. Mint/destroy MPT et `CredentialAccept` signés côté client ; aucune seed provider/borrower dans l'app. **KYB bloquant** avant mint.
- [x] Persistance Prisma (zéro `globalThis Map`). Migration `drop_credential_role`.
- [x] UI provider (`app/provider`) + routes API (`/api/datasets`, `/list`, `/provider/onboard`)
- [x] Audit sécu + durcissement (limite upload, masquage erreurs, bornes métriques/MPT, domain separation Merkle, salt HKDF)

> ✅ **Auth des routes (C-1 audit)** fermée en **inc.3b.2** (challenge signé → session HMAC) + ownership en **3b.3a**. Voir `DECISIONS.md` D-15.

### Inc. 2 — Marketplace + escrow ✅
- [x] Listing datasets : volumes globaux publics uniquement, sans aperçu, statistique par colonne ni schéma, avec réputation dérivée des résolutions XRPL
- [x] KYB borrower (réutilise `lib/xrpl/credentials`, gating bloquant)
- [x] **TokenEscrow** conditionnel : `EscrowCreate` + crypto-condition PREIMAGE-SHA-256 + `CancelAfter` (`lib/xrpl/escrow`, condition maintenant dérivée dans `lib/tee/core`). **XRP d'abord**, RLUSD ensuite (D-16).
- [x] lib `five-bells-condition` — condition dérivée déterministe de la master key, fulfillment = stub TEE (D-17)
- [x] UI marketplace + borrower (`/marketplace`, `/borrow`) + routes `/api/loans`, `/api/borrower/onboard`
- [x] Audit sécu + durcissement : prix et délai définis par le provider, liés au reçu runner puis contrôlés contre l'`EscrowCreate`; réservation atomique dataset/loan contre le crypto-shredding concurrent
- [x] **Validé end-to-end sur testnet** : onboard → upload → mint → emprunt → escrow ESCROWED

> Accès gaté et fair-exchange atomique (capsule pré-persistée puis déverrouillée par `EscrowFinish`) = inc.3.

### Inc. 3a — TEE stub + boucle fair-exchange ✅
- [x] Interface `lib/tee/` **swappable** (stub → Phala) + sélection par `TEE_MODE`
- [x] Job d'entraînement déterministe (régression linéaire, `lib/tee/train`)
- [x] Déchiffrement « en enclave » (stub) → modèle chiffré pour le borrower → IPFS
- [x] Attestation (HMAC dérivé, stub du verifier) + vérification
- [x] **Règlement atomique révisé en 3d-B.3** : capsule ECDH+fulfillment persistée avant paiement → `EscrowFinish` soumis par le runner → provider payé et capsule ouverte par la même transaction + audit best-effort (`lib/sirius/settle`)
- [x] Routes `/api/loans/:id/{run,key}` + UI borrow ; durcissement post-audit (atomicité, mutex TRAINING, cap colonnes, re-livraison clé)
- [x] **Validé end-to-end testnet** : run → release → modèle déchiffré par le borrower

> ⚠️ Stub (mode dev) : clé de déchiffrement + fulfillment + attestation dérivent de `SIRIUS_MASTER_KEY` serveur (D-13/D-17). En **mode phala**, la master key et le fulfillment sont scellés au runner dstack et une quote TDX est produite. L'identité complète 3d.2b est implémentée ; restent la capture et la validation de ses mesures sur une vraie CVM pendant B.5.

### Inc. 3b — Onboarding & wallet embarqué non-custodial ✅
- [x] **3b.1 — Wallet embarqué Web3Auth** (`@web3auth/modal` v11, singleton impératif, login Google, MPC, `keyExportEnabled:false` → signature in-provider) + proxy RPC same-origin + 3 patches SDK XRPL — connecteur additionnel à xrpl-connect (D-20/D-22)
- [x] **3b.2 — Auth des routes API** : challenge signé → session cookie HMAC ; toutes les routes mutantes gardées → **ferme C-1 / D-15**
- [x] **3b.3a — Contrôles de propriété** : `assertOwner` (borrower/provider) sur loans/datasets, `GET /loans` filtré par participant, `GET /datasets` en whitelist (fuites clé modèle & DRAFT/SUSPENDED fermées, audit)
- [x] **3b.3b — Signature client de l'`EscrowCreate`** : flux 2 phases (prepare autofill → signature wallet borrower → vérification du blob champ par champ + submit). Retire `getServerWallet("borrower")` du flux escrow → vrai non-custodial borrower. Audit : contrôle `CancelAfter`, transition réconciliable `PENDING→SUBMITTING→ESCROWED` avec blob/hash/`LastLedgerSequence` persistés, plafond anti-spam et blocage self-borrow
- [x] **3b.4 — On-ramp MoonPay** : URL widget « Buy » signée HMAC-SHA256 côté serveur (secret jamais exposée), liée au wallet authentifié, achat XRP direct → auto-activation ; bouton « Ajouter des fonds » dans la dropdown wallet. RLUSD reporté
- [x] **3b.5 — Landing + shell app + espaces + tour** (cadrage D-23 ; révise D-19) — **frontend/UX** (+ backend self-train, cf. étape 3) :
  1. [x] **Shell `(app)`** — route group + Sidebar + **Blob en mode logo** (haut-gauche, **animé** — révise D-23 « statique » : rendu partagé mono-canvas piloté par `useBlobStore.mode`, skin fine + grain, cf. `Blob.tsx`) ; migration de `/provider`,`/marketplace`,`/borrow` dedans
  2. [x] **`/dashboard`** — solde (balance XRPL) + raccourcis vers les espaces (post-login = ici, **pas de page dispatch**)
  3. [x] **Flux `/train`** — « choisir un dataset » (**mes datasets en haut** = self-train, puis **catalogue**) → config job + escrow → suivi & récup modèle (= ex-`/borrow`). **Backend self-train construit** (hors périmètre frontend initial) : modèle `TrainingJob`, `POST/GET /api/train`, `/api/train/[id]/key`, `runSelfTrain` (MLaaS sur sa propre data, **sans escrow**), `trainAndEncrypt` extrait du stub (DRY)
  4. [x] **`/datasets` + `/datasets/new`** — ex-`/provider`, langage « data = actif »
  5. [x] **`/wallet`** — solde + **Ajouter** (onramp 3b.4) + **Envoyer/Retirer** (Payment signé = sortie de secours non-custodial, D-20)
  6. [x] **Toggle contextuel Simple/Avancé** — `ModeToggle` + store `ui` (persist, `skipHydration`), défaut Simple ; **pas** de tier de compte
  7. [x] **Favoris ⭐** — store `favorites` (persist, `skipHydration`) sur cartes catalogue
  8. [x] **Landing scroll-Blob** — GSAP/Lenis, hero pinné (zoom caméra piloté au scroll) + section **About us** (cartes équipe) + footer, copy réécrit (sans Vault/ZK/watermark), Geist gardé, `prefers-reduced-motion` géré
  9. [x] **Product tour** 1re visite — overlay maison, déclenché si adresse inconnue **on-chain** (option B), flag « vu » localStorage
- [x] **Récupération multi-facteurs** Web3Auth (device / PIN / MFA ; cible non-crypto = Google + PIN + recovery) — `mfaLevel: "optional"` au login (écran proposé, skippable) + `enableMFA`/`manageMFA` derrière un bandeau nudge (shell app) et une carte « Sécurité » (`/wallet`) ; état `mfaEnabled` porté par le store. Mitige le seul vecteur de perte de fonds (cf. D-20)

### Inc. 3c — Lifecycle des datasets ✅
- [x] **Refacto clé par dataset** — DEK **aléatoire** par dataset (remplace la dérivation déterministe `deriveKey(master, id)`, D-13/D-17), chiffrée sous KEK master (`wrapDatasetKey`/`unwrapDatasetKey`) et stockée en DB (`Dataset.wrappedKey`, destructible). Le blob IPFS ne change pas de format ; `retrieveDataset` unwrappe (erreur explicite si clé absente). Modèle/escrow/auth/attestation restent sur la master key. Round-trip + isolation validés. → prépare le scellement TEE (3d)
- [x] Suppression = **crypto-shredding** — `DELETE /api/datasets/[id]` → `shredDataset` bloque tout emprunt réservé/en cours (`PENDING`→`SETTLING`). Un reaper autonome expire les réservations, réconcilie les soumissions/règlements et fait annuler les escrows expirés par le runner ; `CANCELLED` n'est écrit qu'après preuve XRPL du remboursement. Une fois le dataset libre : **effacement garanti de `wrappedKey`** + `status=DELETED` + `keyDestroyedAt`, unpin best-effort et `MPTokenIssuanceDestroy` signé côté client, retentable. Soft-delete (ligne gardée = audit)
- [x] **Visibilité Public/Semi-privé/Privé** (`LISTED`/`UNLISTED`/`PRIVATE`, réversible) — `PATCH /api/datasets/[id]` → `setDatasetVisibility` ; catalogue = `LISTED` seul, `GET /datasets/[id]` expose Public+Semi-privé (Semi-privé = par lien), Privé/Draft/Suspendu → owner. Empruntable = Public+Semi-privé (`BORROWABLE_STATUSES`, prepare/finalize alignés). UI provider `/datasets` : sélecteur segmenté + bouton Supprimer (branche `DELETE`). Backend validé ; UI à voir en dev (D-21)

### Inc. 3d — Phala dstack réel 🚧
- [x] **3d.1 — Master key scellée à l'enclave** (`src/lib/tee/dstack.ts`) : `DstackClient.getKey('sirius/master/v1')` dérive la clé **dans** la CVM, déterministe pour l'`app_id`, avec livraison KMS autorisée par l'identité mesurée de l'application. `getMasterKey` devient **amorçable** (`primeMasterKey`) : env en dev, clé enclave en mode phala (refus explicite si non amorcée, pas de fallback silencieux). Amorçage au boot du runner → **toute** dérivation en découle (modèle, condition escrow, reçus HMAC, wrap DEK 3c.1). `PhalaTeeRunner` et le stub partagent le cœur DB-free `runLoanJob`. Testé bout-en-bout contre un faux guest-agent (`DSTACK_SIMULATOR_ENDPOINT`). Override pnpm `@noble/hashes@1.8.0` pour le SDK. → **ferme le trou master-key D-13/D-17**
- [x] **3d.2 — Attestation TDX vérifiable** : `PhalaTeeRunner` produit une quote via `getEnclaveQuote(payloadHash)` (report_data = hash métier), attachée au résultat et persistée (`Loan.attestationQuote`). En production distante, Next vérifie binding, signature Intel/TCB et mesure épinglée **avant** d'accepter la capsule et d'autoriser le règlement ; le HMAC reste la parité du stub local. Exposé `GET /api/loans/[id]/attestation`. Validé sur vraie fixture TDX (`UpToDate`). Reste deploy : produire une quote depuis une **vraie CVM**
- [x] **3d.2b — Identité du code complète (code)** : replay de l'event-log RTMR3, liaison stricte de l'événement `compose-hash`, épinglage `mrTd`/`RTMR3`/`compose_hash`, empreinte épinglée de la `signature_chain` KMS et persistance de la preuve sur `Loan`. Les valeurs réelles restent à capturer et valider pendant B.5 sur une vraie CVM
- [x] **3d.3 — Scellement du fulfillment** (escrow) → **subsumé par 3d.1** : le fulfillment dérive de `deriveKey(getMasterKey(), 'escrow:'+borrower+':'+loanId)`, or `getMasterKey()` est scellé enclave en mode phala → fulfillment dérivé DANS l'enclave, isolé par wallet, régénéré in-enclave au release, jamais stocké. Les **2 trous non-custodial (clé data + fulfillment) sont fermés à la source** par le scellement de la master key. Aucun code séparé requis
- **3d-B — Runner de compute isolé** (reco Phala : compose_hash minimal/stable, TCB réduit, DB hors CVM ; D-25). Le runner devient le seul détenteur de la master key enclave ; le Next l'appelle avec des inputs explicites et n'importe plus jamais la clé.
  - [x] **B.1 — Contrat + cœur DB-free** (`tee/contract.ts` + `tee/core.ts`) : `sealDataset`/`runTraining`/`runLoanJob`/`deliveryKey`/`escrowCondition` en fonctions pures (inputs explicites, zéro requête DB). `TeeRunner.run(LoanJobInput)` ; DB fetch remonté dans les orchestrateurs Next (settle/self-train). `compute.ts`+`condition.ts` supprimés (migrés). Le coupling historique `core→attestation→provider→db` a ensuite été supprimé en B.2.
  - [x] **B.2 — Service runner HTTP** (`src/runner/{server,handler}.ts`) : capability vérifiée avant lecture du body, `Content-Length` obligatoire, plafonds différenciés, timeouts, limites de connexions/requêtes et anti-rejeu persistant. Le fulfillment reste dans le runner jusqu'à l'`EscrowFinish`
  - [x] **B.3 — Rewire + autorisation intrinsèque + fair-exchange atomique** : appels HTTP au runner, session-HMAC sur `SIRIUS_SESSION_SECRET`, grants wallet P-256 de 60 s, reçus enclave et preuves XRPL. Le hash canonique de la capsule relue depuis IndexedDB est inclus dans le grant de règlement et comparé au reçu runner avant `EscrowFinish`
  - [x] **B.4 — Parité dev durcie** : images Next/runner séparées, runner immuable sans code ni `node_modules` partagés, secrets projetés par allowlist, filesystems read-only, port limité à `127.0.0.1`, volume SQLite dédié, limites CPU/RAM/PID, healthchecks et smoke authentifié
  - [ ] **B.5 — Déploiement et validation CVM Phala** : **outillage code-complete** — `Dockerfile.runner`, manifeste Phala, capture des mesures et RA-TLS direct CVM (TLS 1.3, clé/certificat dstack, quote liée au certificat, vérification DCAP+RTMR3 puis épinglage côté Next des mesures, de la `signature_chain` KMS et de la clé d'ingestion). Restent la construction/publication de l'image immuable et la validation réelle : passthrough Phala, persistance de la clé à travers redémarrages (`app_id` stable), capture/épinglage des valeurs réelles, puis smoke RA-TLS sur vraie CVM. Topologie retenue : une CVM CPU stable, démarrée/arrêtée manuellement pendant les tests, sans création/suppression par job (D-27)
- [x] **Output-gate** (D-18) — `src/lib/tee/output-gate.ts` : quantif des poids (6 chiffres significatifs → écrase la stéga LSB), **sérialisation canonique** (ordre de champs fixe, pas de canal annexe), **taille de sortie bornée** (256 Ko, reject) ; appelé par `src/lib/tee/core.ts` avant chiffrement. + rate-limit temporel (`prepareLoan` : 3 runs/h par borrower+dataset) = friction anti-accumulation. DP-SGD + budget ε global restent en roadmap
- [x] **Seuil anti-inversion** — entraînement refusé sous 100 lignes ou 10 lignes par paramètre, afin d'empêcher la reconstruction triviale des petits jeux de données depuis les coefficients
- [x] **Budget anti-DoS compute** — CSV borné à 20 000 lignes/64 colonnes, régression à 31 features et 20 M d'opérations estimées, timeout coopératif de 15 s et un seul job runner simultané
- [x] **Durcissement admission/récupération** — rate-limits séparés par wallet/IP derrière ingress fiable, démarrage production bloqué sans limites distribuées déclarées, cache des vérifications DCAP, CAS des résultats TEE avec unpin compensatoire, réconciliation XRPL synchrone bornée, capsule invalide rendue à `TRAINING`, Web3Auth aligné sur le réseau XRPL, brouillons incomplets expirables/supprimables et upload Pinata compensé en cas d'échec DB

### Inc. 4 — Confiance & finitions
- [x] **Signatures client pré-production** : MPT mint/destroy signés par le wallet provider ; chaque `CredentialAccept` signé par son sujet provider/borrower ; aucun wallet serveur utilisateur dans les routes (D-13)
- [x] Tests Playwright du contrat UI/API sans dépendance externe ; mode E2E interdit au démarrage de production
- [ ] Validation manuelle testnet : onboarding, ingestion, mint, escrow, entraînement, règlement, récupération et crypto-shredding
- [x] Réputation calculée depuis les `EscrowFinish` confirmés ; les `EscrowCancel` restent visibles mais neutres sans attribution, catalogue paginé et requêtes indexées
- [x] `CancelAfter` : marge avant calcul, reaper, remboursement manuel idempotent et hash `EscrowCancel` persisté
- [ ] Arbitrage des litiges qualité au-delà du remboursement mécanique
- [x] Polish UI, lint propre et page d'audit des reçus on-chain
- [ ] Vidéo backup démo

## Post-MVP / lancement réel

### Couche IA — 4 briques (détail dans `ARCHITECTURE.md`)
À construire dans cet ordre. Règle d'or : les LLM ne voient que métadonnées/synthétique, les modèles ML restent dans le TEE.
- [ ] **[2] Agent de découverte** (LLM) — « trouve-moi le bon dataset » sur le catalogue. Le plus simple, fort en démo.
- [ ] **[4] Générateur synthétique** (modèle ML, dans le TEE) — faux dataset fidèle pour bosser dessus. **Seul vrai effort R&D** (sa qualité libère ou bride le data scientist).
- [ ] **[3] Agent de data-prep** (LLM) — commandes NL → code de nettoyage testé sur le synthétique, exécuté dans le TEE. Dépend de [4].
- [ ] **Croisement de datasets** (multi-party dans le TEE) — composition sur mesure de plusieurs providers. Le plus dur (schémas, confidentialité, pricing, juridique).

> Reverse marketplace (data request broadcastée aux providers si rien n'existe) : axe orthogonal, à cadrer.

### Produit
- [ ] Arbitrage des litiges qualité (oracle / DAO).

### Technique
- [ ] **Jobs longs asynchrones** avant modèles complexes/code borrower : file persistante, soumission rapide, statuts récupérables, reprise, polling/événements, puis arrêt/démarrage automatique de la même CVM (D-27).
- [ ] **ZK metrics** (SP1 / Risc0) — preuve vérifiable des métriques au lieu du « en clair ».
- [ ] Migration vers **Vault XLS-65** + **Lending XLS-66** quand activés mainnet (pooling + rails de prêt natifs).
- [ ] Permissioned DEX pour un marché secondaire d'accès.
- [ ] SOC 2 / conformité institutionnelle.

## Hors-scope MVP (assumé)
- **Aucune des 4 briques IA** (découverte, générateur synthétique, data-prep, croisement). Le MVP exécute la régression linéaire déterministe fournie par Sirius ; le code arbitraire du borrower est post-MVP.
- Pas de ZK (métriques en clair).
- Pas de watermark (remplacé par TEE).
- Pas de pooling multi-providers (Vault XLS-65 pas mainnet).
- Permissioned Domain posé léger (compliance-signaling, valeur pleine en roadmap).
