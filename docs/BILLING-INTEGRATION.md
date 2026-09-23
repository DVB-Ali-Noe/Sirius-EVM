# Facturation v7 — intégration locale

État au 23 septembre 2026 : devis signé, prépaiement, calcul, règlement et remboursement sont raccordés dans le code. **Aucun tarif réel activé, aucune migration distante, aucun déploiement public ; Phala reste arrêté.** Le mode par défaut reste v6. Les tarifs commerciaux, la comptabilité réconciliée et les plafonds fournisseurs restent à valider : cette intégration ne garantit pas à elle seule un PnL non négatif.

**Activation bloquée :** l’[audit du 23 septembre 2026](AUDIT-2026-09-23.md) a confirmé les défauts ci-dessous, **non corrigés**. Les réservations et les tests existants ne prouvent donc ni la reprise complète du parcours ni la facturation de tout calcul terminé.

## Défauts confirmés avant activation

- **Remboursement confirmé, wallet runner bloqué :** si `recordExecution` réussit mais que la confirmation RPC est perdue, son intention reste réservée. La reprise de `run-loan-job` rejette le prêt déjà remboursé dans `matchesScope` avant d’atteindre la réconciliation du hash. L’intention bloque ensuite les transactions des autres prêts. Le PoC local reproduit ces trois étapes. La réconciliation doit rester accessible après clôture du prêt ; le retour applicatif anticipé d’un prêt déjà `SETTLED` doit aussi être traité.
- **Calcul réussi puis abandon sans facturation :** le navigateur doit émettre un nouveau grant `settle-loan` après le calcul. S’il s’arrête avant, aucun checkpoint de consommation n’est publié ; le remboursement à échéance est intégral malgré le modèle produit et la mesure de réussite persistée. Le PoC a récupéré les 4 USDC synthétiques prépayés, avec zéro crédit à la trésorerie. Le modèle n’a pas été déchiffré gratuitement, mais les coûts et les allocations restent à la charge de Sirius. La publication de la consommation ou le règlement doit cesser de dépendre de cette nouvelle action du borrower.
- **Devis absent, confirmation contournée :** si les réponses `/api/loans` et `/authorize` omettent `billingQuote`, le client reprend le parcours historique et transmet les transactions fournies par l’API sans afficher de devis, même pour un parcours configuré v7. Une réponse API compromise ou incorrecte peut ainsi proposer une approbation illimitée ou une transaction arbitraire ; la confirmation du wallet reste nécessaire. Le client doit vérifier indépendamment la version attendue et refuser un devis absent en v7.
- **Suppression cryptographique non garantie :** le cache durable de l’ingestion conserve `wrappedKey` dans `operations.result` après suppression de sa copie Prisma. Tant que cette copie et la master key subsistent, la suppression applicative seule ne détruit pas l’accès cryptographique. Le cycle de suppression doit couvrir le registre et ses copies avant toute promesse de crypto-shredding.

Ces défauts sont distincts des limites connues de calibration tarifaire, de comptabilité et de plafonds fournisseurs décrites plus bas. Cette mise à jour documentaire ne les corrige pas.

## Parcours implémenté

1. Next réserve le prêt et transmet au runner le reçu authentifié du dataset. Le runner vérifie le titre EVM et son profil, lit les décimales du token et construit le devis. Le prix compute est le maximum entre le prix du profil et un **minimum commun à tous les emprunts**. Aucun tarif commercial n’est fourni par défaut.
2. Le runner réserve atomiquement l’exposition maximale du parcours dans son registre SQLite, avant de retourner le devis signé. Sans marge acquise disponible, ETH disponible ou politique valable jusqu’à l’échéance maximale du prêt, aucun devis utilisable n’est émis.
3. Quand `billingQuote` est présent, Marketplace et Entraîner affichent dataset, compute, total, barème, retenue maximale et expiration. Le navigateur vérifie la signature contre `lockAuthorizer`, le réseau, le contrat, le token et sa précision. Après acceptation, il reconstruit lui-même `approve(total)` et `lock(terms, authorization)`. Dans ce parcours, un refus, un changement de wallet ou de conditions bloque le paiement. Le renouvellement après approve conserve exactement le même devis ; il ne prolonge pas son expiration. L’absence du devis reste un contournement confirmé de ces contrôles côté client.
4. Le runner vérifie `matchesScope` avec le `termsHash` reconstruit depuis le devis signé, le reçu dataset et le grant du borrower avant tout déchiffrement. Le calcul n’est pas déclenché par un devis seul.
5. À la réussite, le modèle chiffré est conservé et la preuve d’exécution lie le hash du devis. Après un grant de règlement distinct du borrower, `release` publie le préimage et crédite atomiquement le provider pour le dataset et la trésorerie pour le compute. Le cache restitue le résultat terminé sans réentraîner ni repinner si la reprise atteint cette étape ; il ne garantit pas la clôture du parcours.
6. Après un échec mesuré, le runner persiste la mesure puis signe un reçu final. Quand `recordExecution` est inclus, il crédite le remboursement du dataset et du compute non consommé, moins la retenue annoncée. Une confirmation RPC perdue peut toutefois laisser le wallet runner bloqué malgré cette inclusion. Sans reçu enregistré on-chain et tant que le prêt reste actif, le remboursement à échéance est intégral.

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

