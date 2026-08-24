# Décisions (ADR léger)

Journal des choix structurants. Format : décision · pourquoi · alternatives écartées.

---

## D-1 — Repartir du concept, pas du code POC
Le POC `PBW26/Sirius2.0` est un prototype de hackathon. On reconstruit propre dans un nouveau repo, en **copiant sélectivement** les briques solides (XRPL primitives, crypto, wallet, UI) — pas un fork à nettoyer.

<a id="mainnet-only"></a>
## D-2 — Mainnet-only
**Décision** : n'utiliser que des primitives **activées sur XRPL mainnet** (vérifié juin 2026).

| Primitive | Mainnet ? | Décision |
|---|---|---|
| MPT (XLS-33) | ✅ oct. 2025 | Utilisé |
| Credentials (XLS-70) | ✅ | Utilisé |
| Permissioned Domains (XLS-80) | ✅ fév. 2026 | Utilisé (léger) |
| TokenEscrow (XLS-85) | ✅ fév. 2026 | **Pilier du règlement** |
| RLUSD | ✅ live | Cible de règlement post-MVP |
| Single Asset Vault (XLS-65) | ❌ en vote | Reporté (roadmap) |
| Lending Protocol (XLS-66) | ❌ en vote | Remplacé par TokenEscrow |
| Smart Escrow / Wasm (XLS-100) | ❌ en dev | Remplacé par crypto-conditions |
| Batch (XLS-56) | ❌ retiré (bug fév. 2026) | Non utilisé |

**Conséquence** : le « lending » devient un **escrow conditionnel P2P**, pas un pool natif. Plus simple, plus honnête, réellement déployable.

## D-3 — TEE-first, abandon du watermark
Le watermark du POC (perturbation 1e-6) est indétectable du bruit et ne protège rien contre la copie. Le **TEE** (Phala dstack) résout le vrai problème : le borrower ne voit **jamais** la donnée brute, seulement le modèle. C'est le différenciateur.

## D-4 — Fair-exchange atomique via capsule verrouillée par le fulfillment
Un escrow time-based naïf ne protège que le borrower. Le runner TEE chiffre donc la clé modèle sous deux facteurs : une clé ECDH non exportable du navigateur et le fulfillment XRPL. Le borrower persiste cette capsule avant d'autoriser le règlement. Le runner soumet ensuite lui-même `EscrowFinish` : la transaction paie le provider et publie le fulfillment qui déverrouille la capsule déjà détenue. Next ne voit ni la clé modèle ni le fulfillment avant sa publication on-chain. Voir [ARCHITECTURE.md](ARCHITECTURE.md).
Litige subjectif sur la qualité → arbitrage en roadmap.

## D-5 — Pas de ZK au MVP
Les ZK proofs du POC sont 100 % mockées. Au MVP, **métriques en clair** calculées dans le runner TEE puis persistées par Next. ZK réel (SP1/Risc0) = roadmap, swappable derrière une interface.

## D-6 — Frontend Next.js (pas Nuxt)
Exception à la stack Nuxt habituelle : le projet est React/Three.js/wallet-lourd. Garder Next.js permet de **réutiliser le visuel et le wallet otsu existants** sans régression. Réécrire en Nuxt = tout reporter à la main = bugs garantis pour zéro gain visuel.

## D-7 — Persistance SQLite + Prisma
Remplace le JSON volatile en mémoire (`globalThis Map`) du POC. Léger, typé, zéro infra, migrable Postgres plus tard.

## D-8 — Cible RLUSD, XRP au MVP
RLUSD est la cible de règlement stable et porte le narratif institutionnel. L'implémentation MVP utilise XRP pour éviter issuer et trustlines pendant les validations ; D-16 précise ce choix.

## D-9 — Dev sur testnet, promotion mainnet ensuite
TokenEscrow + MPT + Credentials + Domains sont sur testnet → dev là-bas, même code promu mainnet. Aucun coût de transaction réel pendant le dev.

## D-10 — Couche IA en 4 briques, hors MVP
**Décision** : la couche IA est une **vision post-MVP**, *non incluse au MVP*. Détail dans [ARCHITECTURE.md](ARCHITECTURE.md).

Quatre briques distinctes (à ne pas confondre — « IA » ≠ « LLM » ≠ « agent ») :
1. **Modèle du borrower** (modèle ML, dans le TEE) — son produit.
2. **Agent de découverte** (LLM) — recommande un dataset ; ne voit que les métadonnées publiques.
3. **Agent de data-prep** (LLM) — traduit les commandes NL en code de nettoyage ; voit schéma/stats/synthétique, le code s'exécute dans le TEE.
4. **Générateur synthétique** (modèle ML, dans le TEE) — produit un faux dataset fidèle pour permettre au data scientist de travailler sans voir le vrai.

**Règle d'or** : les LLM ([2],[3]) ne voient que métadonnées/synthétique ; les modèles ML ([1],[4]) touchent la vraie data mais restent dans le TEE. → utiliser une API LLM externe pour [2]/[3] ne fait fuiter aucune donnée sensible.

**Pourquoi pas un chat humain↔humain** : canal de désintermédiation + fuite + anti-neutralité. L'agent de découverte remplace avantageusement le chat.

**Compromis du data scientist** : liberté de prep sur **synthétique** + éval sur le **vrai** via le TEE (métriques agrégées + DP). Non entravé pour l'ingénierie/la perf finale ; partiellement contraint pour le feature engineering fin et l'error analysis. Seul vrai effort R&D = **la qualité du générateur synthétique [4]**.

