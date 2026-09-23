# Budgets durables du runner — livrable local

Implémentation locale du 23 septembre 2026, après [Escrow v7](ESCROW-V7.md). Aucun registre de production n’a été initialisé, aucun tarif activé, aucune transaction publique envoyée et Phala reste arrêté. Le [branchement v7](BILLING-INTEGRATION.md) est désormais implémenté localement avec réservation du parcours avant émission du devis.

**Activation bloquée :** l’[audit du 23 septembre 2026](AUDIT-2026-09-23.md) confirme des défauts **non corrigés** de reprise, de facturation après abandon et de validation du devis côté client, ainsi qu’une copie de clé enveloppée conservée après suppression applicative. Les réservations limitent les admissions ; elles ne garantissent ni la clôture des prêts, ni leur revenu, ni le crypto-shredding.

## Ce que le code impose

Le registre SQLite du runner réside dans un **répertoire privé du disque persistant de la CVM**, distinct de la base PostgreSQL de Next. `BEGIN IMMEDIATE`, WAL et `synchronous=FULL` rendent les admissions atomiques entre processus utilisant **le même fichier sur un disque local**. Node 22.13+ est requis. Un registre absent, illisible, remplacé, lié à une autre chaîne ou un autre wallet bloque les opérations. Le service ne crée jamais lui-même un registre vide.

La politique du registre contient une référence comptable, une échéance et des montants entiers en micro-USD : marge déjà acquise après charges antérieures, liquidités disponibles, réserve de frais fixes/arrêt, maxima par requête, ingestion et entraînement. Elle contient aussi les plafonds ETH cumulés/par transaction, unités de gas, prix du gas, borne prudente ETH/USD, confirmations et nombre maximal d’échecs/réservations simultanées.

```text
plafond disponible = min(marge acquise, liquidités) - réserve fixe - coûts maximaux déjà alloués
admission seulement si plafond disponible >= nouveau coût maximal
```

Les dépôts escrow, montants dus aux providers, apports et tokens testnet ne sont pas des revenus Sirius. Le registre **n’importe pas encore une comptabilité vérifiée** : l’opérateur doit justifier les chiffres et la borne de conversion avec `accountingReference`. Aucune recette future n’est anticipée. Une marge initiale nulle refuse les dépenses, même avec un wallet financé. Les bornes doivent couvrir les coûts complets de chaque opération ; les valeurs de tests ne sont ni une grille commerciale ni des budgets à appliquer.

- Chaque appel de `handleRunnerOp`, y compris le fallback en processus, réserve le coût maximal d’une requête. En v7, les grants et devis sont vérifiés avant d’utiliser les requêtes déjà réservées pour le prêt. L’ingestion et les deux types d’entraînement réservent en plus leur exposition avant déchiffrement/calcul/upload. Les contrôles de portée on-chain restent obligatoires avant l’entraînement d’un emprunt.
- Les résultats terminés (CID, métriques et, pour l’ingestion, clé enveloppée) sont persistés. Si la reprise atteint le cache du même job avec les mêmes paramètres, elle retrouve le résultat sans réentraîner ni repinner. Aucun plaintext, DEK en clair, master key ou préimage n’est enregistré dans ce registre. **La copie de `wrappedKey` dans `operations.result` survit cependant à la suppression Prisma : conserver cette copie et la master key empêche de garantir le crypto-shredding.** La suppression du dataset doit être coordonnée avec le registre et ses copies.
- Un job déjà engagé ne redémarre pas après erreur ou crash. Les réservations incertaines ne périment pas. Les requêtes de reprise consomment néanmoins leur propre budget de traitement ; l’épuisement peut donc suspendre aussi les livraisons via le runner.
- Succès et échecs ne recréditent aucun maximum alloué. Cette comptabilité conservatrice limite les admissions ; **elle ne mesure pas les frais facturables au borrower**. Elle ne permet aucune retenue v7 à elle seule : la mesure d’exécution est enregistrée séparément.
- Les échecs ouvrent un coupe-circuit persistant au seuil configuré. Les prêts v7 conservent leurs budgets déjà affectés, dans les limites du nombre de requêtes et tentatives. Les succès, changements de jour et redémarrages ne remettent aucun compteur à zéro.
- Les téléchargements/upload IPFS sont bornés à 8 Mio de blob chiffré et 20 secondes ; les réponses de métadonnées upload à 64 Kio. Les dépassements ne déclenchent pas de reprise automatique.

