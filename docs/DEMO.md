# Démo EVM locale et testnet

## Préparation

Copier l'environnement puis renseigner au minimum :

- `EVM_NETWORK="testnet"` ;
- `ROBINHOOD_DEPLOYER_KEY` avec un compte testnet financé ;
- `ROBINHOOD_TESTNET_RPC` si le RPC public ne convient pas ;
- `NEXT_PUBLIC_SIRIUS_USDC_ADDRESS` et `SIRIUS_USDC_CODE_HASH`, issus de l'USDC testnet officiel ;
- `SIRIUS_KYB_ADMIN`, `SIRIUS_KYB_VERIFIER` et `SIRIUS_SMOKE_PROVIDER_ADDRESS` ;
- `SIRIUS_MASTER_KEY`, `SIRIUS_SESSION_SECRET` et `RUNNER_TRANSPORT_SECRET` ;
- `PINATA_JWT` et `PINATA_GATEWAY` pour le parcours IPFS ;
- les quatre adresses une fois le déploiement effectué : escrow, USDC, KYB et dataset.

Ne jamais utiliser de clé mainnet pour une démo.

## Vérification locale des contrats

```bash
pnpm install --frozen-lockfile
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
```

Ces commandes valident les contrats et régénèrent les ABI TypeScript. Elles ne déploient rien.

## Déploiement testnet

```bash
pnpm contracts:deploy:testnet
```

Le script affiche les adresses de `SiriusEscrow`, `SiriusKybRegistry` et `SiriusDatasetRegistry`. Reporter ces valeurs dans `.env.local` :

```dotenv
NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS="0x..."
NEXT_PUBLIC_SIRIUS_USDC_ADDRESS="0x..."
NEXT_PUBLIC_SIRIUS_KYB_ADDRESS="0x..."
NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS="0x..."
SIRIUS_ESCROW_ADDRESS="0x..."
SIRIUS_USDC_ADDRESS="0x..."
SIRIUS_KYB_ADDRESS="0x..."
SIRIUS_DATASET_ADDRESS="0x..."
```

`SIRIUS_ESCROW_ADDRESS` est la valeur serveur utilisée pour lier la dérivation du préimage au déploiement précis. Elle doit désigner le même contrat que la valeur publique.

Le script vérifie le code de l'USDC configuré contre `SIRIUS_USDC_CODE_HASH` et refuse un escrow existant : chaque déploiement crée un nouveau trio KYB, escrow et dataset cohérent. L'émetteur KYB doit signer les attestations des wallets hors de l'application avant le smoke.

## Smoke on-chain

```bash
pnpm contracts:smoke
```

Le smoke exige un borrower et un provider déjà attestés. Il exerce l'approbation USDC, le verrouillage, le release et le retrait du crédit. Il doit être exécuté avant d'intégrer les adresses dans une instance partagée.

## Parcours applicatif

Le parcours navigateur est EVM-only. La validation locale couvre séparément les contrats, le runner et l'application :

```bash
pnpm test
pnpm lint
pnpm build
docker compose --env-file .env.local up --detach --wait --build
pnpm runner:smoke
```

La validation complète reste conditionnée à un déploiement testnet, deux wallets KYB et un runner Phala attesté.