**Ordre de construction** : [2] → [4] → [3] → croisement.

## D-11 — Wallet : xrpl-connect (multi-wallet) au lieu d'Otsu seul
Le POC ne gérait qu'**Otsu** (lié au wasm-devnet, abandonné). On adopte **xrpl-connect** (XRPL-Commons) : couche multi-wallet unique + modal natif — Crossmark, GemWallet, Otsu, Xyra, Ledger sans config ; Xaman et WalletConnect activés si clé fournie. La lib touche `window` à l'import → **chargée dynamiquement (navigateur only)** pour ne pas casser le SSR. **Garde-fou réseau** : avertit si le wallet connecté n'est pas sur le réseau attendu (testnet en dev) — on ne peut pas forcer l'extension depuis le site.

## D-12 — Identité visuelle : Blob 3D oui, orange + Vipnagorgialla non
On reprend du POC le **Blob 3D** (three.js, hero signature, three pinné `0.183.1`) et les composants de base. On **abandonne** l'accent orange `#FF4D00` et la police Vipnagorgialla → palette sombre **monochrome**, police **Geist**. Interaction « clic = saut » du blob retirée.

## D-13 — Non-custodial : état réel et migration des signatures
**Décision** : les actifs utilisateur doivent être signés par leur propriétaire, jamais par Sirius en production. Le **MPT** représente l'identité on-chain du dataset ; la donnée reste chiffrée sur IPFS.

**Réalisation** : `EscrowCreate`, paiements, mint/destroy MPT et `CredentialAccept` KYB suivent tous le même flux non-custodial : transaction autofillée côté serveur, signature Web3Auth/xrpl-connect par le propriétaire, décodage et contrôle strict du scope, puis soumission/réconciliation. Les routes utilisateur ne chargent plus de seed provider/borrower. L'émission `CredentialCreate` reste une autorité du vérificateur : auto-émission uniquement en développement, credential préémis obligatoire en production.

**Confidentialité data** : l'ancien trou `SIRIUS_MASTER_KEY` côté Next est fermé en production par D-24→D-26. La master key et les clés de données restent dans le runner CVM ; Next ne reçoit ni plaintext, ni DEK, ni clé modèle.

## D-14 — KYB = credential par entité (pas par rôle), gating bloquant
**Décision** : le KYB est un **Credential XLS-70 unique par entité** (`credType "KYB"`, issuer = Sirius), **indépendant du rôle**. Une même entité peut être provider ET borrower avec un seul KYB ; le rôle est porté par l'**action** (mint = provider, emprunt = borrower). Gating **bloquant** : pas de KYB accepté → pas de mint.
Conséquences : champ `role` **retiré** du model `Credential` (migration `drop_credential_role`) ; l'affichage UI provider/borrower est un **contexte de navigation** (route), pas lié au credential. Alternative écartée : KYB distinct par rôle → obligerait une entité à deux KYB, plus complexe.

## D-15 — Auth des routes API par challenge wallet — réalisée
**Décision réalisée en 3b.2** : challenge signé par le wallet → session cookie HMAC ; routes mutantes protégées et contrôles d'ownership ajoutés en 3b.3a. D-26 renforce ensuite les opérations TEE : Next ne peut pas s'autoriser lui-même auprès du runner.

## D-16 — Escrow en XRP d'abord, RLUSD ensuite
**Décision** : l'inc.2 implémente le TokenEscrow en **XRP natif**. Précise D-8 (RLUSD cible, XRP fallback) côté implémentation : XRP n'a ni issuer ni trustline → zéro friction pour valider le mécanisme (condition + CancelAfter) sur testnet. Le **même code escrow** marchera en RLUSD en changeant le champ `Amount`. Alternative écartée : RLUSD direct → nécessiterait un issuer RLUSD testnet + trustlines des participants juste pour du dev (pas de RLUSD officiel sur testnet).

## D-17 — Crypto-condition d'escrow dérivée dans le runner TEE
**Décision réalisée** : la crypto-condition PREIMAGE-SHA-256 est dérivée de façon déterministe depuis la master key du runner, avec un contexte isolé par `borrower + loanId`. Le fulfillment n'est jamais stocké et n'est produit que par `runLoanJob` après succès du calcul. En dev, le stub utilise `SIRIUS_MASTER_KEY` ; en production Phala, D-24 scelle la source de clé dans la CVM. Alternative écartée : stocker le fulfillment en DB.

## D-18 — Stratégie d'entraînement confidentiel (roadmap, post-stub)
**Problème** : laisser un max de liberté sur **la manière d'entraîner** le modèle (algo, hyperparamètres) sans que la donnée ne fuie. Le TEE protège du vol direct/opérateur, **pas** du modèle qui sort par le canal légitime (un code malveillant peut encoder la data dans les poids : mémorisation, stéganographie LSB, encodage direct).

**Décision — mode par défaut** : **pipeline d'entraînement imposé + DP**, **hyperparamètres/algo libres** (dans une liste). Le borrower ne fournit pas le code d'écriture des poids → on garde la main sur la boucle. La liberté totale par conteneur reste possible mais dégradée à un curseur extrême (cf. ci-dessous).

