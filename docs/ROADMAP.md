# Roadmap EVM

Cette roadmap reflète le code présent dans ce dépôt. Une case cochée signifie que la brique est implémentée localement, pas qu'elle a été validée sur un réseau public.

## Socle EVM — implémenté

- [x] Définition de Robinhood Chain testnet `46630` et mainnet `4663` dans `src/lib/evm/networks.ts`.
- [x] Client RPC `viem`, normalisation EVM des adresses, validation des montants USDC et vérification de signatures EVM.
- [x] `SiriusEscrow` : verrouillage USDC ERC-20 exact, hashlock SHA-256, KYB des deux parties, release avant échéance, remboursement, crédits pull-only et transferts sûrs.
- [x] `SiriusKybRegistry` : attestations KYB EIP-712, révocation durable, expiration et gestion des vérificateurs.
- [x] `SiriusDatasetRegistry` : ancrage d'un dataset chiffré, KYB bloquant et tombstone après destruction.
- [x] Tests Hardhat, scripts de compilation, export ABI, déploiement et smoke test USDC.
- [x] Liaison EVM dans le runner : dérivation du préimage liée au contrat et au réseau, contrôle KYB + `matchesScope` + escrow, règlement et re-livraison de clé modèle.

## Migration produit — en cours

- [x] Déployer les trois contrats durcis sur Robinhood Chain testnet et renseigner leurs adresses dans `.env.local`.
- [ ] Configurer l'émetteur KYB externe et sa clé HSM/KMS ; l'application ne signe plus d'attestation KYB.
- [ ] Financer et vérifier le compte EVM dérivé du runner, utilisé pour appeler `release` ; le wallet du borrower signe `refund`.
- [x] Brancher le wallet navigateur EVM sur les appels `mint`, `approve`, `lock`, `withdraw` et les attestations KYB.
- [x] Migrer les routes et écrans dataset, marketplace, entraînement, audit et wallet sur les données et événements EVM.
- [x] Retirer les chemins historiques de l'application, du runner et du manifeste de déploiement.
- [x] Remplacer le manifeste Phala par `EVM_NETWORK`, `EVM_RPC_URL` et les adresses de contrats EVM.
- [x] Imposer le profil d'entraînement à l'upload et le lier au titre DatasetRegistry v4, à l'Escrow v5 et aux reçus du runner.
- [x] Reprendre les locks abandonnés et conserver le déploiement des nouveaux prêts ; permettre la livraison des modèles historiques autorisés.
- [x] Remboursement signé dans le wallet sans master key côté Next ; logs techniques sans préimage ni jeton RPC brut.
- [x] Préflight de migration on-chain, protection contre les transactions en attente et limite d'upload compatible avec l'hébergement Vercel.
- [x] Configurer automatiquement les origines du sign-in par branche, avec des alias explicites et des builds navigateur distincts.
- [x] Conserver le blob au rechargement de l'accueil et afficher les causes des erreurs d'authentification.
- [x] Tester la sélection des cibles, l'isolation des origines et la clé d'ingestion sur les alias ; ajouter un smoke de challenge à la pipeline.
- [ ] Ajouter des tests d'intégration navigateur/runner/contrats sur un nœud EVM local puis sur testnet.

## Correctifs locaux — audit du 12 septembre

- [x] Réabonner le connecteur aux événements du wallet sélectionné (F1).
- [x] Invalider les réponses datasets obsolètes après changement de compte, y compris la pagination (F2).
- [x] Harmoniser le login avec les délégations EOA ; refuser clairement les comptes contractuels non supportés (F3).
- [x] Exiger une autorisation EIP-712 du runner pour les locks v6, avec renouvellement borné après approve (F4).

Preuves, priorités et limites : [audit staging du 12 septembre](AUDIT-STAGING-2026-09-12.md).

## Validation testnet — à faire

- [ ] Effectuer la [migration Escrow v6](ESCROW-V6.md), exécuter son préflight indépendant et republier les datasets avant réouverture.

- [ ] Déployer et exécuter `pnpm contracts:smoke` avec les adresses réellement publiées.
- [ ] Attester un provider et un borrower via l'émetteur KYB externe puis `SiriusKybRegistry`.
- [ ] Publier un dataset chiffré, verrouiller un prêt en USDC, entraîner dans le TEE et régler avec `release`.
- [ ] Vérifier l'ouverture de la capsule uniquement après publication du préimage.
- [ ] Vérifier le remboursement après échéance et le retrait des crédits par les deux parties.
- [ ] Vérifier le crypto-shredding et le tombstone du registre dataset.
- [ ] Rejouer les reprises après timeout et les scénarios de conflit de réseau ou d'adresse de contrat.
- [ ] Appliquer `20260905010000_track_loan_deployment` et configurer l'historique des escrows sur staging ; valider les correctifs de [l'audit du 5 septembre](AUDIT-CORRECTIFS.md) dans le navigateur.
- [ ] Valider après publication les challenges sur le domaine staging et ses alias, puis répéter après fusion sur main ; vérifier DNS et session réelle. Voir [DEPLOYMENT.md](DEPLOYMENT.md).

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