## Règlement et wallet gas

Une seule intention de transaction peut être ouverte pour le wallet dans ce registre, même pour deux prêts/contrats différents. Le maximum ETH par transaction et son équivalent USD arrondi vers le haut sont réservés avant préparation. Le code contrôle réseau RPC, compte dérivé, contrat configuré, méthode `release` ou reçu final v7 `recordExecution`, calldata reconstruite et valeur ETH nulle. Il refuse un solde ETH inférieur à la réservation, une estimation de gas trop élevée ou un prix au-dessus de la borne.

La transaction EIP-1559 est signée localement avec nonce `pending`, gas borné, `maxFeePerGas` plafonné et pourboire nul. Son hash et son nonce sont persistés **avant** `sendRawTransaction`. L’envoi n’a pas de retry RPC, de remplacement, de hausse de frais ni de nouveau nonce automatique. Le préimage/calldata brut et la transaction signée ne sont pas stockés dans le registre ou dans les messages d’erreur.

Une perte de réponse ou un timeout conserve l’intention. Quand elle atteint l’adaptateur, la reprise ne fait que rechercher sa confirmation. Seul le reçu du hash exact, du bon compte/contrat et avec le nombre configuré de confirmations clôt l’intention. Un revert consomme la tentative et compte comme échec. Le maximum alloué reste consommé après succès ou revert.

**Défaut confirmé de reprise :** un `recordExecution` peut réussir on-chain alors que son attente de confirmation échoue. L’intention reste réservée, puis la reprise `run-loan-job` rejette le prêt déjà remboursé dans `matchesScope` avant d’atteindre l’adaptateur. Le PoC bloque ainsi le règlement d’un autre prêt malgré le remboursement confirmé du premier. Cette impasse applicative est distincte du choix conservateur de conserver une transaction réellement incertaine. Il faut rendre sa réconciliation accessible après clôture du prêt ; les retours anticipés de Next après un `release` confirmé doivent aussi être traités.

Un crash entre réservation et diffusion peut bloquer le wallet même sans transaction réellement envoyée : c’est le choix conservateur de cette version. Il n’existe pas encore de commande de déblocage/réapprovisionnement du registre. Ne pas le supprimer, le recréer ou modifier son SQL pour contourner cet arrêt. La réconciliation opérateur devra prouver l’état des intentions avant toute évolution du budget. La réconciliation par hash est possible avec une politique périmée dans l’adaptateur ; une requête HTTP peut toutefois être refusée plus tôt par son propre budget épuisé.

Les remboursements à échéance et retraits pull-only restent exécutables directement sur les contrats sans service runner. Aucun débit de trésorerie, indemnisation automatique, swap ou recharge du wallet n’est ajouté.

## Configuration locale et préparation d’activation

Les commandes manipulent uniquement un fichier local explicitement fourni :

```bash
pnpm runner:budget init /chemin/prive/budget.sqlite /chemin/politique.json
pnpm runner:budget inspect /chemin/prive/budget.sqlite /chemin/politique.json
```

Le répertoire doit préexister en `0700`, le fichier est créé en `0600` avec création exclusive : `init` refuse tout fichier existant. `inspect` lit les compteurs et la politique persistée ; il ne recharge pas la politique depuis le JSON. Les champs complets sont définis par `BudgetPolicy` dans `src/lib/runner/budget-ledger.ts`. `validUntil` est un timestamp Unix en millisecondes. `maxActive` doit couvrir les requêtes et leurs sous-opérations réservées simultanément.

`RUNNER_BUDGET_FILE` désigne ce fichier ; `SIRIUS_LOCK_AUTHORIZER` doit désigner le wallet opérationnel attendu. Le budget est obligatoire en production, en mode Phala et sur mainnet. Le développement/test synthétique v6 en mode stub sur testnet peut fonctionner sans registre ; les devis et prêts v7 l’exigent également dans cet environnement. Le mode bootstrap HTTP reste sans opérations métier et n’exige pas de budget.