**Output-gate** (audit de la sortie) :
- **Quantification post-training** + sérialisation canonique → tue la stéga LSB et les canaux annexes (gratuit en qualité).
- **Taille de sortie bornée** → limite la capacité du canal (efficace surtout petits modèles ; pour le deep learning, s'appuyer sur DP).
- **DP-SGD** → borne mathématique (ε) de l'influence d'une ligne ; ne tient **que** si le pipeline DP est imposé (un code libre peut l'ignorer).

**Anti-exfiltration par accumulation — 3 couches complémentaires** : **prix par run** (friction éco, = 1 escrow/job) + **rate limit** (friction temporelle, anti-burst) + **budget DP global ε** (borne dure de fuite cumulée, non contournable par l'argent). Les deux premières ralentissent/coûtent, seul ε **coupe**.

**Curseur réglable par le provider** selon la sensibilité de sa data : `algos prédéfinis + DP fort` (ultra-sensible) → `pipeline imposé + DP, params libres` (défaut) → `conteneur libre + sortie bornée` (peu sensible, risque assumé par le provider).

**Compétitivité** : face à « data déjà en clair », non compétitif (DP dégrade, moins de visu). Le vrai concurrent = « **pas d'accès du tout** » : data réglementée/sensible (santé, finance, RGPD) jamais livrée en clair → un modèle un peu dégradé ≫ rien. Marché des clean rooms.

**Statut** : roadmap. L'**inc.3 (job fixe)** est un premier « pipeline imposé » minimal ; DP + params + output-gate + budget ε se greffent en inc.3b+. Lié à la couche IA (D-10) et au générateur synthétique [4] (liberté sur la *prépa*, ≠ ici la liberté sur l'*entraînement*).

**Réalisation 3d (output-gate)** — premier étage du « videur en sortie », `src/lib/tee/output-gate.ts`, appelé par `src/lib/tee/core.ts` avant chiffrement du modèle : (1) **quantification** des poids/métriques à 6 chiffres significatifs (`toSigFigs`) → écrase les bits de poids faible = tue la stéga LSB (~20 bits/coef max) ; (2) **sérialisation canonique** (ordre de champs fixe, aucun champ libre) → ferme les canaux annexes ; (3) **taille de sortie bornée** (256 Ko, reject) → borne l'info totale exfiltrable. + **rate-limit temporel** (`prepareLoan` : 3 runs/h par borrower+dataset) = la couche « friction temporelle » anti-accumulation (le « prix par run » = 1 escrow existe déjà). **Restent en roadmap** : DP-SGD (borne ε par run) et **budget ε global** (seule borne dure de fuite cumulée), + curseur de sensibilité par provider. Validé : LSB écrasés, canonique déterministe, taille bornée.

## D-19 — Double vitrine (MLaaS confidentiel + marketplace) + tiers UX
**Décision** : deux produits sur le **même moteur TEE**, exposés par une **landing qui dispatche** (deux portes : « entraîner un modèle » / « monétiser mes données »).
- **MLaaS confidentiel** : le client apporte **sa** data, récupère **son** modèle. Le TEE garantit la privacy **vis-à-vis de Sirius** — pas de fair-exchange requis (le client se fait confiance à lui-même).
- **Marketplace** (l'existant) : data d'un provider, modèle d'un borrower → **fair-exchange atomique** (D-4).
Une même entité peut faire les deux (aligné D-14, KYB par entité) : ce sont **deux espaces**, pas deux comptes ; un user avec historique d'un seul côté est renvoyé direct à son espace.
La page de réglages d'entraînement n'est **pas un secret** → **progressive disclosure** par tier de compte : `business` (métier : datasets, requêtes, résultats) vs `technical` (+ panneau hyperparamètres de la liste D-18). Toggle simple/avancé (haut de page **et** réglages), défaut simple, + **product tour** première visite.
Angle « data = actif » porté dans le langage de l'espace provider (portefeuille, revenus, MPT = titre). Alternatives écartées : deux apps séparées (duplication, casse l'entité double-rôle) ; auth dure sur la page params (rien de secret → over-engineering).
**Révision inc.3b.5** : le concept reste, mais l'exécution est simplifiée après cadrage (cf. D-23). (1) **Pas de page dispatch 2-portes** → post-login = **dashboard unique** (solde + onglets), les deux espaces cohabitent dans un seul shell. Le double produit se lit dans le **flux « entraîner »** : « choisir un dataset » montre **mes datasets en haut** (self-train = MLaaS, gratuit, pas d'escrow envers soi) puis le **catalogue** en dessous. (2) **Tier business/technical raboté** : pas de tier de compte global ni de setup à l'onboarding (jugés sans effet hors entraînement) → **simple toggle contextuel « Simple / Avancé »** là où ça change quelque chose (config d'entraînement + bloc détails on-chain), défaut Simple, mémorisé localStorage.

