# Roadmap EVM

Cette roadmap reflète le code présent dans ce dépôt. Une case cochée signifie que la brique est implémentée localement, pas qu'elle a été validée sur un réseau public.

## Socle EVM — implémenté

- [x] Définition de Robinhood Chain testnet `46630` et mainnet `4663` dans `src/lib/evm/networks.ts`.
- [x] Client RPC `viem`, normalisation EIP-55 des adresses, validation des montants en wei et vérification de signatures EVM.
- [x] `SiriusEscrow` : verrouillage ETH, hashlock SHA-256, release, remboursement, crédits pull-only et protections contre les scénarios de paiement hostiles.
- [x] `SiriusKybRegistry` : attestations KYB EIP-712, révocation, expiration et gestion des vérificateurs.
- [x] `SiriusDatasetRegistry` : ancrage d'un dataset chiffré, KYB bloquant et tombstone après destruction.
- [x] Tests Hardhat, scripts de compilation, export ABI, déploiement et smoke test des contrats.
- [x] Liaison EVM dans le runner : dérivation du préimage liée au contrat et au réseau, contrôle `matchesScope`, règlement, réconciliation et re-livraison de clé modèle.

## Migration produit — en cours

- [ ] Déployer les trois contrats sur Robinhood Chain testnet et renseigner leurs adresses dans `.env.local`.
- [ ] Financer et vérifier le compte EVM dérivé du runner, utilisé pour appeler `release` et `refund`.
- [ ] Brancher le wallet navigateur EVM sur les appels `mint`, `lock`, `withdraw` et les attestations KYB.
- [ ] Migrer les routes et écrans dataset, marketplace, entraînement, audit et wallet sur les données et événements EVM.
- [ ] Retirer les chemins historiques restants de l'application, du runner et du manifeste de déploiement.
- [ ] Remplacer les variables historiques dans `deploy/phala/compose.yaml` par `EVM_NETWORK`, `EVM_RPC_URL` et l'adresse serveur de `SiriusEscrow`.
- [ ] Ajouter des tests d'intégration navigateur/runner/contrats sur un nœud EVM local puis sur testnet.

## Validation testnet — à faire

- [ ] Déployer et exécuter `pnpm contracts:smoke` avec les adresses réellement publiées.
- [ ] Attester un provider et un borrower via `SiriusKybRegistry`.
- [ ] Publier un dataset chiffré, verrouiller un prêt en ETH, entraîner dans le TEE et régler avec `release`.
- [ ] Vérifier l'ouverture de la capsule uniquement après publication du préimage.
- [ ] Vérifier le remboursement après échéance et le retrait des crédits par les deux parties.
- [ ] Vérifier le crypto-shredding et le tombstone du registre dataset.
- [ ] Rejouer les reprises après timeout et les scénarios de conflit de réseau ou d'adresse de contrat.

## Phala et production — à faire

- [ ] Construire et publier l'image immuable du runner.
- [ ] Déployer une CVM Phala stable, capturer les mesures RA-TLS et épingler les valeurs côté Next.
- [ ] Vérifier la persistance de la master key et du compte de règlement EVM au redémarrage de la même CVM.
- [ ] Exécuter le smoke RA-TLS avec un RPC EVM et des contrats testnet.
- [ ] Faire revoir les contrats et le flux de règlement avant activation mainnet.
- [ ] Obtenir une validation manuelle complète avant toute utilisation avec des fonds réels.

## Post-MVP

- [ ] Jobs asynchrones pour entraînements longs.
- [ ] Budget de confidentialité différentiel et métriques vérifiables.
- [ ] Arbitrage des litiges de qualité.
- [ ] Découverte de datasets et données synthétiques, sans exposer de donnée brute hors TEE.
