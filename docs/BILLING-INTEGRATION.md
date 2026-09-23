# Facturation v7 — intégration locale

État au 23 septembre 2026 : devis signé, prépaiement, calcul, règlement et remboursement sont raccordés dans le code. **Aucun tarif réel activé, aucune migration distante, aucun déploiement public ; Phala reste arrêté.** Le mode par défaut reste v6. Les tarifs commerciaux, la comptabilité réconciliée et les plafonds fournisseurs restent à valider : cette intégration ne garantit pas à elle seule un PnL non négatif.

## Parcours implémenté

1. Next réserve le prêt et transmet au runner le reçu authentifié du dataset. Le runner vérifie le titre EVM et son profil, lit les décimales du token et construit le devis. Le prix compute est le maximum entre le prix du profil et un **minimum commun à tous les emprunts**. Aucun tarif commercial n’est fourni par défaut.
2. Le runner réserve atomiquement l’exposition maximale du parcours dans son registre SQLite, avant de retourner le devis signé. Sans marge acquise disponible, ETH disponible ou politique valable jusqu’à l’échéance maximale du prêt, aucun devis utilisable n’est émis.
3. Marketplace et Entraîner affichent dataset, compute, total, barème, retenue maximale et expiration. Le navigateur vérifie la signature contre `lockAuthorizer`, le réseau, le contrat, le token et sa précision. Après acceptation, il reconstruit lui-même `approve(total)` et `lock(terms, authorization)`. Un refus, un changement de wallet ou de conditions bloque le paiement. Le renouvellement après approve conserve exactement le même devis ; il ne prolonge pas son expiration.
4. Le runner vérifie `matchesScope` avec le `termsHash` reconstruit depuis le devis signé, le reçu dataset et le grant du borrower avant tout déchiffrement. Le calcul n’est pas déclenché par un devis seul.
5. À la réussite, le modèle chiffré est conservé et la preuve d’exécution lie le hash du devis. `release` publie le préimage et crédite atomiquement le provider pour le dataset et la trésorerie pour le compute. Une reprise retrouve le même modèle sans réentraîner ni repinner.
6. Après un échec mesuré, le runner persiste la mesure puis signe un reçu final. `recordExecution` crédite immédiatement le remboursement du dataset et du compute non consommé, moins la retenue annoncée. Sans mesure fiable ou sans transaction de remboursement confirmée, le prêt reste récupérable à échéance directement sur le contrat. Sans reçu enregistré on-chain, le remboursement à échéance est intégral.

Les remboursements sont des **crédits escrow à retirer**, pas des virements automatiques vers le wallet. Les frais réseau payés par le borrower pour approve, lock, refund et withdraw restent séparés ; aucun supplément automatique ni débit de la trésorerie n’est ajouté.

## Devis et consommation

Le manifeste canonique est défini dans [`quote.ts`](../src/lib/billing/quote.ts). L’ordre des clés est fixé, les champs libres sont refusés, les montants sont des chaînes d’entiers atomiques et les adresses sont normalisées. `quoteHash = keccak256(UTF8(JSON canonique))` est engagé dans les termes EIP-712 v7. La signature expire au plus cinq minutes après émission, jamais après la fenêtre autorisée par Next.

Le manifeste lie notamment le reçu dataset, le profil, les deux bénéficiaires, les deux prix, les plafonds, le barème, le réseau, le token, ses décimales, le runner et la politique `consumed-execution-only`. La trésorerie compute doit être distincte du compte opérationnel du runner, du borrower, du provider et de l’escrow.

La quantité mesurée est le **temps écoulé d’exécution du job**, depuis la récupération du dataset jusqu’à la production/upload du modèle, transferts inclus. Ce n’est pas un nombre de millisecondes CPU. Le devis l’annonce ainsi. Le barème doit justifier le coût de cette durée avec `costReference` ; il ne doit inclure ni marge commerciale, ni réserve non consommée, ni frais fixes déjà affectés ailleurs.

```text
retenue = min(durée mesurée entière en ms × executionRateAtomicPerMs,
              maxFailureFee)
remboursement = datasetAmount + computeAmount - retenue
```

Le prix forfaitaire complet s’applique uniquement à la réussite. La mesure utilise une horloge monotone ; le registre conserve le début, la durée bornée, le résultat et l’empreinte du devis. Aucun dataset, préimage ou clé en clair n’y est stocké. Le premier reçu final fixe aussi l’horodatage de chaîne : une reprise ne fabrique pas une autre transaction avec un nouveau timestamp. L’EVM vérifie la signature et les bornes, pas la facture fournisseur.

Chaque job v7 est borné par une durée configurée entre 1 et **30 secondes**, qui couvre récupération, calcul et upload. Le calcul tourne dans un worker terminable, avec limites de heap 128/16 Mio ; le processus parent termine ce worker sur interruption. La limite dataset est de 3 Mio, et les limites IPFS existantes restent applicables. Ce mécanisme ne remplace pas un superviseur externe de la CVM, des plafonds de mémoire du conteneur ou un arrêt de facturation fournisseur.

## Réserver jusqu’à la clôture

Chaque devis engage dès le départ :

- le maximum de coût d’un entraînement ;
- le maximum de coût de 16 requêtes de traitement/reprise/livraison ;
- deux maxima de transaction, chacun compté en ETH et en micro-USD avec arrondi prudent.

