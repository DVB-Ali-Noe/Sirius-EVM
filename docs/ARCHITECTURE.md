# Architecture

## Principe

Sirius sépare strictement données, calcul et règlement. Le dataset reste chiffré sur IPFS, le calcul s'exécute dans un TEE Phala et les états économiques sont portés par trois contrats EVM sur Robinhood Chain.

Le testnet cible est `46630` ; le mainnet cible est `4663`. Le réseau, le RPC et les adresses sont lus depuis l'environnement par [`src/lib/evm/networks.ts`](../src/lib/evm/networks.ts).

## Contrats

| Contrat | Responsabilité | Propriétés clés |
|---|---|---|
| `SiriusEscrow` | Règlement d'un prêt | USDC ERC-20 exact, hashlock SHA-256, KYB des deux parties, liaison obligatoire au registre dataset, `release` avant l'échéance, états exclusifs et crédit pull-only |
| `SiriusKybRegistry` | Conformité KYB | attestations EIP-712, consentement du sujet, expiration, révocation et époque de vérificateur |
| `SiriusDatasetRegistry` | Titre d'un dataset | identité déterministe, KYB bloquant, hash de CID/Merkle root/taille, tombstone après crypto-shredding |

Le titre n'est pas un NFT transférable : il représente la provenance d'un dataset et non un actif de spéculation.

## Parcours de règlement

1. Le provider chiffre le dataset dans le navigateur pour la clé d'ingestion du runner. Next ne reçoit pas le CSV en clair.
2. Le runner scelle une DEK par dataset, stocke le blob chiffré sur IPFS et signe son reçu.
3. Le provider publie le titre du dataset via `SiriusDatasetRegistry.mint` après validation KYB ; seuls les hash du `datasetId` et du CID entrent dans la transaction.
4. Le runner dérive un préimage de 32 octets, son hashlock et un `loanKey` lié au borrower et au hash du `loanId`.
5. Le borrower et le provider doivent détenir un KYB valide. Le borrower approuve l'escrow puis appelle `SiriusEscrow.lock` avec les USDC, le provider, le hashlock, la durée de challenge et le hash du `loanId`.
6. Avant de calculer, le runner vérifie le KYB des deux parties, le titre `matchesScope` du dataset et les termes de l'escrow.
7. Après l'entraînement, le runner chiffre la clé modèle dans une capsule liée à une clé ECDH du navigateur et au préimage. Il atteste un payload canonique qui lie modèle/version, scope EVM, CID et hash de capsule ; en Phala, la quote TDX et son evidence sont vérifiées puis persistées. Le borrower persiste cette capsule.
8. Avant l'échéance, le runner appelle `release(loanKey, preimage)`. Le préimage devient public et le provider est crédité atomiquement.
9. Si aucun modèle n'est livré, `refund(loanKey)` devient possible après l'échéance. Le borrower récupère ensuite son crédit avec `withdraw`.

Le contrat vérifie le delta de solde à chaque transfert USDC et n'accepte donc ni token à frais ni transfert silencieux. Il n'effectue aucun transfert externe pendant `release` ou `refund` : les fonds sont crédités puis retirés séparément.

## Séparation de domaine

Le préimage est dérivé dans le TEE avec le `chainId`, l'adresse du contrat escrow, le borrower et le `loanId`. Cette liaison empêche qu'un préimage révélé sur un déploiement ou un réseau ouvre une capsule destinée à un autre.

Les attestations KYB utilisent EIP-712 : le domaine inclut lui aussi le `chainId` et l'adresse de `SiriusKybRegistry`.

## Frontières de confiance

- Le navigateur chiffre le dataset avant transit et conserve la clé privée ECDH non exportable de livraison.
- Le runner Phala est le seul détenteur de la master key dstack ; il ouvre le dataset, entraîne le modèle, génère le préimage et signe les reçus.
- Next orchestre, persiste l'état applicatif et vérifie les attestations, mais ne reçoit ni la donnée brute ni les secrets de règlement.
- `RUNNER_TRANSPORT_SECRET` authentifie le canal Next→runner sans conférer d'autorité métier.
- Les grants wallet P-256 sont scopés, expirables et protégés contre le rejeu.

## Organisation du code

```text
contracts/
  src/                    # SiriusEscrow, SiriusKybRegistry, SiriusDatasetRegistry
  test/                   # invariants et scénarios hostiles
  scripts/                # compile, export ABI, déploiement et smoke
src/
  lib/evm/                # réseau, adresses, montants, signatures, client et escrow
  lib/tee/                # cœur sans DB, liaison EVM, chiffrement et attestation
  runner/                 # opérations confidentielles et règlement du runner
  lib/sirius/             # orchestration applicative et persistance
```

## État de migration

La migration applicative est EVM-only. La validation sur testnet avec des wallets réels et une CVM Phala reste requise. Voir [ROADMAP.md](ROADMAP.md).

## Sécurité et production

- L'émetteur KYB signe hors de Next et du runner, idéalement depuis un HSM/KMS. Sans lui, aucun wallet ne peut obtenir de KYB depuis l'application.
- Les contrats sont testés localement, mais ne sont pas déclarés prêts mainnet sans déploiement testnet, revue externe et parcours réel complet.
- Le runner Phala doit être déployé avec RA-TLS, quote TDX, replay RTMR3 et valeurs d'attestation épinglées côté Next.
- Les adresses de contrat, le réseau attendu et le RPC sont des paramètres de déploiement : aucune valeur vide ne doit atteindre une instance de production.
