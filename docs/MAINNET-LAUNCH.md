# Journal du lancement mainnet

Journal d'exécution du [plan de lancement](MAINNET-LAUNCH-PLAN.md). Une entrée par action réalisée, avec sa preuve. Aucun secret : adresses publiques, hashes, noms de variables et sorties de commande uniquement.

## Références publiques

| Élément | Valeur |
|---|---|
| Réseau | Robinhood Chain mainnet, chainId `4663` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| USDC | `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8`, 6 décimales |
| Safe 2 sur 2 | à renseigner |
| Clé de déploiement (adresse publique) | à renseigner |
| Vérificateurs KYB | à renseigner (deux adresses) |
| CVM de production | à renseigner (identifiant, app ID) |
| Adresse de règlement attestée | à renseigner |
| `SiriusKybRegistry` | à renseigner |
| `SiriusDatasetRegistry` | à renseigner |
| `SiriusEscrowV7` | à renseigner |
| Base Neon mainnet | à renseigner (nom du projet) |

## Suivi des lots

| Lot | Propriétaire | Branche | PR | État |
|---|---|---|---|---|
| N1 Coupe-circuit | Noé | `fix/budget-failures` | | à faire |
| N2 Finalité | Noé | `fix/finality-pending` | | à faire |
| N3 Échec transitoire | Noé | `fix/budget-failures` | | à faire |
| N4 Transaction rejetée | Noé | `fix/finality-pending` | | à faire |
| N5 Outillage runner | Noé | `feat/mainnet-runner-tooling` | | à faire |
| N6 Script de déploiement | Noé | `feat/mainnet-runner-tooling` | | à faire |
| N7 CVM de production | Noé | — | | à faire |
| N8 Contrats mainnet | Noé | — | | à faire |
| A1 Wallet Google | Ali | `fix/wallet-next` | | à faire |
| A2 Next.js | Ali | `fix/wallet-next` | | à faire |
| A3 Plafonds | Ali | `feat/mainnet-caps` | | à faire |
| A4 Connexion | Ali | `fix/auth-siwe` | | à faire |
| A5 Limiteur | Ali | `fix/auth-siwe` | | à faire |
| A6 Garde base / chaîne | Ali | `feat/mainnet-db-guard` | | à faire |
| A7 Reaper | Ali | `feat/mainnet-db-guard` | | à faire |
| A8 Préflight mainnet | Ali | `feat/mainnet-preflight` | | à faire |
| A9 Interface mainnet | Ali | `feat/mainnet-caps` | | à faire |
| A10 KYB sur invitation | Ali | `feat/kyb-invite` | | à faire |
| A11 Lancement | Ali | — | | à faire |

## Mesure de finalité mainnet

| Date et heure (UTC) | Bloc tête | Bloc `finalized` | Retard (min) |
|---|---|---|---|

## Entrées

### 1er octobre 2026

- Plan de lancement établi et publié dans `docs/`.