## D-20 — Wallet embarqué non-custodial (Web3Auth MPC) + on-ramp fiat
**Décision** : onboarding « zkLogin-like » via **Web3Auth MPC Core Kit** (rebrandé **MetaMask Embedded Wallets**) + `@web3auth/xrpl-provider`. Login social (Google) → compte XRPL classique, **zéro seed**.
Custody **TSS 2-sur-3** (device / réseau-social / backup), **clé jamais reconstituée** → **non-custodial dur** : ni Web3Auth, ni l'OAuth, ni notre backend ne peuvent signer seuls. Récupération multi-facteurs (device / password / MFA) ; cible non-crypto = **Google + PIN + recovery**.
Ajouté **à côté** de xrpl-connect (D-11), pas en remplacement : « wallet externe » (crypto-natifs) **ou** « Google » (entreprises non-crypto).
**XRPL n'a pas de zkLogin natif** (pas de ZK ni d'account abstraction au protocole) → on réplique l'**UX** via MPC, pas la mécanique. L'« account abstraction » est **côté app** (clés + réserve + fiat masqués), le compte reste un compte XRPL standard.
**On-ramp fiat = MoonPay** : XRP **et** RLUSD nativement XRPL, SDK web embarqué, **KYC délégué** (pas notre charge), fonds **direct sur l'adresse user** (non-custodial). L'on-ramp **XRP auto-active le compte** (réserve payée par l'achat) → **pas de sponsoring de réserve** au MVP. **RLUSD reporté** (exige compte actif + trustline = parcours 3 étapes) ; escrows en **XRP d'abord** (cohérent D-16).
Bonus : la liaison **wallet↔session** (challenge signé) **ferme l'auth des routes API** (finding C-1 / D-15).
Replis : **Turnkey** (TEE + passkeys, enterprise) si le pricing/rebrand Web3Auth bloque. **Privy écarté** (XRPL non listé → raw-sign artisanal ; non-custodial « mou » par défaut). Alternative écartée : custodial serveur (dépositaire de fonds = licence/risque légal, contredit D-13).
**Sortie de secours des fonds (inc.3b.5)** : `keyExportEnabled:false` → l'user ne voit jamais sa clé privée, mais le Blob **signe des `Payment`** → la page `/wallet` expose un bouton **« Envoyer / Retirer »** vers n'importe quelle adresse (wallet seed que l'user contrôle à 100%). Les fonds vivent on-chain, jamais chez Sirius → **jamais piégés**. Seul vecteur de perte = l'user perd **tous** ses facteurs de récup simultanément → mitigé par la **récupération multi-facteurs** Web3Auth (device / PIN / MFA ; cible non-crypto = Google + PIN + recovery), intégrée à l'onboarding 3b.5.

## D-21 — Lifecycle des datasets : public/privé + suppression par crypto-shredding
**Décision** : **statut public/privé = flag DB** (`LISTED` / `UNLISTED` / `PRIVATE`), instantané et réversible ; le MPT reste on-chain (empreinte CID + merkleRoot, **pas** la data).
**Suppression réelle en 3 niveaux** : (1) **délister** (DB) ; (2) **crypto-shredding** — détruire la **clé de déchiffrement par dataset** + **unpin IPFS** → data irrécupérable même si un chunk survit (réponse « droit à l'effacement » RGPD/entreprise) ; (3) **`MPTokenIssuanceDestroy`** si 0 balance en circulation.
La **trace d'existence** (MPT passé, transactions) reste dans l'historique du ledger — **inévitable et assumé** (feature d'audit), explicité dans l'UX (« la donnée et tout accès sont détruits ; seule la trace on-chain reste »).
**Conséquence archi** : le crypto-shredding impose une **clé par dataset stockée et destructible unitairement** — incompatible avec la dérivation déterministe depuis `SIRIUS_MASTER_KEY` (D-13/D-17). → **même refacto** que le scellement TEE : clé par dataset (inc.3c), scellée enclave et destructible (inc.3d). Alternative écartée : suppression « logique » DB seule (la data chiffrée reste déchiffrable → fausse suppression).

**Réalisation 3c.1 — refacto clé par dataset (enveloppe DEK-wrap)** : à l'upload, une **DEK aléatoire** (`generateKey`, 32 bytes) chiffre le dataset ; elle est **wrappée** sous une KEK dérivée de la master (contexte `wrap:dataset:v1:<id>`, préfixe `v1` = anticipe une rotation de master key) et stockée en DB (`Dataset.wrappedKey`, nullable). **Durcissement audit** : `omit` global sur `Dataset.wrappedKey` au niveau du client Prisma (`src/lib/db.ts`) → la DEK enveloppée ne fuit jamais dans une réponse API. `wrappedKey` absent ⇒ erreur explicite : l'effacement du champ rend la donnée irrécupérable car la DEK n'a aucune autre copie. **Révision 3d-B** : l'ingestion est chiffrée navigateur→runner ; seul `src/lib/tee/core.ts` wrappe/unwrappe la DEK avec la master key dstack. Next persiste l'enveloppe mais ne peut plus ouvrir le dataset en production.

**Réalisation 3c.2 — crypto-shredding** : `DELETE /api/datasets/[id]` (auth + `assertOwner`) → `shredDataset` (`src/lib/sirius/provider.ts`). Un reaper séparé du flux de suppression expire les réservations non signées, réconcilie `SUBMITTING`/`SETTLING` et demande au runner d'annuler les escrows arrivés à `CancelAfter`. Le runner contrôle l'heure du ledger validé et ne confirme `CANCELLED` qu'après un `EscrowCancel` `tesSUCCESS` retrouvé on-chain. `shredDataset` reste bloqué tant qu'un emprunt est réservé ou actif (`PENDING`, `SUBMITTING`, `ESCROWED`, `TRAINING`, `SETTLING`), puis garantit `wrappedKey=null` + `status=DELETED` + `keyDestroyedAt` avant l'unpin best-effort. Le provider signe lui-même `MPTokenIssuanceDestroy`; un échec est signalé et peut être retenté après le shredding. **Soft-delete** : la trace on-chain/DB reste, la data devient irrécupérable.

**Réalisation 3c.3 — visibilité (Public / Semi-privé / Privé)** : enum `DatasetStatus` étendu (`UNLISTED`, `PRIVATE` ; valeurs techniques gardées, labels UI FR). Sémantique (analogie YouTube) : **Public** (`LISTED`) = catalogue + empruntable ; **Semi-privé** (`UNLISTED`) = hors catalogue mais empruntable par **lien direct** ; **Privé** (`PRIVATE`) = provider seul (self-train), non-empruntable. `setDatasetVisibility(id, owner, v)` (pur DB, réversible, refuse DRAFT/DELETED/SUSPENDED) via `PATCH /api/datasets/[id]`. Notion partagée `BORROWABLE_STATUSES = [LISTED, UNLISTED]` consommée par `prepareLoan`/`finalizeLoan`. Filtrage : catalogue (`GET /datasets`) = `LISTED` seul ; `GET /datasets/[id]` expose Public+Semi-privé à tous, Privé/Draft/Suspendu à l'owner (404 sinon, pas 403). UI `/datasets` : sélecteur segmenté + bouton Supprimer (confirm → `DELETE`). **Durcissements audit** : `setDatasetVisibility` utilise un claim atomique `updateMany(status ∈ VISIBILITY_STATES)` : un crypto-shredding concurrent ne peut pas être ressuscité. `finalizeLoan` refuse un escrow sur un dataset devenu indisponible. L'unpin reste best-effort et la destruction MPT est signée côté client par le provider.

## D-22 — Intégration Web3Auth v11 XRPL : singleton impératif + patch + proxy
Le provider XRPL de Web3Auth v11 (`@web3auth/modal@11.2.0`) est fragile (coin peu maintenu). Blocages franchis pour « login Google → adresse XRPL non-custodial » :
1. **Namespace** : `chainNamespace` doit être `CHAIN_NAMESPACES.XRPL` (pas `.OTHER`) sinon `XrplPrivateKeyProvider` throw *"Invalid chain namespace"*.
2. **Requête gelée (bug SDK)** : `createRequestIdNormalizerMiddleware` mute `request.id`, mais `JRPCEngineV2` (`@web3auth/auth`) `deepFreeze` la requête **et** interdit toute modif d'`id` → crash *"Cannot assign to read only property 'id'"*.
3. **Ping CORS** : à l'init, le provider ping `rpcTarget` en HTTP ; rippled testnet n'a pas de CORS → *"Failed to fetch"*. **Contourné par un proxy same-origin** (`src/app/api/xrpl-rpc/route.ts`, lecture bornée), `rpcTarget` pointé dessus côté client.
4. **WalletServicesPlugin** (UI on-ramp/portfolio, non-sécurité, inutilisé) : chargé à tort car le projet dashboard injecte des chaînes EVM par défaut (`initChainsConfig`), puis crashe à la connexion sur la chaîne active XRPL (*"Unsupported chain namespace"* → *"not initialized"*).

**Intégration + custody** : Web3Auth piloté en **singleton impératif** (`src/lib/web3auth/manager.ts`), pas via le `Web3AuthProvider` React (qui forçait en plus le WalletServices). `keyExportEnabled: false` → la clé ne sort jamais du provider, signature in-provider (`xrpl_signTransaction`) = non-custodial dur (cf D-20).

**`pnpm patch` de `@web3auth/no-modal@11.2.0`** (`patches/@web3auth__no-modal.patch`, épinglé dans `pnpm-workspace.yaml`), 3 corrections : (a) neutralise le middleware id-normalizer [#2] ; (b) `initPlugins` n'enregistre le WalletServices que si la **chaîne active** (`defaultChainId`) le supporte, pas juste une chaîne EVM dashboard → jamais pour XRPL [#4] ; (c) `initWithWeb3Auth` du plugin fait un no-op au lieu de throw (défense en profondeur, redondante avec (b)). **Audité sûr** : patchs cosmétiques/fonctionnels, aucune protection sécu désactivée. **Repli** si le coin XRPL casse davantage : clé brute + dérivation via notre `xrpl.js`, ou Turnkey (D-20).

**Réalisation — récupération multi-facteurs (fin 3b)** : enforcement **`optional`** retenu (écran MFA proposé au login mais skippable, pas `mandatory` → onboarding grand public fluide). `loginWithGoogle` passe `mfaLevel: "optional"` ; `secureEmbeddedAccount()` appelle `enableMFA()` (aucun facteur) ou `manageMFA()` (déjà sécurisé) selon `getUserInfo().isMfaEnabled`. Nudge non intrusif : bandeau dismissable dans le shell `(app)` + carte « Sécurité » dans `/wallet`, tous deux masqués hors source embedded ou une fois le facteur ajouté. État `mfaEnabled` peuplé par `EmbeddedWalletSync` à la connexion. **Facteurs par défaut** (plan gratuit `SAPPHIRE_DEVNET`) — la personnalisation `mfaSettings` (choix/priorité des facteurs, cible « Google + PIN + recovery ») exige le plan SCALE payant, à activer avant prod mainnet.

## D-23 — Architecture de navigation 3b.5 : landing scroll + shell app + détection première connexion on-chain
**Décision (cadrage 3b.5)**. **Landing (déconnecté)** = page **scroll multi-sections** réutilisant le mécanisme du POC (GSAP + Lenis + Blob à zoom caméra piloté par `__scrollProgress`) : ① hero *dans le Blob* (Sirius + description générale valable lenders/borrowers/self-train + bouton Connect) → ② « comment ça marche » (flowSteps réécrits, **sans Vault XLS-65 / ZK Boundless / watermark** — jetés) → ③ about → ④ footer stylisée (version basique au MVP, upgrade prévu ; piste easter-egg). Police **Geist gardée**, monochrome, **zéro orange** (cf. mémoire prefs).
**App (connecté)** = route group `(app)` avec **shell persistant** : **Blob en logo haut-gauche** (mode `logo` statique/allégé, plus de Blob plein écran → coût WebGL maîtrisé) + Sidebar. Pages : `/dashboard` (accueil : solde + onglets), `/train` (flux : choisir dataset → config+escrow → suivi/récup modèle, = ex-`/borrow`), `/marketplace` (browse + **favoris ⭐ localStorage**), `/datasets` + `/datasets/new` (provider, ex-`/provider`), `/wallet` (solde + Ajouter (onramp) + Envoyer/Retirer, cf. D-20), `/settings` (KYB/compte).
**Détection première connexion = 100% on-chain (option B retenue)** : à la connexion, on lit le ledger (adresse activée ? credential KYB présent ?) → « compte connu ou non », **sans écriture DB**, cohérent non-custodial. Le flag « tuto déjà vu » reste en **localStorage** (par device). → nouvelle adresse inconnue = déclenche le **product tour** (overlay maison, dernier, nice-to-have). Alternatives écartées : `/me` serveur (marche mais écrit/lit la DB alors que le ledger suffit) ; localStorage seul pour « compte connu » (faux « nouveau » au changement de device).
**Tier** : cf. révision D-19 (toggle contextuel Simple/Avancé, pas de tier de compte).
**Réalisation (3b.5, commit `decbc89`)** — conforme sauf : (1) **Blob logo animé** (pas statique) : rendu **partagé mono-canvas** piloté par `useBlobStore.mode` (skin fine + grain + bloom léger, ~44px), clic = **dashboard** (app) ou **landing** (depuis `/docs`) ; coût WebGL maîtrisé via un seul canvas. (2) **Sortie de l'app** vers la landing = **icône logout** (flèche sortant d'une porte) dans le header de la Sidebar (desktop + mobile), en plus du blob. (3) **Landing simplifiée** : hero pinné (zoom caméra au scroll) + **About us** (cartes équipe) + footer ; la section « comment ça marche » a été retirée (redondante avec `/docs`). (4) **`/settings` non livré** (KYB/compte reporté). (5) **Backend self-train construit** (hors périmètre frontend annoncé) : `TrainingJob`, `/api/train`, `runSelfTrain` (MLaaS sur sa propre data, sans escrow), `trainAndEncrypt` extrait du stub.

## D-24 — Scellement de la master key à l'enclave (Phala dstack, inc.3d.1)
**Décision** : en mode phala, la master key n'est plus lue depuis `SIRIUS_MASTER_KEY` (env host) mais **dérivée dans la CVM** via `DstackClient.getKey('sirius/master/v1')` (KMS dstack) — déterministe pour l'`app_id`, avec livraison autorisée selon l'identité mesurée de l'application (`compose_hash`/attestation), jamais exposée à l'opérateur. `getMasterKey` devient **amorçable** (`primeMasterKey`) : la clé enclave est injectée **une fois au boot** du runner, et **tout le downstream en découle** (clé du modèle, condition escrow D-17, reçus HMAC, wrap des DEK 3c.1). En mode phala, l'absence d'amorçage **échoue explicitement**. Le `PhalaTeeRunner` et le stub partagent le même cœur DB-free `runLoanJob`, seule la source de clé et la production d'une quote TDX diffèrent.
**Altitude** : on scelle **la source unique** (un point) plutôt que chaque usage (N points) → ferme le trou master-key D-13/D-17 pour tout le graphe de dérivation d'un coup. Le wrap-sous-master de 3c.1 devient un vrai scellement enclave.
**Pièges actés (reco Phala)** : mode KMS `dstack-kms` requis (pas `local-key-provider`, sinon clé non portable entre machines) ; path **versionné** (`/v1`) ; **valider la persistance de la clé à travers les redéploiements** (dépend de la stabilité de l'`app_id`) AVANT de chiffrer de la vraie donnée — sinon redéploiement = clé différente = données irrécupérables.
**Contrainte deps** : `@phala/dstack-sdk@0.5.8` exige `@noble/hashes@^1.6.1` (subpaths `/sha256`,`/sha512`) alors que le projet embarque la v2 (subpaths renommés `sha2`) → **override pnpm** ciblé sur l'arête du SDK (`pnpm-workspace.yaml`).
**Validation** : round-trip SDK réel contre un faux guest-agent local (`DSTACK_SIMULATOR_ENDPOINT`) — dérivation déterministe par path, refus avant amorçage, downstream dérive bien de la clé enclave. La quote TDX (3d.2), l'identité complète du code (3d.2b) et le scellement du fulfillment (3d.3) sont code-complete. Restent le déploiement dans une vraie CVM, la persistance de clé et la capture des mesures réelles épinglées.

**3d.2 — attestation TDX = preuve matérielle et gate de production.** Le stub local utilise l'attestation HMAC pour conserver la parité de flux. Avec un runner distant en production, Next exige une quote TDX liée au modèle (`report_data = payloadHash`) et vérifie binding, signature Intel/TCB et mesure épinglée **avant** d'accepter la capsule et d'autoriser le règlement. La quote est persistée (`Loan.attestationQuote`) et reste vérifiable via `GET /api/loans/[id]/attestation`. Le runner ne vérifie pas son propre quote : cette vérification reste externe pour éviter une preuve circulaire. Validé sur vraie fixture TDX (`UpToDate`) ; reste à produire depuis une vraie CVM.
**Nuance post-audit — matériel authentique ≠ code Sirius.** `hardwareVerified:true` (DCAP) prouve seulement qu'un vrai TDX Intel a signé le `report_data`. L'identité fine 3d.2b est implémentée : replay de l'event-log contre RTMR3, présence exacte de l'événement `compose-hash`, puis comparaison aux valeurs épinglées `SIRIUS_EXPECTED_MRTD`, `SIRIUS_EXPECTED_RTMR3` et `SIRIUS_EXPECTED_COMPOSE_HASH`. L'empreinte de la `signature_chain` KMS de la master key est également épinglée au démarrage du runner. La production échoue fermée si une de ces valeurs manque ou diffère ; leur capture reste une étape du déploiement B.5 sur vraie CVM.

## D-25 — Runner de compute confidentiel isolé (topologie CVM, inc.3d-B)
**Décision** : plutôt que déployer toute l'app Next dans la CVM (option A : simple, zéro refacto, mais `compose_hash` gros/volatil ré-épinglé à chaque déploiement, TCB obèse, SQLite-en-CVM), on **extrait le calcul confidentiel dans un service runner isolé** (option B, reco Phala). Le runner (CVM) est le **seul détenteur de la master key enclave** et expose un contrat (`tee/contract.ts`) : `sealDataset`, `runTraining`/`runLoanJob`, `deliveryKey`, `escrowCondition`, `settleLoan`. Next (hors CVM : front, API, DB et orchestration) l'appelle avec des **inputs explicites** et n'importe plus jamais la clé. Le runner conserve le fulfillment, prépare la capsule puis soumet lui-même `EscrowFinish` : Next ne peut ni libérer les fonds seul ni retenir le secret après paiement.
**Bénéfices** : `compose_hash` petit et stable (un changement de front ne le bouge pas → attestation propre, `SIRIUS_EXPECTED_MRTD` stable) ; TCB minimal (seule la logique de calcul dans la frontière de confiance) ; DB hors CVM (persistance normale, plus de SQLite éphémère).
**Coût** : refacto multi-slices (cœur DB-free → service HTTP → rewire Next → parité dev → Docker/CVM). La **session HMAC** migre sur un secret dédié `SIRIUS_SESSION_SECRET` (hors enclave, pas un enjeu de custody). Le canal Next↔runner garde un secret de transport sans droit métier ; les autorisations sont décrites en D-26.
**Alternative écartée (A)** : app entière en CVM — retenue seulement si on voulait une démo la plus rapide ; réversible (le code ne change pas, juste le packaging), mais attestation bruitée. On vise B directement (cf. D-24 pour l'attestation).
**Réalisation B.4 durcie** : `compose.yaml` construit deux images distinctes et projette uniquement les variables nécessaires à chaque service. Le runner ne partage ni `.env.local`, ni source, ni `node_modules`, ni Prisma/DB avec Next ; son filesystem est read-only hors registre anti-rejeu. Les ports de développement sont liés à `127.0.0.1`. La capability est vérifiée avant lecture du body, puis le serveur impose `Content-Length`, plafonds, timeouts et limites de charge. `runner:smoke` vérifie le healthcheck puis une opération authentifiée.
**Transport B.5** : TLS 1.3 est terminé directement par le runner dans la CVM, derrière le passthrough Phala. Dstack génère une clé privée fraîche et un certificat RA-TLS dans la CVM. Le runner expose une quote publique supplémentaire dont le `report_data` est le SHA-256 exact du certificat ; Next vérifie hostname/validité, signature Intel et TCB `UpToDate`, mesures épinglées, replay RTMR3 et `compose_hash`, puis utilise un agent HTTPS limité à ce certificat. Le bootstrap non authentifié ne transporte aucun secret ; capabilities et payloads ne sont écrits qu'après attestation. L'évidence est renouvelée au redémarrage du runner et revérifiée au plus toutes les cinq minutes côté Next.
**Séquencement** : B.1→B.4 terminés ; le transport RA-TLS de B.5 est code-complete. Restent l'image production et la validation sur vraie CVM.

**Durcissement post-audit** : les termes provider sont scellés dans le reçu dataset puis contrôlés contre l'escrow. La publication MPT passe par `LISTING` et persiste le blob signé, son hash et `LastLedgerSequence` avant soumission. L'EscrowCreate suit la même règle via `SUBMITTING`; le runner exige ensuite que l'objet escrow soit encore présent dans le ledger validé avant tout calcul. Le règlement est sérialisé par un lease `SETTLING`, et sa reprise cherche l'EscrowFinish sur le compte borrower depuis le ledger de création sans plafond arbitraire de 2 000 transactions. Un reaper périodique protégé par claims reprend aussi `SUBMITTING`, libère les leases `TRAINING` abandonnés et fait soumettre `EscrowCancel` par le runner après expiration vérifiée sur l'horloge du ledger. Les anciens datasets dont le reçu ne liait pas les termes restent `SUSPENDED`.

## D-26 — Autorisation runner déléguée par le wallet
**Décision** : `RUNNER_TRANSPORT_SECRET` authentifie seulement le canal et ne confère aucun droit métier. Lors de la connexion, le navigateur génère une clé de session P-256 non exportable ; l'unique signature XRPL du challenge délègue cette clé pour 1 h. Chaque action sensible produit ensuite un grant silencieux de 60 s, lié à l'opération, au wallet, aux ids, au hash du payload et à un nonce anti-replay. Le runner vérifie directement la signature XRPL, la délégation, la signature P-256, le réseau, l'origine, l'expiration et le scope. Capabilities et grants consommés sont persistés atomiquement dans un stockage propre au runner ; une réplication exigera un backend partagé offrant la même atomicité.

Le runner émet des reçus HMAC scellés sous la master key pour lier durablement dataset/job/loan à leur owner, leur ciphertext et leur résultat. `run-loan-job` exige un `EscrowCreate` validé ; `settle-loan` exige le reçu du job et un grant émis seulement après persistance locale de la capsule ; `loan-model-key` reste une récupération multi-device post-règlement. Les contextes de clés modèles incluent le wallet (`borrower`/`owner`) pour empêcher une collision d'id inter-tenant. Un changement de compte ou une déconnexion détruit la délégation navigateur et invalide la session HTTP.

La clé modèle ne traverse jamais Next en clair. Pour un loan, l'enveloppe AES-GCM exige simultanément la clé ECDH locale et le fulfillment publié par l'`EscrowFinish`. La clé privée non exportable et la capsule sont persistées en IndexedDB ; le hash de la capsule relue est lié au grant et comparé au reçu runner avant règlement.

## D-27 — Cycle de vie CVM et jobs longs
**Décision MVP** : conserver **une application/CVM runner stable**, CPU, avec un `app_id` durable. Pendant la validation Phala, Noé la démarre et l'arrête manuellement. Pour un MVP public nécessitant une disponibilité immédiate, elle reste allumée ; l'automatisation ultérieure doit démarrer/arrêter cette même CVM selon la file de jobs.

**Alternative écartée au MVP** : créer puis supprimer une nouvelle application par job. Le compute coûte le même prix par minute et l'économie maximale correspond essentiellement au disque minimal conservé. En contrepartie, un nouvel `app_id` peut produire une master key différente et casser les datasets, reçus et clés déjà scellés. Des workers éphémères ne deviennent acceptables qu'avec une identité d'application/KMS partagée ou une délégation de clé strictement scopée au job, plus la validation 3d.2b sur une vraie CVM.

**Capacité actuelle** : le modèle est une régression linéaire déterministe sur CSV, exécutée sur CPU ; aucun GPU n'est requis. Le client Next→runner attend synchronement avec un timeout de 60 s. Les entraînements de plusieurs heures ne sont donc pas supportés aujourd'hui.

**Évolution requise avant modèles longs ou code borrower** : file persistante, endpoint de soumission rapide, worker asynchrone, états de job récupérables, reprise après crash, polling/événements, puis arrêt/démarrage automatique de la même CVM. Les grants de 60 s autorisent la soumission ; ils n'ont pas vocation à borner la durée du calcul déjà accepté.

**Coût de référence au 25 juillet 2026** : `tdx.medium` CPU = 0,12 $/h ; disque minimal 20 Go ≈ 2,03 $/mois s'il est conservé. Un job de 1 à 5 h coûterait donc environ 0,12 à 0,60 $ de compute. Source : [Phala Cloud Pricing](https://cloud.phala.com/about/pricing).

## D-28 — Réputation basée sur les résolutions XRPL
**Décision** : la réputation affichée n'est ni saisie par un opérateur ni incrémentée aveuglément lors d'une requête. Elle est recalculée depuis les prêts dont la résolution possède une preuve on-chain. Le score dépend uniquement des `SETTLED + settleTxHash` et d'une confiance logarithmique bornée, maximale après quinze règlements ; une adresse sans historique vaut zéro.

Le catalogue expose la réputation provider et le dashboard sépare les rôles provider/borrower. Un `EscrowCancel` ne constitue pas automatiquement un litige imputable : il reste visible dans le volume et le taux de résolution, mais n'abaisse aucun score. La qualité métier d'un dataset ne peut pas être déduite de ces seuls événements et nécessitera un mécanisme d'arbitrage distinct.

## D-29 — E2E local sans autorité métier
**Décision** : Playwright pilote uniquement l'identité UI et intercepte les API dans le navigateur. Il ne reçoit aucune seed, ne signe aucune transaction et ne contacte ni XRPL ni Pinata. Les SDK wallet sont neutralisés dans ce mode pour rendre les scénarios déterministes. `NEXT_PUBLIC_SIRIUS_E2E=1` est explicitement interdit au démarrage de production.

Les tests couvrent le dashboard, la récupération d'upload, la visibilité, le catalogue, la reprise d'escrow et le registre d'audit. Ils ne remplacent pas le parcours testnet avec deux wallets, ni le smoke RA-TLS sur vraie CVM.

## Questions ouvertes
- Benchmark réel de la régression sur `tdx.small` et `tdx.medium`, puis seuil de passage à l'asynchrone.
- Latence de démarrage/arrêt Phala et API d'orchestration à valider sur la vraie CVM.
- Méthode du générateur synthétique [4] (copules / CTGAN / DP-synthesizer) — détermine la liberté réelle du data scientist.
- Reverse marketplace (data request broadcastée aux providers) — à cadrer.
- Mécanisme d'arbitrage des litiges qualité (oracle vs DAO).
- Calibrage DP de l'output-gate (ε par dataset + budget global) avant code borrower arbitraire.