Le prix forfaitaire complet est crédité uniquement lors du `release` ; une réussite locale seule ne l’acquiert pas. La mesure utilise une horloge monotone ; le registre conserve le début, la durée bornée, le résultat et l’empreinte du devis. Aucun dataset, préimage ou clé en clair n’y est stocké, mais le résultat d’ingestion contient une clé enveloppée dont la suppression n’est pas coordonnée avec Prisma. Le premier reçu final fixe aussi l’horodatage de chaîne : si la reprise atteint l’adaptateur, elle ne fabrique pas une autre transaction avec un nouveau timestamp. L’EVM vérifie la signature et les bornes, pas la facture fournisseur.

Chaque job v7 est borné par une durée configurée entre 1 et **30 secondes**, qui couvre récupération, calcul et upload. Le calcul tourne dans un worker terminable, avec limites de heap 128/16 Mio ; le processus parent termine ce worker sur interruption. La limite dataset est de 3 Mio, et les limites IPFS existantes restent applicables. Ce mécanisme ne remplace pas un superviseur externe de la CVM, des plafonds de mémoire du conteneur ou un arrêt de facturation fournisseur.

## Réserver jusqu’à la clôture

Chaque devis engage dès le départ :

- le maximum de coût d’un entraînement ;
- le maximum de coût de 16 requêtes de traitement/reprise/livraison ;
- deux maxima de transaction, chacun compté en ETH et en micro-USD avec arrondi prudent.

La réservation est liée à la chaîne, l’escrow, la clé de prêt et au hash du devis. Sa validité couvre `expiresAt + challengeDays`, et la politique de coûts doit durer au moins jusque-là. Les frais de préparation du devis restent des opérations séparées, couvertes par le budget global.

Ces allocations ne sont pas débitées deux fois pendant l’exécution. Le coupe-circuit global refuse les nouveaux engagements mais préserve l’utilisation des budgets déjà affectés. Les limites du prêt, du gas, de durée et l’interdiction d’un second nonce incertain restent actives. Les tentatives épuisées ou un wallet bloqué peuvent néanmoins empêcher une clôture anticipée ; le remboursement contractuel à échéance reste indépendant du runner. Le défaut de reprise confirmé montre qu’une allocation disponible ne suffit pas à garantir cette clôture.

**Comptabilité volontairement conservatrice :** refus du devis, expiration, succès ou remboursement ne libèrent aucun maximum alloué automatiquement. La réservation initiale d’un devis non payé reste donc comptée. Une saturation peut bloquer de nouveaux devis sans perte correspondante effectivement dépensée. Ne pas supprimer ou recréer le registre pour relancer le service ; une procédure de réconciliation opérateur reste nécessaire. Un budget de gas réellement préfinancé est requis, même si le compute sera payé plus tard en USDC.

## Configuration et migration préparées

| Paramètre | Rôle |
|---|---|
| `SIRIUS_BILLING_VERSION` | Absent ou `6` : parcours historique ; `7` : devis et escrow v7 obligatoires. Configurer Next, runner et outils de manière cohérente. |
| `RUNNER_BUDGET_FILE` | Registre existant obligatoire pour les devis et prêts v7, même dans les tests/dev synthétiques ; pas de création implicite. |
| `RUNNER_BILLING_POLICY_FILE` | Fichier JSON local du runner ; ne pas envoyer les secrets/registre à Next. Son absence ou sa péremption bloque les devis et le démarrage métier v7. |

Le fichier tarifaire suit [`BillingPolicy`](../src/lib/billing/config.ts) : `version=1`, `tariffVersion`, `costReference`, `validUntil` en millisecondes Unix, `chainId`, `usdc`, `usdcDecimals`, `computeRecipient`, `minimumComputeAmount`, puis `profiles.linear_regression` et `profiles.logistic_regression`. Chaque profil contient `computeAmount`, `maxFailureFee`, `executionRateAtomicPerMs` et `maxExecutionMs`. Les montants et taux sont des chaînes d’unités atomiques du token. `maxFailureFee` ne peut dépasser le compute finalement annoncé. Les valeurs de fixtures sont synthétiques et ne constituent pas un tarif approuvé.

La migration [`20260923000000_add_compute_billing`](../prisma/migrations/20260923000000_add_compute_billing/migration.sql) ajoute sept colonnes nullable à Loan : devis signé, hash, montants dataset/compute, plafond, retenue et remboursement. Les prêts historiques ne reçoivent aucune répartition inventée. Le client Prisma local a été régénéré ; la migration n’a été appliquée à aucune base distante. Elle doit précéder la publication du nouveau client Prisma, même si l’instance reste en v6.

Le script de déploiement sélectionne `SiriusEscrowV7` uniquement avec `SIRIUS_BILLING_VERSION=7`. Les contrôles de version refusent un couple mode/contrat incohérent ; reaper, historiques, preuves et retraits savent relire v7. Le smoke contractuel historique refuse v7 avant toute écriture : le parcours réel v7 doit passer par le runner, sans exporter sa clé.

Avant toute activation publique, corriger et tester les défauts de l’audit, dont le cycle de suppression des clés enveloppées. Restent ensuite nécessaires un nouvel escrow et un registre dataset lié, une maintenance et la préservation des historiques, l’application de la migration, des politiques réelles et une image/attestation Phala actualisées. Ne pas convertir les anciens prêts en changeant leur adresse. Le Compose distant, les environnements privés, les fonds et les abonnements n’ont pas été modifiés.

## Validation locale et limites

Validation existante : **289 tests applicatifs, 78 tests contrats et le parcours EVM local réussis**, lint, typages application/v7 et build Next réussis. Ces suites ne couvrent pas les trois scénarios de facturation confirmés par les PoC supplémentaires de l’audit. Leur réussite ne vaut pas correction de ces défauts ni feu vert d’activation.

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
