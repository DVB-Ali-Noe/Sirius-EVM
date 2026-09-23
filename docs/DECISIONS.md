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

Le titre on-chain est non transférable. Il contient le hash du CID du contenu déjà chiffré, son Merkle root, sa taille et le hash du profil d'entraînement ; le nom, la description et le CID restent hors chaîne afin de ne jamais inscrire de donnée libre et permanente.

Le crypto-shredding détruit la clé de dataset et laisse un tombstone on-chain : la donnée devient irrécupérable, tandis que la preuve d'existence demeure auditable.

## D-8 — TEE-first

La donnée brute, la master key et le préimage restent dans le runner Phala. Next garde l'orchestration et la base applicative hors enclave. Le runner possède un contrat HTTP explicite, des limites de charge, un registre anti-rejeu persistant et une attestation vérifiable.

## D-9 — Migration par étapes

Le parcours produit est EVM-only : wallet EIP-1193, signatures EIP-191/EIP-712, publication, KYB, USDC, runner et audit. La roadmap distingue le code présent d'une validation testnet réelle.

## D-10 — Production après validation réelle

Avant le mainnet : déployer les trois contrats sur testnet, vérifier leurs adresses et ABI, financer le compte de règlement du runner, exécuter un prêt réel avec deux wallets et rejouer les scénarios de remboursement, récupération de modèle et crypto-shredding. Une revue de contrats indépendante est requise avant toute utilisation avec des fonds réels.

## D-11 — Profil d'entraînement choisi par le provider

Le dataset possède un profil modèle/version déclaré dès l'upload. Le runner valide le CSV pour ce profil ; DatasetRegistry v4 l'ancre et Escrow v5 exige le même profil au lock. Un dataset logistique ne devient pas linéaire par un choix du borrower. Ajouter un nouveau profil impose une version explicite du registre de modèles et une revue des contrats concernés.

## D-12 — L'état local n'est pas une preuve on-chain

Un hash absent ou un statut `CANCELLED` ne prouve ni l'absence de lock ni un remboursement. La reprise et le préflight de migration interrogent la chaîne ; une panne conserve l'incertitude. Un hash erroné n'est remplacé que sur preuve de la transaction correcte. Les anciens escrows sont explicitement autorisés, et leur compatibilité sert à la lecture et à la livraison, pas à signer de nouveaux règlements historiques.

## D-13 — Déploiement applicatif distinct du déploiement Solidity

Les correctifs de récupération, de remboursement wallet, de logs et de taille d'upload ne changent pas les contrats v5/v4. La mise à jour porte sur PostgreSQL, Next, le worker et le runner distant éventuel. Changer d'escrow sans nécessité rompt les références historiques ; conserver les adresses et les clés de chiffrement tant que le protocole Solidity n'évolue pas.

## D-14 — La branche cible configure les origines

Staging et main possèdent des projets Vercel et environnements GitHub distincts. `scripts/deployment-target.mjs` résout explicitement leurs ressources ; les références inconnues sont refusées. La pipeline synchronise les origines serveur et navigateur avant le build, puis contrôle les challenges après déploiement. Les `NEXT_PUBLIC_*` sont recompilées pour chaque cible. Le nom main n'active pas mainnet.

Les alias sont une liste exacte, jamais un joker Vercel. Ils partagent le domaine canonique signé attendu par le runner. Le contrôle de la clé d'ingestion utilise ce même domaine, pour qu'une connexion réussie sur un alias ne soit pas suivie d'un refus d'upload. Les secrets restent séparés par environnement. Les détails et les pièges de changement de branche sont dans [DEPLOYMENT.md](DEPLOYMENT.md).

## D-15 — Connexion, session et navigation sont distinctes

La restauration automatique du provider et du cookie ne doit pas naviguer vers le dashboard. L'accueil garde le blob après rechargement. Une erreur HTTP du challenge est affichée avec sa cause au lieu d'être remplacée par « Sign-in challenge rejected ». Un refus de signature nettoie la tentative locale et permet un nouvel essai.

## D-16 — Même preuve de compte au login et dans le runner

Le login exige la preuve EOA consommée par la délégation. Accepter ERC-1271 uniquement à la connexion créait des sessions inutilisables ensuite ; les comptes contractuels sont donc refusés explicitement jusqu'à un support de bout en bout.

## D-17 — L'ouverture d'un escrow exige des conditions autorisées

Escrow v6 impose un permis EIP-712 court du runner portant sur toutes les conditions du lock et son domaine réseau/contrat. Le runner dérive le hashlock et vérifie le reçu provider ; Next contrôle l'admission et la visibilité en base. Le permis est renouvelé après approve sans dépasser la réservation du prêt. Les anciens contrats sont immuables : [la migration v6](ESCROW-V6.md) possède son propre préflight, distinct des migrations Prisma.

## D-18 — Identité des opérations asynchrones

Une révision monotone identifie la connexion wallet, y compris un aller-retour A → B → A ou un remplacement du provider à adresse identique. Les pages privées sont recréées sur cette révision et l’état authentifié. Une vérification de login obsolète ferme le cookie éventuellement créé avant de permettre un nouveau login.

## D-19 — Époque signée et retraits historiques

