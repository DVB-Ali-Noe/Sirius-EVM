# Sirius

**Entraîner sur des datasets confidentiels, interroger le modèle sans jamais le sortir de l'enclave.**

Sirius est un protocole de data lending confidentiel. Le provider conserve son dataset chiffré ; le borrower soumet un entraînement dans un **TEE**. Le modèle reste scellé dans le runner : le borrower obtient des **prédictions signées** (décision 0/1 pour la logistique et les arbres ; valeur arrondie à 3 chiffres significatifs pour les modèles linéaires existants), jamais le modèle ni sa clé ([D-28](docs/DECISIONS.md#d-28--plus-aucune-livraison-de-modèle--prédiction-signée-seule)). Les prédictions ne répondent que pendant que le runner tourne. Les garanties de règlement et d'audit reposent sur des contrats **EVM** déployables sur Robinhood Chain.

## En production (9 novembre 2026)

Sirius tourne sur **Robinhood Chain mainnet** (`4663`), réglé en **USDG**, avec un runner dans une **Confidential VM
Intel TDX sur Phala Cloud** (dstack, KMS de Phala, attestation RA-TLS vérifiée à chaque appel). Depuis le 9 novembre
2026 ([PR #160](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/160)) :

- **API développeurs** : chaque location inclut une API ; une clé est créée automatiquement sur la page Train, les
  requêtes sont signées en HMAC et les réponses par l'enclave ([D-30](docs/DECISIONS.md#d-30--api-développeurs-sur-les-modèles-loués),
  [D-33](docs/DECISIONS.md#d-33--api-toujours-incluse-dans-toute-nouvelle-location), doc publique `/docs/api`).
- **Datasets jusqu'à 1 Go** : chiffrés dans le navigateur, envoyés en morceaux de 8 Mio vers un stockage privé (R2),
  ouverts seulement dans l'enclave, entraînés pour l'instant sur un échantillon ([plan](docs/UPLOAD-1GO.md)).
- Profils proposés : régression logistique 1.0.0 et arbres boostés 1.1.0 ; régression linéaire retirée pour tout
  nouvel usage ([D-31](docs/DECISIONS.md#d-31--régression-linéaire-retirée-pour-tout-nouvel-usage-profil-facultatif)).

| Contrat mainnet | Adresse |
|---|---|
| Escrow (`SiriusEscrowV7`, depuis le 9 nov.) | `0xcf5506219ec7dc04157934e3d2f6eacc0e631f97` |
| Registre de datasets v6 (limite 1 Gio, admin = Safe) | `0x496ff036fbf7ca85e36294d3e976c10c4b0951b4` |
| Registre KYB v3 | `0x8bd1590e2e223605adf3ea83dfa4cd272033c24c` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Les contrats précédents (registre v5 `0x9f40…b57f`, escrow `0xc43a…81f7` du 28 octobre ; registre v4 et escrow
`0x7121…5b13` d'octobre) restent consultables pour l'historique et les retraits. État public à jour :
https://sirius-data.tech/status.

## Principe

```text
Provider                 Robinhood Chain                     Borrower
  │                             │                               │
  ├─ dataset chiffré → IPFS     │                               │
  ├─ SiriusDatasetRegistry.mint │                               │
  │                             │◄── SiriusEscrow.lock (USDC) ───┤
  │                             │                               │
  │           Phala TEE : déchiffre, entraîne, atteste          │
  │                             │                               │
  │◄── SiriusEscrow.release ────┼── règlement confirmé ─────────►│ prédictions signées
  │    crédit provider          │                               │
```

Le runner génère le préimage du hashlock et l'envoie via `release` une fois le calcul fait : ce préimage ne sert qu'au règlement, il n'ouvre aucun modèle. Après règlement confirmé (reçu canonique et confirmations configurées en v7), l'emprunteur interroge le modèle par `POST /api/loans/[id]/predict`. `release` crédite le provider et, en v7, la trésorerie compute. `refund` reste possible après l'échéance si le prêt est encore verrouillé, en déduisant les frais déjà attestés on-chain en v7. Wallet et Dashboard permettent le retrait séparé des crédits. Le préimage est transmis au RPC avant inclusion ; les limites de finalité sont détaillées dans le [suivi de l'audit](docs/AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026).

## Stack

| Couche | Technologie |
|---|---|
| Application | Next.js 16.3.5 · React 19 · Tailwind 4 · Prisma / PostgreSQL |
| Chaîne | Robinhood Chain, EVM Arbitrum Nitro · testnet `46630` · mainnet `4663` |
| Contrats | Solidity `0.8.24` · Hardhat · viem |
| Calcul confidentiel | Phala dstack, runner HTTP isolé, RA-TLS |
| Stockage | IPFS / Pinata (petits fichiers) · Cloudflare R2 (gros fichiers, en morceaux) · AES-256-GCM |

## Contrats EVM

- `SiriusEscrow` v6 : autorisation de lock EIP-712 du runner, USDC ERC-20 exact, hashlock SHA-256, profil d'entraînement verrouillé, KYB des deux parties, release atomique avant échéance, remboursement et paiements pull-only.
- `SiriusEscrowV7` : devis signé, prépaiement dataset + compute, crédits provider/Sirius séparés, remboursement avec retenue plafonnée des frais attestés. Déployé sur la mainnet (escrow actuel ci-dessus).
- `SiriusKybRegistry` v3 : attestations KYB EIP-712, consenties par le sujet, expirables, révocables et liées à l’époque du vérificateur (domaine EIP-712 version `2`).
- `SiriusDatasetRegistry` v4 à v6 : titre non transférable d'un dataset chiffré, lié au hash de son CID (ou du manifeste d'un gros envoi), à son Merkle root, à sa taille et à son profil d'entraînement. La v6 ajoute une taille maximale réglable par l'admin (jusqu'à 1 Gio) et l'import des titres du registre précédent.

Les contrats, leurs tests et leurs scripts sont dans [`contracts/`](contracts). Les ABI TypeScript sont générées dans [`src/lib/evm/abi/`](src/lib/evm/abi).

## État réel

Le parcours applicatif est EVM-only : wallet EIP-1193, signatures EIP-191/EIP-712, titres dataset, KYB, escrow USDC, runner et audit. Les contrats, leurs tests et leurs scripts couvrent le rail EVM.

Le dernier état applicatif distant documenté est une démonstration sur Robinhood testnet avec calcul dans le processus de l'application. La CVM Phala a été amorcée et attestée, puis arrêtée à la demande de Noé ; son arrêt a été confirmé le 23 septembre 2026 à 13:13 UTC. L'application n'a pas basculé. Le parcours métier réel navigateur/Phala/contrats et le KYB externe restent à valider. Deux modèles historiques ont été récupérés et restaurés hors ligne ; les onze autres appartiennent à d'anciens wallets de test inaccessibles. Voir [l'état des sauvegardes](docs/BACKUP-RECOVERY.md).

L'upload impose un profil proposé par l'instance (`logistic_regression` 1.0.0 ; `gradient_boosted_trees` 1.1.0 et `linear_regression` 1.0.0 seulement s'ils figurent dans `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`) qui est conservé dans le titre, le prêt et les reçus du runner. Un autre algorithme ne peut pas être sélectionné à l'emprunt. La régression linéaire est retirée de tout nouvel usage depuis [D-31](docs/DECISIONS.md#d-31--régression-linéaire-retirée-pour-tout-nouvel-usage-profil-facultatif) ; les datasets et prêts linéaires existants restent servis. Le CSV est limité à 3 Mio ; une cible de classification doit être binaire.

Le [parcours v7](docs/BILLING-INTEGRATION.md) est raccordé : devis signé et accepté, prépaiement, calcul borné, règlement ou remboursement, budget réservé jusqu'à la clôture. Le mode par défaut reste v6 ; v7 exige `SIRIUS_BILLING_VERSION=7`, des politiques et un registre persistants. La migration Prisma est préparée, non appliquée à distance. Aucun tarif commercial n'est fixé.

**Reprise et exploitation préparées :** le résultat v7 enregistré dans SQLite est récupérable après perte de la réponse Next ; les transactions signées sont journalisées sous chiffrement et rediffusées à l'identique dans une limite de trois envois. Les quotas PostgreSQL et l'anti-rejeu sont éprouvés entre huit processus. Une sauvegarde chiffrée de la base réelle a été restaurée et migrée sur PostgreSQL 18 local. Les images et le superviseur d'arrêt sont préparés localement. Voir la [reprise](docs/RECOVERY-OPERATIONS.md) et la [préparation de l'exploitation](docs/OPERATIONS-PREPARATION.md).

**Modèles loués, jamais livrés (état au 7 novembre 2026, staging) :** les trois profils restent chiffrés sur le volume du runner et ne s'utilisent que par prédiction signée EIP-712 ([D-28](docs/DECISIONS.md#d-28--plus-aucune-livraison-de-modèle--prédiction-signée-seule)), validée sur Phala le 2 novembre. Les prêts sont loués à la journée, avec prolongation payante (D-29). L'[API développeurs](docs/DECISIONS.md#d-30--api-développeurs-sur-les-modèles-loués) (D-30 : clés scellées dans l'enclave, quota quotidien inclus, packs d'appels, SDK, `/docs/api`) est fusionnée et déployée sur staging ; la démonstration Phala refuse les prêts, donc l'API n'y est pas active. Location et API restent à valider sur un environnement facturé. État et procédures : [roadmap](docs/ROADMAP.md), [runbook Phala](docs/PHALA-DEMO-RUNBOOK.md).

**Activation toujours bloquée :** restent la coupure avant enregistrement durable du résultat runner, les transactions encore introuvables après les reprises autorisées, la finalité/RPC sur la cible, les plafonds fournisseurs, les tarifs et la validation Phala complète. La sauvegarde reste locale à ce stade. Aucun budget réel n'est approuvé. Les identifiants PostgreSQL sont conservés à la demande de Noé.

La politique d'échec retenue rembourse le dataset et le compute non consommé ; seuls les frais engagés, plafonnés et annoncés sont retenus. Après correction et validation, le prochain déploiement utilisera les contrats retenus et un nouveau registre associé ; aucun v6 intermédiaire n'est prévu pour le seul changement de runner. Conserver les escrows et crédits historiques séparément de la nouvelle identité Phala.

Le [récapitulatif des coûts et business plan](docs/BUSINESS-PLAN.md) centralise les coûts connus, les hypothèses d'exploitation, le budget jusqu'au mainnet et les scénarios de rentabilité. Les prix de vente proposés et les provisions ne sont pas des tarifs actifs ou des dépenses approuvées ; le total des factures historiques reste à réconcilier.

## Démarrage

`pnpm install` lance `prisma generate`, qui exige `DATABASE_URL` ; or `prisma.config.ts` ne lit que `.env` (pas `.env.local`). Sans cette variable, l'installation échoue (`PrismaConfigEnvError`) et chaque `pnpm <script>` la relance. Copier donc la configuration et exporter l'URL **avant** l'installation :

```bash
cp .env.example .env.local                      # puis renseigner DATABASE_URL (PostgreSQL)
export DATABASE_URL="postgresql://…"            # même valeur ; lue par prisma generate
pnpm install --frozen-lockfile
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
pnpm datasets:generate
pnpm test
pnpm test:billing
pnpm test:operations
pnpm lint
pnpm build
```

Les scripts de test posent `NODE_OPTIONS=…` à la manière POSIX et le budget runner exige un dossier en droits `0700` : lancer les tests sous Linux, macOS ou WSL, pas depuis PowerShell ou `cmd.exe`.

Validations du 23 septembre : **308 tests applicatifs, lint, typage et build local réussis** lors de la dernière passe applicative ; **18 tests d'exploitation et lint ciblé réussis** lors de la préparation du budget Phala. Les passes précédentes ont aussi validé 79 tests contrats, 62 tests navigateur, le typage v7, un parcours EVM de facturation et les admissions PostgreSQL 17 entre huit processus. La restauration réelle et ses migrations ont été vérifiées sur PostgreSQL 18 local. Aucun parcours complet à deux vrais wallets sur Phala actif n'est validé.

Après résolution des bloqueurs et validation de la migration, le guide de déploiement testnet prévoit `ROBINHOOD_DEPLOYER_KEY` et éventuellement `EVM_RPC_URL` pour le script de déploiement (`ROBINHOOD_TESTNET_RPC` concerne le réseau Hardhat), puis :

```bash
pnpm contracts:deploy:testnet
```

Reporter les adresses affichées dans les variables serveur `SIRIUS_*_ADDRESS` **et** publiques `NEXT_PUBLIC_SIRIUS_*_ADDRESS`, sans changer l'USDC associé. Le smoke historique `contracts:smoke` refuse v7 : valider cette version par son parcours runner complet, sans exporter sa clé. La procédure détaillée est dans [docs/DEMO.md](docs/DEMO.md).

## Branches et connexion

`staging` déploie `sirius-evm-staging.vercel.app` ; `main` déploie `sirius-data.tech` avec `sirius-evm.vercel.app` comme alias. La pipeline configure automatiquement le domaine du sign-in et celui du navigateur avant chaque build. Fusionner sur main ne nécessite pas de modifier ces variables à la main et ne bascule pas le réseau EVM sur mainnet.

Le rechargement de l'accueil conserve le blob et restaure la session sans redirection automatique vers le dashboard. Les erreurs de challenge affichent désormais leur cause. Les fichiers `.env*`, le lien `.vercel` et le stockage du navigateur persistent lors d'un changement de branche : voir le [guide de déploiement et des pièges de branche](docs/DEPLOYMENT.md).

## Documentation

- [Architecture EVM](docs/ARCHITECTURE.md)
- [Décisions techniques](docs/DECISIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Plan produit et passage au mainnet](docs/MAINNET-PLAN.md)
- [Coûts totaux, business plan et rentabilité](docs/BUSINESS-PLAN.md)
- [Audit approfondi du 23 septembre — suivi des correctifs](docs/AUDIT-2026-09-23.md)
- [Reprise des résultats, transactions et registres](docs/RECOVERY-OPERATIONS.md)
- [Préparation de l'exploitation, sauvegardes et coûts](docs/OPERATIONS-PREPARATION.md)
- [Exercice de restauration (archive ; récupération des modèles abandonnée par D-28)](docs/BACKUP-RECOVERY.md)
- [Intégration du parcours de facturation](docs/BILLING-INTEGRATION.md)
- [Politique de facturation et protection du PnL](docs/COMPUTE-BILLING.md)
- [Escrow v7](docs/ESCROW-V7.md) et [budgets persistants du runner](docs/RUNNER-BUDGETS.md)
- [Démo et déploiement testnet](docs/DEMO.md)
- [Branches, origines et authentification](docs/DEPLOYMENT.md)
- [Runner Phala](docs/PHALA.md)
- [Audit des correctifs et limites de validation](docs/AUDIT-CORRECTIFS.md)
- [Audit staging du 12 septembre et suivi](docs/AUDIT-STAGING-2026-09-12.md)
- [Correctifs F1–F4 et migration Escrow v6 — référence historique](docs/ESCROW-V6.md)
- [Correctifs de l’audit du 13 septembre et validation](docs/AUDIT-CORRECTIFS-2026-09-13.md)