L’image suivante devra inclure ce code et l’outil `scripts/runner-budget.ts`. Lors d’une future activation autorisée, préparer le répertoire privé dans le volume persistant existant, transmettre `RUNNER_BUDGET_FILE` au conteneur et refaire les mesures d’attestation. Le compose actuellement épinglé et la CVM arrêtée n’ont pas été modifiés. L’initialisation d’un registre réel exige d’abord la validation des coûts et de la marge ; aucune valeur positive de démonstration ne doit servir de financement fictif.

## Limites avant exploitation réelle

Corriger d’abord les [défauts de l’audit](AUDIT-2026-09-23.md), toujours ouverts :

- la reprise inaccessible après un remboursement confirmé, qui peut bloquer le wallet entier ;
- l’abandon après calcul réussi, qui laisse le borrower récupérer tout le prépaiement à échéance faute de grant de règlement et de checkpoint publié, tandis que Sirius conserve les coûts et allocations ;
- le repli client vers les transactions fournies par l’API lorsque le devis est omis, sans confirmation de ce devis ;
- la persistance de la clé enveloppée d’ingestion après suppression Prisma, incompatible avec une garantie de crypto-shredding.

Ces corrections ne remplacent pas les conditions financières et d’infrastructure déjà connues ci-dessous.

Cette brique **ne garantit pas encore un PnL non négatif**. Restent nécessaires :

- Une source comptable réconciliée et la calibration du barème réel. V7 réserve désormais un entraînement, 16 requêtes et deux transactions jusqu’à clôture ; v6 conserve les allocations par opération. Voir [les garanties et limites de cette réservation](BILLING-INTEGRATION.md#réserver-jusquà-la-clôture).
- Un superviseur extérieur au processus parent, un contrôle d’uptime et des plafonds fournisseur vérifiés. Le worker v7 est terminable, mais ses limites et celles d’IPFS ne bornent pas les abonnements, stockage, factures déjà engagées ou l’inactivité.
- Les coûts hors handler runner : routes Next avant admission, authentification publique, faucet/KYB, préflights, reaper et dépinning. La liquidité agrégée USD ne vérifie pas les crédits disponibles chez chaque fournisseur.
- La séparation effective des comptes et droits en production, la validation des paramètres gas/finalité sur le rollup cible, les sauvegardes cohérentes SQLite et une procédure de reprise auditée. Une politique expirée suspend l’admission sans arrêter automatiquement une machine facturée.

Un disque local commun est une condition de ce mécanisme. **Deux CVM ou deux fichiers ne partagent pas le budget**, même avec la même clé. Ne pas dupliquer le wallet/registre sur des disques indépendants ou restaurer une vieille sauvegarde pour relancer les admissions ; une coordination centrale serait nécessaire avant ce type de mise à l’échelle. Ce dispositif n’est pas une protection contre un opérateur/root capable de modifier le code, le registre ou la clé.

Le budget SQLite et le registre anti-rejeu des grants sont deux mécanismes distincts. Le nettoyage de `RUNNER_REPLAY_DIR` peut supprimer une réservation encore vide créée par un autre processus (S-09) ; le test concurrent du budget ne valide pas cet anti-rejeu. Corriger et tester cette course avant de partager ce répertoire entre processus.

## Vérification

Validation du premier livrable : 272 tests applicatifs, lint, typage et build. La [validation complémentaire v7](BILLING-INTEGRATION.md#validation-locale-et-limites) porte l’ensemble à **289 tests applicatifs, 78 tests contrats et un parcours EVM local réussis**. Elle couvre notamment les réservations du parcours, leur concurrence et la clôture après coupe-circuit, mais pas les trois scénarios de facturation reproduits par les PoC supplémentaires de l’audit. Elle ne vaut ni correction de ces défauts ni activation sur Phala.

Les tests `budget.test.ts` couvrent notamment la dernière réservation entre deux processus, la persistance des tentatives, les doublons, le cache du modèle, les limites globales et de gas, les prix périmés, les données comptables invalides, les reverts et la perte de réponse RPC. `pinata.test.ts` vérifie la coupure des flux trop grands et le refus avant upload. Aucun accès RPC, Pinata ou Phala réel n’est nécessaire.
