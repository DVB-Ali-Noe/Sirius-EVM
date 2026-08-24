# Décisions

## D-1 — Nouveau dépôt et migration EVM explicite

Le dépôt repart avec un historique propre. La documentation décrit uniquement la cible EVM et l'état présent de son implémentation ; elle ne traite pas les mécanismes historiques comme une dépendance produit.

## D-2 — Robinhood Chain comme réseau cible

Sirius cible Robinhood Chain, un réseau EVM basé sur Arbitrum Nitro : testnet `46630`, puis mainnet `4663`. `viem` porte les clients RPC, la normalisation d'adresses, les signatures et les appels de contrat.

Le testnet est obligatoire avant toute décision mainnet. Le script de déploiement exige une autorisation explicite pour le mainnet.

## D-3 — Trois contrats spécialisés

- `SiriusEscrow` règle un prêt hashlocké en USDC ERC-20.
- `SiriusKybRegistry` gère les attestations KYB EIP-712.
- `SiriusDatasetRegistry` ancre la provenance d'un dataset chiffré.

Cette séparation réduit les surfaces d'autorité : l'escrow n'a ni admin ni upgrade ; la gouvernance des vérificateurs KYB ne peut pas déplacer les fonds ; le registre de dataset ne peut pas modifier un prêt.

## D-4 — Fair-exchange par hashlock et paiements pull-only

Le TEE ne révèle un préimage SHA-256 qu'après production du modèle. `release` publie ce préimage et crédite le provider dans la même transaction. La capsule du borrower exige le préimage, ce qui lie livraison et règlement.

Les fonds sont retirés par `withdraw` après crédit. Un provider qui rejette les transferts ne peut donc ni casser une libération ni provoquer une réentrance pendant le changement d'état.

## D-5 — Séparation de domaine obligatoire

Le préimage dépend du réseau et de l'adresse du contrat escrow, en plus du borrower et du prêt. Les attestations KYB sont signées sous un domaine EIP-712 lié au `chainId` et au contrat. Aucun secret ni signature ne doit être réutilisable entre deux déploiements.

## D-6 — KYB par entité

Une adresse possède une attestation KYB, indépendamment de son rôle. Le même wallet peut publier un dataset et en emprunter un autre. L'attestation est consentie par le sujet, peut expirer et peut être révoquée par son vérificateur.

## D-7 — Registre de dataset, pas NFT

Le titre on-chain est non transférable. Il contient uniquement le hash du CID du contenu déjà chiffré, son Merkle root et sa taille ; le nom, la description et le CID restent hors chaîne afin de ne jamais inscrire de donnée libre et permanente.

Le crypto-shredding détruit la clé de dataset et laisse un tombstone on-chain : la donnée devient irrécupérable, tandis que la preuve d'existence demeure auditable.

## D-8 — TEE-first

La donnée brute, la master key et le préimage restent dans le runner Phala. Next garde l'orchestration et la base applicative hors enclave. Le runner possède un contrat HTTP explicite, des limites de charge, un registre anti-rejeu persistant et une attestation vérifiable.

## D-9 — Migration par étapes

Le parcours produit est EVM-only : wallet EIP-1193, signatures EIP-191/EIP-712, publication, KYB, USDC, runner et audit. La roadmap distingue le code présent d'une validation testnet réelle.

## D-10 — Production après validation réelle

Avant le mainnet : déployer les trois contrats sur testnet, vérifier leurs adresses et ABI, financer le compte de règlement du runner, exécuter un prêt réel avec deux wallets et rejouer les scénarios de remboursement, récupération de modèle et crypto-shredding. Une revue de contrats indépendante est requise avant toute utilisation avec des fonds réels.
