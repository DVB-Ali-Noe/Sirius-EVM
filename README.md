# Sirius

**Louer des datasets de valeur sans jamais les exposer.**

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

- `SiriusEscrow` : USDC ERC-20 exact, hashlock SHA-256, KYB des deux parties, release atomique avant échéance, remboursement et paiements pull-only.
- `SiriusKybRegistry` : attestations KYB EIP-712, consenties par le sujet, expirables, révocables et invalidées durablement au retrait d'un vérificateur.
- `SiriusDatasetRegistry` : titre non transférable d'un dataset chiffré, lié au hash de son CID, à son Merkle root et à sa taille.

Les contrats, leurs tests et leurs scripts sont dans [`contracts/`](contracts). Les ABI TypeScript sont générées dans [`src/lib/evm/abi/`](src/lib/evm/abi).

## État réel

Le parcours applicatif est EVM-only : wallet EIP-1193, signatures EIP-191/EIP-712, titres dataset, KYB, escrow USDC, runner et audit. Les contrats, leurs tests et leurs scripts couvrent le rail EVM.

Les trois contrats sont déployés sur le testnet Robinhood et l'instance publique tourne en mode démonstration : le calcul confidentiel s'exécute dans le processus de l'application, sans enclave attestée. Le parcours réel navigateur/runner/contrats, un émetteur KYB externe et la CVM Phala restent à valider. La roadmap ne présente donc pas encore le produit comme validé sur une enclave réelle.

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
