# Sirius

**Entraîner sur des datasets confidentiels et livrer le modèle.**

Sirius est un protocole de data lending confidentiel. Le provider conserve son dataset chiffré ; le borrower soumet un entraînement dans un **TEE** et ne récupère que le modèle produit. Les garanties de règlement et d'audit reposent sur des contrats **EVM** déployables sur Robinhood Chain.

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
  │◄── SiriusEscrow.release ────┼── règlement confirmé ─────────►│ clé livrée en v7
  │    crédit provider          │                               │
```

En v6, le runner produit une capsule que le préimage publié permet d'ouvrir. En v7, il ne transmet pas cette capsule à Next : la clé du modèle est livrée après vérification du règlement canonique et des confirmations configurées. `release` crédite le provider et, en v7, la trésorerie compute. `refund` reste possible après l'échéance si le prêt est encore verrouillé, en déduisant les frais déjà attestés on-chain en v7. Wallet et Dashboard permettent le retrait séparé des crédits. Le préimage est transmis au RPC avant inclusion ; les limites de finalité sont détaillées dans le [suivi de l'audit](docs/AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026).

## Stack

| Couche | Technologie |
|---|---|
| Application | Next.js 16.3.5 · React 19 · Tailwind 4 · Prisma / PostgreSQL |
| Chaîne | Robinhood Chain, EVM Arbitrum Nitro · testnet `46630` · mainnet `4663` |
| Contrats | Solidity `0.8.24` · Hardhat · viem |
| Calcul confidentiel | Phala dstack, runner HTTP isolé, RA-TLS |
| Stockage | IPFS / Pinata · AES-256-GCM |

## Contrats EVM

- `SiriusEscrow` v6 : autorisation de lock EIP-712 du runner, USDC ERC-20 exact, hashlock SHA-256, profil d'entraînement verrouillé, KYB des deux parties, release atomique avant échéance, remboursement et paiements pull-only.
- `SiriusEscrowV7` : devis signé, prépaiement dataset + compute, crédits provider/Sirius séparés, remboursement avec retenue plafonnée des frais attestés. Intégration locale, activation explicite ; aucun déploiement public v7 effectué.
- `SiriusKybRegistry` v3 : attestations KYB EIP-712, consenties par le sujet, expirables, révocables et liées à l’époque du vérificateur (domaine EIP-712 version `2`).
- `SiriusDatasetRegistry` v4 : titre non transférable d'un dataset chiffré, lié au hash de son CID, à son Merkle root, à sa taille et à son profil d'entraînement.

Les contrats, leurs tests et leurs scripts sont dans [`contracts/`](contracts). Les ABI TypeScript sont générées dans [`src/lib/evm/abi/`](src/lib/evm/abi).

## État réel

Le parcours applicatif est EVM-only : wallet EIP-1193, signatures EIP-191/EIP-712, titres dataset, KYB, escrow USDC, runner et audit. Les contrats, leurs tests et leurs scripts couvrent le rail EVM.

Le dernier état distant documenté est une démonstration sur Robinhood testnet avec calcul dans le processus de l'application. La CVM Phala a été amorcée et attestée, puis arrêtée à la demande de Noé ; l'application n'a pas basculé. Le parcours métier réel navigateur/Phala/contrats, le KYB externe et les historiques restent à valider. Cet état distant n'a pas été réinterrogé pendant l'audit local.

L'upload impose un profil (`linear_regression` ou `logistic_regression`, version `1.0.0`) qui est conservé dans le titre, le prêt et les reçus du runner. Un autre algorithme ne peut pas être sélectionné à l'emprunt. Le CSV est limité à 3 Mio ; une cible logistique doit être binaire.

Le [parcours v7](docs/BILLING-INTEGRATION.md) est raccordé : devis signé et accepté, prépaiement, calcul borné, règlement ou remboursement, budget réservé jusqu'à la clôture. Le mode par défaut reste v6 ; v7 exige `SIRIUS_BILLING_VERSION=7`, des politiques et un registre persistants. La migration Prisma est préparée, non appliquée à distance. Aucun tarif commercial n'est fixé.

**Activation toujours bloquée :** les correctifs locaux couvrent les transactions confirmées après timeout, le règlement autonome d'un résultat v7 persisté, le devis obligatoire et le filtrage des réponses API. Restent le crash entre calcul et persistance, la finalité/RPC sur le réseau cible, les anciennes sauvegardes de clés, les validations PostgreSQL/Phala et la calibration économique. Voir le [suivi de l'audit](docs/AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026).

La politique d'échec retenue rembourse le dataset et le compute non consommé ; seuls les frais engagés, plafonnés et annoncés sont retenus. Après correction et validation, le prochain déploiement utilisera les contrats retenus et un nouveau registre associé ; aucun v6 intermédiaire n'est prévu pour le seul changement de runner. Conserver les escrows, crédits et clés des modèles historiques séparément de la nouvelle identité Phala.

## Démarrage

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
pnpm datasets:generate
pnpm test
pnpm test:billing
pnpm lint
pnpm build
```

Validation locale du 23 septembre après correctifs : **293 tests applicatifs, 79 tests contrats, 62 tests navigateur et un parcours EVM de facturation réussis**, ainsi que lint, typages application/v7 et build. Aucun parcours complet à deux vrais wallets sur Phala actif n'est validé.

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
- [Audit approfondi du 23 septembre — suivi des correctifs](docs/AUDIT-2026-09-23.md)
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
