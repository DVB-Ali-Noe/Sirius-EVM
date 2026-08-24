# Sirius

**Louer des datasets de valeur sans jamais les exposer.**

Sirius est un protocole de data lending confidentiel. Le provider conserve son dataset chiffré ; le borrower soumet un entraînement dans un **TEE** et ne récupère que le modèle produit. Les garanties de règlement et d'audit reposent sur des contrats **EVM** déployables sur Robinhood Chain.

## Principe

```text
Provider                 Robinhood Chain                     Borrower
  │                             │                               │
  ├─ dataset chiffré → IPFS     │                               │
  ├─ SiriusDatasetRegistry.mint │                               │
  │                             │◄── SiriusEscrow.lock (ETH) ────┤
  │                             │                               │
  │           Phala TEE : déchiffre, entraîne, atteste          │
  │                             │                               │
  │◄── SiriusEscrow.release ────┼── préimage public ───────────►│ capsule ouverte
  │    crédit provider          │                               │
```

Le runner ne révèle le préimage qu'après avoir produit le modèle et une capsule persistable par le borrower. `release` crédite alors le provider dans la même transaction ; `refund` restitue les fonds au borrower après l'échéance si aucun préimage n'a été publié.

## Stack

| Couche | Technologie |
|---|---|
| Application | Next.js 16 · React 19 · Tailwind 4 · Prisma / SQLite |
| Chaîne | Robinhood Chain, EVM Arbitrum Nitro · testnet `46630` · mainnet `4663` |
| Contrats | Solidity `0.8.24` · Hardhat · viem |
| Calcul confidentiel | Phala dstack, runner HTTP isolé, RA-TLS |
| Stockage | IPFS / Pinata · AES-256-GCM |

## Contrats EVM

- `SiriusEscrow` : hashlock SHA-256, verrouillage en ETH, release atomique, remboursement et paiements pull-only.
- `SiriusKybRegistry` : attestations KYB EIP-712, consenties par le sujet, expirables et révocables.
- `SiriusDatasetRegistry` : titre non transférable d'un dataset chiffré, lié à son CID, son Merkle root et sa taille.

Les contrats, leurs tests et leurs scripts sont dans [`contracts/`](contracts). Les ABI TypeScript sont générées dans [`src/lib/evm/abi/`](src/lib/evm/abi).

## État réel

Le socle EVM est implémenté : réseaux, contrats Solidity, tests Hardhat, génération d'ABI, scripts de déploiement/smoke et opérations EVM du runner (`hashlock`, contrôle on-chain, règlement et réconciliation).

La migration produit n'est pas terminée : les adresses doivent être déployées et configurées sur testnet, puis les parcours navigateur et API doivent utiliser ce rail de bout en bout. La roadmap ne présente donc pas encore le produit comme déployé ni validé sur une chaîne publique.

## Démarrage

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
pnpm test
pnpm lint
pnpm build
```

Pour déployer sur le testnet, renseigner `ROBINHOOD_DEPLOYER_KEY` et, si nécessaire, `ROBINHOOD_TESTNET_RPC`, puis :

```bash
pnpm contracts:deploy:testnet
pnpm contracts:smoke
```

Reporter les trois adresses affichées dans les variables `NEXT_PUBLIC_SIRIUS_*_ADDRESS`. La procédure détaillée est dans [docs/DEMO.md](docs/DEMO.md).

## Documentation

- [Architecture EVM](docs/ARCHITECTURE.md)
- [Décisions techniques](docs/DECISIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Démo et déploiement testnet](docs/DEMO.md)
- [Runner Phala](docs/PHALA.md)
