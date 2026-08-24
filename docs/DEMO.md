# Démo EVM locale et testnet

## Préparation

Copier l'environnement puis renseigner au minimum :

- `EVM_NETWORK="testnet"` ;
- `ROBINHOOD_DEPLOYER_KEY` avec un compte testnet financé ;
- `ROBINHOOD_TESTNET_RPC` si le RPC public ne convient pas ;
- `SIRIUS_MASTER_KEY`, `SIRIUS_SESSION_SECRET` et `RUNNER_TRANSPORT_SECRET` ;
- `PINATA_JWT` et `PINATA_GATEWAY` pour le parcours IPFS ;
- les trois adresses de contrats une fois le déploiement effectué.

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
NEXT_PUBLIC_SIRIUS_KYB_ADDRESS="0x..."
NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS="0x..."
SIRIUS_ESCROW_ADDRESS="0x..."
```

`SIRIUS_ESCROW_ADDRESS` est la valeur serveur utilisée pour lier la dérivation du préimage au déploiement précis. Elle doit désigner le même contrat que la valeur publique.

## Smoke on-chain

```bash
pnpm contracts:smoke
```

Le smoke exerce le déploiement, l'attestation KYB, le titre de dataset, le verrouillage, le release, le remboursement et les retraits de crédit. Il doit être exécuté avant d'intégrer les adresses dans une instance partagée.

## Parcours applicatif

Le rail EVM du runner est implémenté, mais le parcours navigateur complet est encore en migration. La validation locale actuelle couvre donc séparément les contrats, le runner et l'application :

```bash
pnpm test
pnpm lint
pnpm build
docker compose --env-file .env.local up --detach --wait --build
pnpm runner:smoke
```

La démo de bout en bout devient valide uniquement après le branchement des écrans et routes sur les contrats EVM listés dans la [roadmap](ROADMAP.md).
