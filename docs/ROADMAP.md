# Roadmap EVM

Cette roadmap reflète le code présent dans ce dépôt. Une case cochée signifie que la brique est implémentée localement, pas qu'elle a été validée sur un réseau public.

**Reprise au 20 septembre 2026 :** lire d’abord [le point de reprise Phala](PHALA.md#reprendre-ici--20-septembre-2026). La CVM a été vérifiée en amorçage le 19 septembre ; le site, les contrats et la base n’ont pas basculé. Noé doit renseigner les deux accès de production dans `.env.phala-production-secrets`, encore vide au dernier contrôle local. Ne pas recréer la CVM ni reprendre la configuration des accès CLI déjà effectuée.

## Socle EVM — implémenté

- [x] Définition de Robinhood Chain testnet `46630` et mainnet `4663` dans `src/lib/evm/networks.ts`.
- [x] Client RPC `viem`, normalisation EVM des adresses, validation des montants USDC et vérification de signatures EVM.
- [x] `SiriusEscrow` : verrouillage USDC ERC-20 exact, hashlock SHA-256, KYB des deux parties, release avant échéance, remboursement, crédits pull-only et transferts sûrs.
- [x] `SiriusKybRegistry` v3 : attestations KYB EIP-712 liées à l’époque du vérificateur, révocation durable, expiration et gestion des vérificateurs.
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

## Correctifs locaux — audit du 13 septembre

- [x] Afficher et retirer les crédits des escrows courants et historiques dans Wallet et Dashboard (A1).
- [x] Refuser dès l’ingestion les CSV dont le coût dépasse le budget du profil (A2).
- [x] Invalider les logins tardifs, données et soldes lors d’un changement d’identité wallet (A3–A5).
- [x] Paginer les datasets privés et le catalogue sur Entraîner (A6).
- [x] Séparer les quotas de préparation/soumission KYB et reconnaître l’émetteur du parrainage (A7).
- [x] Lier les signatures KYB strictes à l’époque du vérificateur, y compris avant leur première consommation (A8).
- [x] Vérifier les preuves historiques contre le déploiement autorisé du prêt (A9).

Validation et limites : [correctifs du 13 septembre](AUDIT-CORRECTIFS-2026-09-13.md).

## Validation testnet — à faire

- [ ] Effectuer la [migration Escrow v6 / KYB strict v3](ESCROW-V6.md), exécuter son préflight indépendant et republier les datasets avant réouverture.

- [ ] Déployer et exécuter `pnpm contracts:smoke` avec les adresses réellement publiées.
- [ ] Attester un provider et un borrower via l'émetteur KYB externe puis `SiriusKybRegistry`.
- [ ] Publier un dataset chiffré, verrouiller un prêt en USDC, entraîner dans le TEE et régler avec `release`.
- [ ] Vérifier l'ouverture de la capsule uniquement après publication du préimage.
- [ ] Vérifier le remboursement après échéance et le retrait des crédits par les deux parties.
- [ ] Vérifier le crypto-shredding et le tombstone du registre dataset.
- [ ] Rejouer les reprises après timeout et les scénarios de conflit de réseau ou d'adresse de contrat.
- [ ] Appliquer `20260905010000_track_loan_deployment` et configurer l'historique des escrows sur staging ; valider les correctifs de [l'audit du 5 septembre](AUDIT-CORRECTIFS.md) dans le navigateur.
- [ ] Valider après publication les challenges sur le domaine staging et ses alias, puis répéter après fusion sur main ; vérifier DNS et session réelle. Voir [DEPLOYMENT.md](DEPLOYMENT.md).

## Phala et production — en cours

- [x] Préparer le mode d’amorçage Phala sans contrats, avec refus de toutes les opérations métier.
- [x] Vérifier l’identité de règlement et les liaisons EVM avant activation du runner.
- [x] Imposer Phala sur la cible main indépendamment du testnet et tracer la provenance des datasets, entraînements et prêts.
- [x] Préparer le préflight de bascule et le [runbook Phala](PHALA.md), sans sélecteur VPS ; la validation complète en mode actif reste à réaliser.

- [x] Construire et publier l'image immuable du runner (`phala-ratls-20260919`, registre privé GHCR, digest `sha256:fbc137a97f16213f331ce54916a5053f17c97a06d3f614c8b127365b526c5e19`).
- [x] Amorcer la CVM de production, vérifier la quote Intel et le Compose mesuré, confirmer le transport RA-TLS et le refus des opérations métier.
- [x] Vérifier la persistance de l’identité dérivée de la master key et du compte de règlement EVM au redémarrage de la même CVM.
- [ ] Récupérer et valider `DATABASE_URL` et `PINATA_JWT` de production via le fichier local privé ; lire l’état des prêts, entraînements et modèles historiques.
- [ ] Confirmer le mode KYB et le signataire de déploiement, puis déployer les nouveaux contrats avec l’autorisateur attesté de Phala ; conserver l’escrow `0x805a2c2deaa3a8926e85fed6b341dacb54cacba0` en legacy pour ses crédits.
- [ ] Financer l’adresse de règlement Phala en ETH testnet et activer la CVM existante avec les nouvelles adresses.
- [ ] Recapturer les mesures RA-TLS actives et épingler les valeurs côté Next ; les mesures d’amorçage ne conviennent pas à la réouverture.
- [ ] Appliquer `20260919000000_track_runner_provenance` en maintenance, réimporter les datasets et préserver l’accès séparé aux modèles historiques.
- [ ] Synchroniser la configuration Next/reaper, reconstruire et déployer l’application, puis valider les préflights et le parcours navigateur à deux wallets.
- [ ] Exécuter le smoke RA-TLS avec un RPC EVM et des contrats testnet.
- [ ] Faire revoir les contrats et le flux de règlement avant activation mainnet.
- [ ] Obtenir une validation manuelle complète avant toute utilisation avec des fonds réels.

## Post-MVP

- [ ] Jobs asynchrones pour entraînements longs.
- [ ] Budget de confidentialité différentiel et métriques vérifiables.
- [ ] Arbitrage des litiges de qualité.
- [ ] Découverte de datasets et données synthétiques, sans exposer de donnée brute hors TEE.