La réservation est liée à la chaîne, l’escrow, la clé de prêt et au hash du devis. Sa validité couvre `expiresAt + challengeDays`, et la politique de coûts doit durer au moins jusque-là. Les frais de préparation du devis restent des opérations séparées, couvertes par le budget global.

Ces allocations ne sont pas débitées deux fois pendant l’exécution. Le coupe-circuit global refuse les nouveaux engagements mais préserve l’utilisation des budgets déjà affectés. Les limites du prêt, du gas, de durée et l’interdiction d’un second nonce incertain restent actives. Les tentatives épuisées ou un wallet bloqué peuvent néanmoins empêcher une clôture anticipée ; le remboursement contractuel à échéance reste indépendant du runner.

**Comptabilité volontairement conservatrice :** refus du devis, expiration, succès ou remboursement ne libèrent aucun maximum alloué automatiquement. La réservation initiale d’un devis non payé reste donc comptée. Une saturation peut bloquer de nouveaux devis sans perte correspondante effectivement dépensée. Ne pas supprimer ou recréer le registre pour relancer le service ; une procédure de réconciliation opérateur reste nécessaire. Un budget de gas réellement préfinancé est requis, même si le compute sera payé plus tard en USDC.

## Configuration et migration préparées

| Paramètre | Rôle |
|---|---|
| `SIRIUS_BILLING_VERSION` | Absent ou `6` : parcours historique ; `7` : devis et escrow v7 obligatoires. Configurer Next, runner et outils de manière cohérente. |
| `RUNNER_BUDGET_FILE` | Registre existant obligatoire en v7, même dans les tests/dev synthétiques ; pas de création implicite. |
| `RUNNER_BILLING_POLICY_FILE` | Fichier JSON local du runner ; ne pas envoyer les secrets/registre à Next. Son absence ou sa péremption bloque les devis et le démarrage métier v7. |

Le fichier tarifaire suit [`BillingPolicy`](../src/lib/billing/config.ts) : `version=1`, `tariffVersion`, `costReference`, `validUntil` en millisecondes Unix, `chainId`, `usdc`, `usdcDecimals`, `computeRecipient`, `minimumComputeAmount`, puis `profiles.linear_regression` et `profiles.logistic_regression`. Chaque profil contient `computeAmount`, `maxFailureFee`, `executionRateAtomicPerMs` et `maxExecutionMs`. Les montants et taux sont des chaînes d’unités atomiques du token. `maxFailureFee` ne peut dépasser le compute finalement annoncé. Les valeurs de fixtures sont synthétiques et ne constituent pas un tarif approuvé.

La migration [`20260923000000_add_compute_billing`](../prisma/migrations/20260923000000_add_compute_billing/migration.sql) ajoute sept colonnes nullable à Loan : devis signé, hash, montants dataset/compute, plafond, retenue et remboursement. Les prêts historiques ne reçoivent aucune répartition inventée. Le client Prisma local a été régénéré ; la migration n’a été appliquée à aucune base distante. Elle doit précéder la publication du nouveau client Prisma, même si l’instance reste en v6.

Le script de déploiement sélectionne `SiriusEscrowV7` uniquement avec `SIRIUS_BILLING_VERSION=7`. Les contrôles de version refusent un couple mode/contrat incohérent ; reaper, historiques, preuves et retraits savent relire v7. Le smoke contractuel historique refuse v7 avant toute écriture : le parcours réel v7 doit passer par le runner, sans exporter sa clé.

Une activation publique nécessite toujours un nouvel escrow et un registre dataset lié, une maintenance et la préservation des historiques, l’application de la migration, des politiques réelles et une image/attestation Phala actualisées. Ne pas convertir les anciens prêts en changeant leur adresse. Le Compose distant, les environnements privés, les fonds et les abonnements n’ont pas été modifiés.

## Validation locale et limites

Validation effectuée : **289 tests applicatifs, 78 tests contrats et le parcours EVM local réussis**, lint, typages application/v7 et build Next réussis.

```bash
pnpm test
pnpm test:billing
pnpm contracts:test
pnpm exec tsc --noEmit
pnpm exec tsc -p contracts/tsconfig.v7.json --noEmit
pnpm lint
pnpm build
```

`test:billing` compile puis démarre un nœud Hardhat isolé sur localhost avec USDC synthétique 18 décimales. Il exerce les vrais contrats et handlers runner, le calcul worker, la séparation des crédits, l’échec mesuré, le remboursement sans consommation, les reprises et le traitement de prêts déjà réservés après ouverture du coupe-circuit. IPFS est simulé en mémoire ; aucune connexion Phala/Pinata/RPC publique ni base PostgreSQL n’est nécessaire. Les tests navigateur utilisent un fournisseur EIP-1193 simulé et vérifient acceptation, montant exact, substitution et changement de wallet. Ils ne remplacent pas un parcours visuel à deux vrais wallets ni la validation RA-TLS.

Restent avant exploitation : tarifs et coût justifiable de la durée active, marges acquises réconciliées, plafonds réels Phala/stockage/RPC/hébergement, coûts hors runner, superviseur d’uptime, sauvegarde/reprise du registre, validation de finalité/gas du rollup, migration PostgreSQL et parcours navigateur/runner public. Le financement du premier démarrage ne doit pas être présenté comme un bénéfice acquis.