Le registre strict v3 signe `verifierEpoch` sous le domaine EIP-712 version `2`. Cette rupture nécessite un nouveau déploiement et de nouveaux consentements. Les escrows historiques déclarés restent lisibles pour les preuves et les crédits ; un retrait cible le bénéficiaire de la session avec `withdrawFor`, sans transfert vers une adresse libre saisie dans le navigateur.

## D-20 — Budget à l’ingestion

Le plafond de 20 millions d’opérations est partagé par validation et entraînement. Un fichier qui le dépasse est refusé avant scellement. Ce contrôle ne garantit pas la disponibilité du runner ni le temps d’exécution sur toute machine.

## D-21 — Phala unique en production, sans sélecteur VPS

Décision validée pour l’intégration de septembre 2026 : Phala est l’unique runner de production, y compris lorsque la chaîne est le testnet. Le runner in-process ou VPS reste réservé au développement/staging avec des données synthétiques ou non sensibles, piloté par l’environnement. Aucun sélecteur dans l’interface et aucune bascule automatique après une panne Phala. Le VPS de production conserve le reaper.

La nouvelle master key naît dans l’enclave ; celle de Vercel n’y est jamais importée. L’immuabilité de `lockAuthorizer` exige donc un nouvel escrow v6 et un registre dataset associé, même si la production utilisait déjà v6. Les anciens escrows restent autorisés pour les crédits et preuves ; les anciens modèles nécessitent la préservation séparée de leur environnement et de leurs clés. Les datasets destinés au nouveau runner sont réimportés.

La provenance `runnerKind` et `runnerDeploymentId` est enregistrée sur les datasets, entraînements et prêts. Les anciennes lignes restent `UNKNOWN`, sans provenance Phala fabriquée rétroactivement. Le mode VPS économique sera étudié si un client le demande ; sa [spécification différée](RUNNER-MULTI-BACKEND.md) n’est pas le périmètre actuel. État et reprise : [PHALA.md](PHALA.md).

## D-22 — Préparer le prépaiement du compute avant le prochain déploiement

Le 23 septembre 2026, Noé demande de reprendre la facturation du compute au borrower avant les nouveaux contrats Phala. Orientation MVP : devis fixe garanti en USDC, distinction dataset/compute, verrouillage du total avant entraînement et crédits séparés pour le provider et la trésorerie Sirius au règlement. Aucun supplément automatique ; une erreur d’estimation doit rester dans un budget réservé, conformément à D-23. Les frais réseau restent séparés. La proposition initiale de remboursement intégral en cas d’échec sans livraison est remplacée par la politique MVP de D-23.

La tarification doit couvrir le calcul et une part des frais de disponibilité et de stockage. Les tarifs, le destinataire des frais, les coefficients de benchmark et les détails de remboursement restent à définir. Les montants illustratifs de la conversation ne sont pas des tarifs validés. L’escrow v6 actuel ne répartit pas ces frais ; [v7 est implémenté et testé séparément en local](ESCROW-V7.md), sans intégration applicative ni déploiement public. Voir [COMPUTE-BILLING.md](COMPUTE-BILLING.md).

Cette priorité remplace l’enchaînement immédiat de D-21 vers un nouvel escrow v6 pour changer seulement le runner. La CVM demeure arrêtée pendant la préparation locale. Avant toute nouvelle utilisation Phala, y compris un benchmark, annoncer à Noé le moment et le coût estimé. Préserver les anciens contrats, crédits et modèles pendant cette évolution.

## D-23 — Tarif minimum prudent et dépenses couvertes

Noé demande un tarif plus élevé pour tous les emprunts, dimensionné pour une faible fréquentation, ainsi que des protections contre le drainage des wallets et les dépenses entraînant un PnL négatif. Aucun tarif chiffré n’est fixé. La spécification impose une réservation durable et atomique de l’exposition maximale avant chaque dépense, des budgets globaux indépendants des wallets clients, des limites d’exécution et de gas, un coupe-circuit et une trésorerie séparée sans recharge automatique des comptes opérationnels.

**Choix confirmé pour le MVP :** en cas d’échec, rembourser le dataset et le compute non consommé ; ne retenir que les frais d’exécution engagés, justifiables, plafonnés et annoncés dans le devis. La retenue ne dépasse ni son plafond accepté ni le compute déposé ; elle n’inclut pas une marge commerciale ou une provision non consommée. Le remboursement intégral financé par une réserve limitée de marge acquise reste une possibilité ultérieure, non activée.

Un escrow remboursable ou un apport financier n’est pas un bénéfice ; les charges engagées et les frais persistant après arrêt restent comptabilisés. Le mode strict peut interdire le premier démarrage en l’absence de revenus acquis. Un tarif élevé ou une réserve ne garantit pas un PnL positif sans clients, ni une absence absolue de perte face à toute panne ou compromission. Les postes impossibles à borner doivent bloquer l’exploitation concernée.

Le [contrat v7 local](ESCROW-V7.md) et les [budgets durables du runner](RUNNER-BUDGETS.md) sont implémentés séparément. L’intégration du devis, de la comptabilité et des plafonds fournisseurs de [COMPUTE-BILLING.md](COMPUTE-BILLING.md) reste nécessaire ; aucun registre réel ni budget de production n’est activé. Ces exigences ne donnent pas autorisation de redémarrer Phala, supprimer le stockage historique, financer un wallet ou modifier les abonnements distants.
