# Reprise de l’implémentation — démonstration Phala

## Consignes et décisions validées

Le développement a été autorisé. Journaliser chaque modification avant et après exécution. Le [plan complet](PLAN-VPS-PHALA.md) fait référence ; ce journal indique ce qui est réellement implémenté/testé, sans confondre préparation locale et déploiement.

- Self-train sur CSV personnel ou deux exemples existants ; régression linéaire/logistique.
- Robinhood testnet ; financement Sirius par crédits Phala, trésorerie affectée ou combinaison explicite. Aucun paiement client.
- Activation/désactivation **manuelles**, réservées aux opérateurs autorisés. Pas de durée de deux heures, de fermeture programmée ou de démarrage par les visiteurs.
- Fermeture normale : bloquer admissions, finir les opérations engagées, conserver la livraison puis arrêter la CVM. Urgence : demande d’interruption/arrêt explicite.
- Budget/quota insuffisant refuse de nouvelles dépenses et alerte sans changer automatiquement l’état opérateur.
- Mode dédié, fermé par défaut, indépendant du site historique. Aucun fallback Phala → VPS.
- Aucun Git, commit, push, nettoyage Neon ou redémarrage Phala autorisé implicitement par ce travail local. Pas de secret dans les documents.

## État au démarrage

Le self-train, le chiffrement navigateur, les reçus, les modèles, les exemples CSV et la vérification RA-TLS existent. La CVM a été attestée puis arrêtée. Les reapers ont été transférés sur le nouveau VPS ; le runner VPS n’existe pas encore. La nouvelle page, le panneau opérateur et les sessions publiques sont à construire.

Le budget actuel autorise soit une marge acquise, soit des crédits internes liés au domaine staging et à dix wallets au maximum. La livraison self-train appelle le runner pour la clé ; elle doit être adaptée pour rester utilisable après arrêt. Les variables Vercel staging préparent encore la bascule globale v7 précédente : ne pas relancer sa pipeline sans réconciliation.

## Ordre complet et critères de fin

| Lot | Contenu | Critère | État |
|---|---|---|---|
| P01 | État manuel persistant, commandes opérateur, quotas et financement sponsorisé | Refus hors session, identité contrôlée, compteurs conservés après redémarrage | Implémenté et testé localement ; validation distante P08 requise |
| P02 | Contrôle dans le runner et transport attesté | Fermeture respectée par les appels directs, aucune modification du comportement historique hors mode dédié | Implémenté et testé localement ; validation distante P08 requise |
| P03 | Livraisons chiffrées persistantes | Résultat récupérable par son propriétaire après arrêt et rechargement | Implémenté et testé localement ; validation distante P08 requise |
| P04 | API Next et panneau opérateur protégé | Visiteur interdit de commandes ; aucune clé fournisseur dans le navigateur | Implémenté et testé localement ; validation distante P08 requise |
| P05 | Page Phala, exemples, import et résultats | Exemple et CSV personnel parcourent le vrai self-train ; page fermée explicite | Implémenté et testé localement ; validation distante P08 requise |
| P06 | Contrôleur extérieur des commandes CVM | Démarrage/arrêt seulement après commande opérateur authentifiée ; état réel vérifié | Implémenté et testé localement ; validation distante P08 requise |
| P07 | Tests et vérifications locales | Sécurité de contrôle, concurrence, fermeture, budgets, livraisons, types et lint | Validations locales réussies ; détails ci-dessous |
| P08 | Configurations et publication distantes | Origine/base/secrets distincts, image et mesures cohérentes, parcours réel vérifié | Fichiers et runbook préparés ; aucun déploiement exécuté |
| P09 | Runner VPS habituel | Chantier ultérieur, ne bloque pas la page Phala | Différé |

Aucune attribution nominative des tâches. Définir les périmètres de fichiers avant tout travail parallèle et préserver les modifications concurrentes. Aucun autre agent lancé pendant cette implémentation.

## Journal avant/après

### Initialisation — avant

Créer ce journal et marquer le plan comme validé pour développement. Lecture du code self-train, budget, serveur runner, routes datasets, navigation et documentation Next locale effectuée. Aucun code ni environnement modifié à cette étape.

### Initialisation — après

Journal créé. Le plan fonctionnel est accepté ; le choix exact des accès et plafonds d’une session distante ne vaut pas activation. Prochaine modification : P01, primitives de session et persistance, accompagnées de tests locaux sur stockage jetable.

### P01 — avant

Créer des modules dédiés `src/lib/phala-demo/` pour les contrats de session, la validation du mode, les quotas et un registre persistant SQLite du runner. Fermé par défaut, commandes versionnées contre les doubles clics et état conservé après réouverture ; une session ne crée pas artificiellement de budget. Tests sur répertoire temporaire, sans PostgreSQL distant ni CVM.

### P01 — après création, vérification en cours — 26 septembre

Créés : `contract.ts`, `session-store.ts`, `session-store.test.ts` dans `src/lib/phala-demo/`. Financement crédits/Sirius/mixte validé, commandes avec révision attendue, journal opérateur, admissions atomiques SQLite, limites globales/par wallet/concurrence, refus fermé et conservation des opérations engagées. Quatre tests ciblés ajoutés. Ces primitives ne sont pas encore branchées aux API ou au runner ; elles ne rendent pas la démonstration publique accessible. Le budget monétaire reste à raccorder au registre existant en P02.

Prochaine action : exécuter les tests et le typage, corriger tout échec avec une nouvelle entrée avant/après. Examiner aussi l’affichage des compteurs après fermeture avant intégration.

### P01 — validations et correction prévue

Les quatre tests passent sous Node 26. `pnpm exec tsc` a tenté une réinstallation implicite et a refusé sans TTY ; ne pas forcer la purge de `node_modules`. Utiliser directement `node node_modules/typescript/bin/tsc` pour le contrôle. Avant correction : conserver l’affichage du nombre d’opérations de la dernière ouverture après fermeture (la révision de commande change, pas l’historique).

### P02 — avant

Ajouter un financement `sponsored` explicite au registre budget, réservé au testnet et à une origine Phala déclarée, sans modifier le calcul historique marge/crédits internes. Ajouter le mode `SIRIUS_PHALA_DEMO=true`, l’accès aux sessions dans le runner et un endpoint opérateur attesté protégé par un secret dédié. Les appels métier sont filtrés avant les dépenses ; l’autorisation wallet reste exigée. Une ouverture compare son financement au budget persistant existant, sans reconstituer les fonds. Les prêts tiers restent refusés dans l’instance self-train dédiée.

### P01 — après correction

Le compteur affiche maintenant les opérations de la dernière ouverture même après fermeture ; assertion ajoutée au test. Aucune réinitialisation des lignes d’opérations. Vérification ciblée à rejouer avec les tests P02.

### P02 — après branchement initial, non validé

Modifiés : `budget-ledger.ts`, `budget.ts`, `handler.ts`, `server.ts`. Créé : `runner-session.ts`. Le mode sponsorisé est lié au testnet, à Phala sans simulateur et à l’origine déclarée ; financement distinct des marges. L’endpoint `/operations/demo` a son secret dédié et vérifie le budget à l’ouverture. Les admissions de scellement/self-train passent par le registre ; les prêts tiers sont refusés dans le mode dédié. Aucun nouveau mode activé dans les environnements existants.

À vérifier avant de poursuivre : typage de la réponse diagnostics, tests de budget historiques, contrôles d’origine du mode sponsorisé, fermeture/concurrence et transport serveur. L’interface et le contrôleur CVM ne sont pas encore créés.

### P02 — avant correction et tests complémentaires

Les 52 tests sessions/budget/serveur passent. Le typage signale quatre erreurs locales : trois littéraux BigInt incompatibles avec la cible ES2017 et une lecture `blockers` inexistante dans les diagnostics. Remplacer par `BigInt(0)` et les champs réels `expired`, `circuitOpen`, `remainingUsd`, `incompleteJobs`. Ajouter des tests sponsorisés et conserver les règles historiques. Éviter également de muter l’objet fourni à la validation du budget.

### P03 — avant

Préparer la livraison au cours du calcul : clé publique de livraison incluse dans le grant signé, enveloppe chiffrée renvoyée avec le résultat et persistée dans `TrainingJob`. Stocker la clé privée non exportable dans IndexedDB côté navigateur. Une route authentifiée rend uniquement la capsule du propriétaire après arrêt ; aucune clé modèle en clair dans Next. Migration additive locale seulement, sans accès à Neon. Le parcours historique sans clé de livraison conserve son fonctionnement.

### P02 — après correction

Les quatre erreurs de typage identifiées sont corrigées. Le validateur ne mute plus la politique d’entrée. Ajout d’un test sponsorisé couvrant réserve persistante, épuisement, origine/réseau/mode/simulateur. À rejouer avec la passe suivante ; pas d’activation distante.

### P03 — tentative non appliquée

Le premier patch a été refusé sur le contexte exact de `schema.prisma`. Aucune partie de ce patch n’a été appliquée. Relire la ligne `TrainingJob.runnerReceipt` puis réappliquer la même modification additive ; ne pas supposer que la migration ou la livraison existent déjà.

### P03 — après modification

Migration additive `20260926000000_add_self_train_delivery` préparée ; deux champs nullable ajoutés à `TrainingJob`. Le handler lie la clé publique au grant et livre la capsule avec le calcul. Next persiste la capsule et expose une lecture authentifiée réservée au propriétaire. `delivery-client.ts` conserve la clé privée non exportable dans IndexedDB ; la livraison historique reste compatible. Le client Prisma doit être régénéré localement, sans appliquer la migration distante. Le bouton utilisateur qui appelle ce nouveau parcours reste à brancher en P05.

### P04/P06 — avant

Créer un client Next du contrôleur extérieur HTTPS, une API d’état et une API opérateur protégée par session wallet + allowlist d’adresses configurée explicitement. Le contrôleur s’exécute sur VPS avec profil Phala local : seules commandes fixes start/stop/get, pas de shell issu des requêtes. État persistant et commandes sérialisées, RA-TLS obligatoire avant ouverture. L’arrêt normal attend les opérations engagées ; aucune minuterie d’ouverture/fermeture. Déploiement du contrôleur et configuration TLS restent séparés du développement local.

### P04/P06 — après création, tests requis

Créés : `operator.ts`, `controller-client.ts`, routes `session`, `operator`, `drain`, et `scripts/operations/demo-controller.ts`. Le contrôleur est HTTPS, lié à une seule CVM, sans commandes shell libres ; appels API Next authentifiés et contrôle opérateur répété sur le VPS. La commande d’arrêt normal attend aussi les livraisons Next encore RUNNING avant de demander l’arrêt Phala. Aucune durée de session imposée ; les délais bornent seulement l’attente d’une commande et signalent une erreur sans arrêt implicite. Non installé sur VPS ; il lui manque la configuration privée/TLS avant tout usage distant.

### P05 — avant

Créer `/phala` et `/phala/operator`, ajouter une entrée de navigation, réutiliser les exemples regression/classification. Le navigateur prépare sa clé locale, chiffre le CSV, publie son titre EVM privé puis appelle le self-train avec livraison intégrée. Résultat et récupération après rechargement via la route capsule. Hors instance dédiée, afficher un lien vers l’origine Phala configurée plutôt qu’utiliser le runner historique. Adapter le listing uniquement en mode dédié pour éviter la publication transitoire du dataset dans la marketplace.

### P05 — après création, validation à effectuer

Créés : pages `/phala`, `/phala/operator`, composant `PhalaDemo`, exemples déclaratifs, client CSV/self-train et route d’attestation. Navigation ajoutée. Dans l’instance dédiée, le titre est directement enregistré PRIVATE ; ailleurs le comportement LISTED reste inchangé. La colonne cible sélectionnée est déplacée en dernière position dans le CSV chiffré pour réutiliser le profil existant. Clé publique liée au grant ; clé privée enregistrée avant l’upload. Le téléchargement après fermeture lit la capsule serveur et la clé locale du même navigateur. L’interface exige toujours les signatures wallet/testnet nécessaires.

La page principale sert de point d’entrée vers l’origine dédiée si configurée. Aucun environnement n’a reçu le flag d’activation. Le contrôleur extérieur n’est toujours pas installé et aucun test Phala réel n’a été exécuté.

### P07 — avant validation intégrée

Vérifier typage, lint ciblé, tests des sessions/budgets/serveur et du contrôleur (IO simulées, aucun démarrage Phala). Ajouter les régressions de contrôle opérateur, fermeture manuelle, livraison cryptographique et exemples CSV. Brancher les tests au manifeste, puis produire les fichiers de configuration/documentation d’exploitation. Toute erreur entraîne une entrée de correction avant/après.

## Points de reprise obligatoires

Après chaque lot, remplacer son état dans le tableau, noter les fichiers réellement touchés, les commandes de vérification et leurs résultats. Une étape préparée mais non branchée n’est pas « livrée ». En cas d’interruption, reprendre la dernière section « avant » sans « après », relire les fichiers concernés et achever/vérifier la modification avant de poursuivre.

Ne pas publier la page comme opérationnelle tant que P01–P08 ne sont pas vérifiés. Les modifications d’image/origine Phala nécessitent une nouvelle vérification de l’attestation et des mesures ; ne pas réutiliser une ancienne mesure par commodité.

### P07 — avant corrections de la première passe

Le typage passe. Le lint signale un effet React qui appelle indirectement un setter synchrone : charger les résultats avec un effet asynchrone annulable. La relecture identifie aussi : arrêt d’urgence bloqué pendant une commande, état disponible trompeur quand le budget est épuisé, cible CSV non numérique ambiguë, reprise d’un titre PRIVATE et libellé du financement dans la supervision. Corriger ces points et valider la clé de livraison avant calcul. L’urgence doit attendre uniquement la fin de l’appel fournisseur déjà engagé, puis supplanter l’ancienne commande sans qu’elle puisse rouvrir la session. Ajouter des tests de ces comportements avant toute publication.

### P07 — après corrections de la première passe

Chargement des résultats annulable, sélection de fichier invalidée si le CSV est incorrect, cible explicitement numérique, reprise PRIVATE conservée, source sponsorisée identifiée dans la supervision et clé ECDH vérifiée avant entraînement. L’arrêt d’urgence supplante une ouverture/fermeture, sans commandes fournisseur concurrentes ; les réponses obsolètes ne peuvent pas rouvrir la session. Écriture de l’état par fichier temporaire exclusif avant mise à jour mémoire. Le budget et la capacité sont reflétés dans la disponibilité sans fermer la session. Tests et lint à rejouer.

### P07 — avant tests comportementaux complémentaires

Ajouter des tests du contrôleur avec CVM simulée (lecture sans démarrage, opérateur interdit, fermeture avec drainage, redémarrage, urgence pendant ouverture), de la livraison après clonage de clé navigateur et des exemples CSV. Extraire la normalisation CSV dans un module pur pour vérifier les données réelles sans importer le wallet navigateur. Ajouter la commande dédiée au manifeste.

### P07 — après tests complémentaires

89 tests ciblés réussis (sessions, contrôleur, exemples entraînés, livraison cryptographique, budget, monitoring, provider, capsule et serveur). Typage complet et lint ciblé réussis. Les tests CVM sont simulés : ils ne prouvent pas le fonctionnement chez Phala. La persistance réelle IndexedDB dans le navigateur reste à vérifier.

### P02/P04 — avant durcissement des réouvertures et du financement

Lier les grants de la démonstration à la révision de session signée, en conservant exactement le format historique lorsqu’elle est absente. Recontrôler cette révision lors de l’admission atomique : un ancien clic ne doit pas traverser une fermeture/réouverture. Permettre une mise à jour explicite du financement sponsorisé entre sessions sans effacer consommations, échecs ni réservations ; journaliser l’ancienne et la nouvelle politique. Le contrôleur peut lire une politique privée préparée par l’opérateur avant sa commande manuelle d’ouverture. Aucun complément payé implicite. Borner aussi les lectures publiques d’état/attestation.

### P02/P04 — après durcissement, validations à rejouer

Grants de scellement/entraînement liés à `demoSessionRevision`, contrôlée à la signature et à l’admission SQLite. Le format signé historique est inchangé sans ce champ. L’API publique retourne la révision attestée du runner, distincte de la révision de commande du contrôleur. Les lectures publiques sont bornées. Le financement peut être remplacé explicitement, session fermée et sans réservation en cours, depuis un fichier privé préparé avant « Activer » ; consommations et échecs restent intacts. Origine, réseau et prix d’opération ne changent pas via cette commande. Tests de signature, ancienne session et changement crédits → Sirius ajoutés. La politique financière garde sa date de validité initiale : cette commande n’allonge pas des prix devenus obsolètes.

### P08 — avant préparation de l’exploitation et vérification navigateur

Préparer le Compose dédié, un service systemd sans timer, des exemples de configuration sans secrets, et un runbook de déploiement/reprise. Ne pas appliquer ces fichiers aux environnements distants. Ajouter les tests de la démonstration à la CI et un contrôle navigateur isolé pour l’interface et la persistance IndexedDB. Les noms de domaine, wallets opérateurs et montants restent à renseigner explicitement par les opérateurs avant publication.

### P08 — complément avant configuration

Le drapeau dédié doit lui-même imposer le runner Phala attesté côté Next, même si `SIRIUS_REQUIRE_PHALA` manque. Ajouter ce contrôle et sa régression. L’instance dédiée conserve la version de contrats configurée (v7 si elle réutilise les contrats du 25 septembre) ; elle ne facture pas de prêt. Le Compose de démonstration s’ajoute au Compose v7 pour garder la configuration cohérente, avec des volumes séparés des essais internes historiques. Les tests navigateur utilisent des adresses et mesures fictives exclusivement dans leur serveur local intercepté.

### P08 — après préparation initiale

Créés : Compose dédié avec volumes nommés séparément, service systemd du contrôleur sans timer, exemple d’environnement privé, configuration Playwright dédiée et trois scénarios navigateur. Les tests de sessions/livraison sont ajoutés à la CI. Le mode Phala impose désormais le transport strict même sans drapeau supplémentaire. Aucun fichier distant modifié. Nouvelle passe unitaire ciblée : 63 tests réussis ; typage réussi.

### P07 — avant correction du lanceur navigateur

Playwright compile les tests de ce dépôt en CommonJS : `import.meta.url` utilisé pour résoudre esbuild empêche leur chargement. Remplacer cette résolution par le chemin absolu de `package.json`. Aucun test navigateur n’a encore tourné ; le journal ne doit pas présenter ce démarrage comme une réussite.

### P07 — après correction du lanceur navigateur

Résolution d’esbuild compatible CommonJS appliquée. Nouvelle exécution des trois scénarios à suivre.

### P08 — avant runbook et décisions

Documenter les configurations exactes, montants non approuvés, séparation des volumes/bases, attente d’attestation après nouvelle image, commandes manuelles et reprise après incident. Marquer le lot B global comme différé pour éviter un nettoyage Neon ou une relance v7 accidentelle. Ajouter la décision qui remplace D-21 pour le seul VPS de démonstration prévu, sans permettre de fallback du parcours Phala.

### P07 — constats de la passe élargie, avant corrections

Les tests navigateur exécutent bien la page : import personnel/mobile et clé IndexedDB conservée après rechargement passent. Le test opérateur vise aussi l’annonceur de navigation Next ; rendre son sélecteur explicite. La suite applicative révèle les traductions anglaises manquantes des nouveaux messages métier : les ajouter au catalogue existant, sans désactiver le contrôle. Le lint global rencontre uniquement cinq erreurs dans un ancien script privé `.ops/` ; exclure ce répertoire de préparation local de l’analyse du code livré, comme les autres artefacts. Le rendu Compose historique force encore staging et enlève les noms des volumes : ajouter des modes dédiés `demo-init`/`demo-active` sans interpolation de secrets ni réutilisation des volumes historiques.

Le second échec applicatif vient de la fixture « paquets de production » : elle copie une liste explicite de sources et omet le nouveau contrat `phala-demo/contract.ts`, déjà inclus dans la vraie image par `COPY src`. Ajouter cette dépendance à la fixture ; ne pas retirer le test.

### P07/P08 — après corrections de la passe élargie

Catalogue des nouveaux messages ajouté, fixture CLI complétée, `.ops/` exclu du lint livré et sélecteur navigateur limité à l’alerte métier. Rendu `demo-init`/`demo-active` ajouté et testé contre les volumes et l’origine attendus, sans interpoler les secrets. L’image historique ne contient pas ces changements : toute utilisation distante exige une nouvelle image immuable et de nouvelles mesures vérifiées. Suite complète, lint, build et navigateur à confirmer dans la dernière passe.

### P08 — après documentation

Runbook complet créé dans `PHALA-DEMO-RUNBOOK.md` : configuration Next/runner/contrôleur, migration additive, financement cumulé, volumes séparés, portes de publication et organisation des lots sans attribution nominative. D-25 enregistrée ; ancien lot B marqué comme historique/différé ; note sur les crédits mise à jour. Les limites de reprise après arrêt brutal et les notifications d’hébergement non intégrées sont écrites explicitement.

### P07 — dernière passe disponible

- Suite applicative complète : **366/366** tests réussis.
- Lint global : réussi, hors `.ops/` privé explicitement exclu.
- Playwright dédié : **3/3** scénarios réussis (fermeture/accès opérateur, import personnel/mobile, IndexedDB après rechargement).
- Build de production : en cours, résultat à inscrire avant fin de tâche.
- Migration : générée, pas appliquée à distance. Tests navigateur avec API simulées ; aucune attestation de cette nouvelle image en environnement réel.

### P06 — avant dernière correction préventive

Lire et valider la politique privée du contrôleur avant de démarrer la CVM, afin qu’un fichier absent ou malformé ne provoque pas de démarrage inutile. Conserver le contrôle financier définitif dans le runner après attestation. Ajouter une régression sans appel fournisseur lorsque la lecture de politique échoue. Documenter les limites restantes après ce contrôle.

### P06 — après dernière correction préventive

Politique privée et date de relevé vérifiées avant appel de démarrage ; budgets/engagements toujours contrôlés par le runner avant ouverture. Test ajouté pour prouver qu’une politique absente laisse la CVM arrêtée. Aucun complément budgétaire ni activation distants effectués.

### P07 — avant contrôles de clôture ciblés

Le build de production et le typage complet passent. Ajouter les deux derniers contrôles directement aux frontières modifiées : endpoint runner opérateur (secret distinct, fermeture avant dépense, refus d’un grant d’ancienne session), et écriture atomique de la capsule avec le statut DONE. Cette passe couvre des garanties qui étaient jusque-là testées seulement séparément.

### P07 — après contrôles de clôture ciblés

20/20 tests réussis : 15 tests dédiés à Phala et 5 de provenance, dont la nouvelle persistance du statut DONE et de la capsule dans la même écriture. Le contrôle HTTP refuse le secret de transport, reste fermé avant dépense, refuse les opérations de prêt et les admissions d’une ancienne session. Build de production réussi. Dernier contrôle de typage/lint des fichiers de test ajoutés à suivre ; aucune nouvelle modification du comportement applicatif depuis le build.

### Finalisation documentaire — avant

Mettre à jour les états P01–P09 et rendre la reprise autonome : distinguer développement local, validations simulées, configurations réellement installées et étapes encore nécessaires avant accès public. Aucun Git, environnement distant ou service fournisseur à modifier.

## Reprise autonome — lire ceci en premier

**Prochain lot : P08.** La [checklist complète sans attribution nominative](PHALA-DEMO-RESTE-A-FAIRE.md) détaille toutes les étapes restantes. Le code local est présent, la démonstration publique n’est pas en ligne. Les CVM, reapers, bases et configurations Vercel/GitHub n’ont pas été modifiés pendant cette implémentation. Aucun commit/push ni autre commande Git exécutés. Les accès privés déjà disponibles restent sur le poste/serveur ; ne pas les recopier dans ce journal.

### Résultats de vérification

- 366/366 tests de la suite applicative au dernier passage complet, avant l’ajout du dernier test de persistance ; aucun échec restant sur cette passe.
- 20/20 tests de clôture ciblés après les dernières modifications : 15 Phala + 5 provenance.
- 3/3 scénarios Playwright dédiés : mode fermé/opérateur refusé, CSV personnel/mobile, IndexedDB et déchiffrement après rechargement.
- Build Next de production réussi, nouvelles routes présentes. Aucune connexion Phala utilisée par ces tests.
- Migration additive seulement préparée ; Prisma généré localement. Aucun test de cette migration sur Neon distant, aucun effacement de données.

### Fichiers à connaître

- Produit et journal : `docs/PLAN-VPS-PHALA.md`, ce fichier, `docs/PHALA-DEMO-RUNBOOK.md`, décision D-25 dans `docs/DECISIONS.md`.
- Interface : `src/app/(app)/phala/`, `src/components/phala-demo/`, `src/lib/phala-demo/training-client.ts`, `csv.ts`, `examples.ts`, `delivery-client.ts`.
- Sessions/contrôle : `src/lib/phala-demo/session-store.ts`, `runner-session.ts`, `operator.ts`, `controller-client.ts`, `src/app/api/phala-demo/`, `scripts/operations/demo-controller.ts`.
- Runner/financement : `src/lib/runner/budget-ledger.ts`, `budget.ts`, `authorization-contract.ts`, `authorization.ts`, `config.ts`, `delivery.ts`, `delivery-client.ts`, `monitoring.ts`, `src/runner/handler.ts`, `server.ts`.
- Persistance : `src/lib/sirius/self-train.ts`, `provider.ts`, `src/lib/tee/runner-client.ts`, `contract.ts`, `src/app/api/train/route.ts`, `prisma/schema.prisma`, migration `20260926000000_add_self_train_delivery`.
- Exploitation : `deploy/phala/compose.demo.yaml`, modes `demo-init`/`demo-active` du renderer, unité `sirius-phala-demo-controller.service`, exemple `.env`, package/CI, configuration Playwright séparée. Aucun lockfile modifié pour de nouvelles dépendances.
- Le catalogue `src/lib/i18n/phala-en.ts` couvre les erreurs ; harmoniser les libellés de la page française avec le site anglais avant diffusion publique.

### Ordre de la suite

1. Choisir origine Phala et origine HTTPS du contrôleur ; confirmer les deux adresses opérateurs. Ne pas déduire les administrateurs des wallets provider/borrower de test.
2. Créer base et configuration dédiées. Préserver la base historique ; réconcilier les variables déjà préparées dans staging avant tout prochain déploiement de cette branche.
3. Préparer crédits disponibles, budget payé éventuel, réserve de disponibilité/disque/arrêt et coûts, puis affecter explicitement l’enveloppe. Les modes fonctionnent dans le code ; aucun montant n’a été approuvé implicitement.
4. Préparer le troisième déploiement Vercel (pipeline actuelle limitée à main/staging), la nouvelle image et l’initialisation des volumes dédiés. Appliquer la migration avant de servir le nouveau client Prisma.
5. Installer TLS et contrôleur sur le nouveau VPS sous `sirius-ops`, en préservant les reapers. Watchdog de fermeture temporelle toujours désactivé.
6. Après annonce du créneau/coût, vérifier réellement les nouvelles mesures Phala et les épingler. Faire les huit scénarios du runbook avec les wallets.
7. Ouvrir publiquement seulement après cette répétition. P09 (runner VPS) reste distinct et différé ; ne pas annoncer que les reapers entraînent déjà les modèles.

### Limites à conserver dans toute réponse

Pas encore de validation Phala réelle pour cette image. Pas de garantie de reprise automatique après arrêt brutal ou perte de réponse Next avant sauvegarde. Pas de récupération multi-navigateurs garantie si la clé IndexedDB est perdue. Les coûts de machine allumée ne sont pas arrêtés par un quota logiciel ; estimation automatique et notifications externes du panneau restent à intégrer. Le runbook décrit la surveillance manuelle et les réserves à prévoir. Ces limites ne doivent pas être masquées par les tests locaux verts.

### Commandes de vérification reproductibles

```bash
pnpm test:phala-demo
pnpm test
pnpm lint
pnpm build
node node_modules/playwright/cli.js test --config playwright.phala.config.ts
```

Sur ce poste, si `pnpm exec` propose de réinstaller `node_modules`, ne pas accepter une purge pour contourner le problème. Les vérifications ont utilisé directement les binaires Node : `NODE_OPTIONS=--conditions=react-server node --import tsx --test ...`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`, `node node_modules/eslint/bin/eslint.js`, `node node_modules/next/dist/bin/next build`. Les sorties temporaires de la passe sont dans `/tmp/sirius-phala-*.log` et ne constituent pas des preuves distantes.

### Finalisation documentaire — après

États actualisés et prochaine reprise explicitée. Aucun lot distant n’est déclaré terminé. Reprendre P08 avec le runbook, sans rejouer les étapes historiques de nettoyage Neon ou les anciens déploiements staging.

Dernier contrôle après ajout des tests de frontière : typage complet et lint des fichiers modifiés réussis. Aucun outil ou serveur local de test laissé en attente par cette passe. Travail prêt à relire localement ; publication et P08 restent à faire.

### Transmission du contexte — avant modification, 26 septembre 2026

Demande : consigner la totalité du reste à faire et mettre à jour `CLAUDE.md` et `AGENTS.md`, sans attribution nominative des tâches. Créer une checklist de référence, relier le plan et le runbook à cette checklist, retirer les anciennes répartitions nominatives des documents du plan actuel et ajouter le même état de reprise dans les deux fichiers de contexte. Conserver les invariants techniques, les preuves historiques datées et le bloc Next.js. `AGENTS.md` reste local et exclu du suivi Git ; le contexte partageable doit également vivre dans `CLAUDE.md` et `docs/`. Modification documentaire uniquement, sans commande Git ni opération distante.

### Transmission du contexte — après modification, 26 septembre 2026

Checklist `PHALA-DEMO-RESTE-A-FAIRE.md` créée : 14 étapes P08, limites de reprise, P09 et suites produit. Plan, runbook et journal reliés à cette référence, sans attribution nominative. Les états et estimations du cadrage initial sont distingués des réalisations locales. Le même contexte prioritaire du 26 septembre figure dans `CLAUDE.md` et `AGENTS.md` : décisions, infrastructure connue, tests, dépendances, limites et prochaine reprise. Les notes du 23 septembre restent conservées comme historique ; les blocs Next.js et invariants techniques sont préservés.

Vérifications documentaires : 37 liens locaux résolus, blocs de reprise identiques, 14 sections P08 présentes, tableaux cohérents et aucune attribution nominative dans les quatre documents du parcours. Les six fichiers concernés sont exclusivement documentaires. Aucun test applicatif relancé, aucune commande Git, aucun déploiement ou contrôle distant effectué pendant cette mise à jour. Les informations d’infrastructure restent celles du dernier état documenté. Le contexte partageable est prêt dans `CLAUDE.md` et `docs/` ; il n’a pas été publié par cette intervention et `AGENTS.md` reste local.

### Versionnement et partage — avant modification, 26 septembre 2026

Commit et push explicitement demandés sur `feat/staging-v7-completion`. Préparer deux commits : `feat(phala): add sponsored self-training with manual sessions`, puis `docs(phala): document rollout checklist and shared project context`. `CLAUDE.md` étant exclu localement, l’ajouter explicitement au second commit pour partager le contexte ; maintenir l’exclusion d’`AGENTS.md`, des secrets et des sauvegardes. Rappeler dans les anciens points d’entrée que D-25 remplace la bascule globale et le minuteur, sans effacer les preuves historiques. Aucune fusion vers staging/main, migration ou activation Phala dans cette opération.

Contrôles préparatoires : branche distante récupérée sans divergence, diff sans erreur d’espacement, aucune alerte des motifs de secrets examinés. Aucun fichier de code n’a été modifié depuis les dernières validations locales : 366 tests applicatifs, puis 20 ciblés, 3 scénarios navigateur simulés, typage/lint/build réussis. Ces résultats ne prouvent toujours pas le parcours matériel Phala.

Contrôle des nouveaux fichiers après indexation : supprimer uniquement la ligne vide surnuméraire en fin de `src/lib/phala-demo/csv.ts`, signalée par `git diff --cached --check`. Aucune logique modifiée ; cette correction d’espacement ne nécessite pas une nouvelle passe applicative.

### Versionnement et partage — après modification, 26 septembre 2026

Commit fonctionnel créé : `f895be5` — `feat(phala): add sponsored self-training with manual sessions`, 59 fichiers. La seule correction supplémentaire de code est le retrait de la ligne vide finale ; contrôle d’espacement réussi. Les points d’entrée historiques de déploiement et de migration renvoient désormais au parcours manuel actuel. La table des tranches VPS n’attribue plus les tâches à une personne.

La documentation et la fiche fournisseurs sont regroupées dans `docs(phala): document rollout checklist, runbook and VPS migration`. Contrairement au plan initial, `CLAUDE.md` n’est pas versionné : avec `AGENTS.md`, il reste local et se transmet hors Git, sur demande explicite. Les mentions précédentes d’absence de commit décrivent la phase d’implémentation, antérieure à cette demande de partage. Le push de ces deux commits vise uniquement `feat/staging-v7-completion` ; son résultat doit être vérifié sur la branche distante. La PR, la CI de cette nouvelle version et tout déploiement restent distincts de ce push.

### Contrôleur et préparation du runner — avant modification, 26 septembre 2026

Décision D-26 appliquée : staging devient l’instance de démonstration. Objectif de cette passe : rendre le contrôleur joignable en HTTPS depuis Vercel, préparer sans les exécuter les fichiers privés du runner (`demo-init`, `demo-active`, politiques), aligner les variables Vercel restantes et consigner l’état de la checklist. Aucune commande de démarrage de CVM, aucune dépense Phala, aucune opération Git.

Pré-requis vérifiés : pipeline staging verte sur `f509cb2` (migration `20260926000000_add_self_train_delivery` appliquée, image `sha256:8a10ab55…13f8e` publiée), CVM `e8a8b8cb…` arrêtée et `in_progress` faux, profil Phala `sirius` connecté sous `sirius-ops`, secrets de transport et Pinata absents des variables lisibles de Vercel (type sensible).

### Contrôleur et préparation du runner — après modification, 26 septembre 2026

Contrôleur : service `sirius-phala-demo-controller` activé et démarré sous `sirius-ops` ; `GET /session` répond 401 sans secret et 200 avec, en local et via `https://ctl.sirius-data.tech` (Caddy, certificat Let’s Encrypt valide jusqu’au 25 décembre 2026). Un redémarrage du service laisse la CVM arrêtée et l’état `closed`. Les six pins attestés restent des placeholders jusqu’à la recapture.

Runner : politiques `demo-budget-policy.json` (sponsorisé, crédits seuls, plafond 14 USD, réserve 4 USD, 20 opérations, 4 par wallet, 1 simultanée, origine `https://phala.sirius-data.tech`) et `demo-billing-policy.json` (tarif v7 de compatibilité, 7 USDC minimum, trésorerie attendue) générées hors Git et validées par l’initialiseur de volume sous Linux. Fichiers `runner.demo-init.env` et `runner.demo-active.env` assemblés sur le VPS dans `/var/lib/sirius-ops/phala-demo/runner/` (0700/0600) à partir du RPC archive et du secret de supervision du collecteur, du secret opérateur du contrôleur, d’un nouveau secret de transport et de l’accès Pinata vérifié. Les deux Compose rendus y sont copiés. Rien n’a été déployé sur la CVM.

Vercel staging : `SIRIUS_PHALA_DEMO=true`, `PHALA_DEMO_CONTROLLER_URL` et `PHALA_DEMO_CONTROLLER_SECRET` renseignés ; `RUNNER_TRANSPORT_SECRET` remplacé par le nouveau secret partagé avec le futur runner (l’ancien n’était pas lisible). `SIRIUS_DEMO_OPERATORS` renseigné avec les deux opérateurs dans Next et le contrôleur, staging redéployé (`/`, `/phala`, `/phala/operator` en 200).

Reste avant le premier créneau : adresses des opérateurs, annonce du créneau et de son coût (0,0608 USD/h), déploiement `demo-init` puis `demo-active`, recapture et épinglage des mesures, arrêt de la CVM. Checklist mise à jour dans `PHALA-DEMO-RESTE-A-FAIRE.md`.

### Déploiement du runner de démonstration — après exécution, 26 septembre 2026

Créneau annoncé et exécuté sur la CVM `e8a8b8cb…`, app ID inchangé. Premier essai refusé : l’image GHCR est privée et la CVM n’avait plus d’identifiants de registre ; ajout des variables `DSTACK_DOCKER_*` avec un jeton en lecture seule des packages dans les deux fichiers d’environnement, puis nouvel essai réussi. Les logs des conteneurs restent privés ; la vérification de l’initialisation a suivi la méthode documentée : volumes `sirius_phala_demo_*` créés neufs dans la console série, puis démarrage actif réussi (l’image refuse de démarrer sans registres), puis rapport de budget attesté conforme aux politiques installées (chaîne 46630, signataire attendu, 10 USD disponibles après la réserve de 4 USD, aucun échec ni opération incomplète).

Attestation recapturée en mode actif depuis le poste local, l’installation du VPS n’ayant pas la dépendance `dotenv` : quote matérielle vérifiée, MRTD, chaîne de clé, empreinte d’ingestion et signataire inchangés ; RTMR3 et hash Compose nouveaux, hash identique à celui affiché par Phala. Les cinq valeurs sont épinglées dans le contrôleur, le collecteur et Vercel staging ; staging redéployé. La session de démonstration reste fermée ; la CVM tourne en attendant le premier test opérateur.

Raccourci opérateur `/usr/local/bin/sirius-demo-deploy` ajouté sur le VPS (init, verify-init, active, health, registry, status, stop), relu avant usage. Le sous-programme `verify-init` ne peut pas conclure tant que les logs des conteneurs sont privés.

### Correctifs de recette navigateur — avant modification, 26 septembre 2026

Retours de recette sur l’instance servie `phala.sirius-data.tech`. (1) « Utiliser cet exemple » semble ne rien charger. (2) `/phala/operator` reste sur « Connecter le wallet opérateur » après l’autorisation MetaMask. (3) Aucun lien visible vers l’accès opérateur n’est souhaité : une page dédiée avec connexion wallet et code. (4) L’espace Phala doit être en anglais. (5) Le panneau « USDC available to withdraw » liste quatre escrows à 0.

Diagnostic. (1) Reproduit dans un navigateur headless sur l’instance servie : le CSV est bien chargé et la cible `price_eur` est sélectionnée. Mais le champ natif affiche toujours « No file chosen » et la seule confirmation est une ligne grise. (2) `ConnectCta` ne fait qu’`eth_requestAccounts`. La signature du challenge n’est proposée que dans le menu wallet de la barre latérale : le serveur n’ouvre donc aucune session et la page attend `authenticated` indéfiniment. Même défaut pour « Connecter mon wallet testnet » sur `/phala`. (5) Comportement voulu du retrait pull-only ; seule la présentation change.

Décisions de Noé : un code partagé est exigé en plus du wallet de l’allowlist, et les soldes nuls sont masqués.

### Correctifs de recette navigateur — après modification, 26 septembre 2026

- **Connexion.** `connectWallet()` peut désormais être attendu dans `WalletConnector` ; `openWalletModal` conserve son comportement. `SignInCta` enchaîne connexion, reprise d’une session serveur existante et signature. Son état est partagé, car la connexion remonte les composants indexés sur la révision du wallet. Il est utilisé sur `/phala` et sur l’accès opérateur.
- **Accès opérateur.** `/phala/operator` et son lien sont supprimés. La nouvelle route `/operator` est hors navigation, `noindex`, et répond 404 hors `SIRIUS_PHALA_DEMO=true`.
  - Conditions : wallet de l’allowlist signé, puis code d’accès envoyé dans l’en-tête `x-sirius-operator-code` à chaque lecture et commande.
  - Stockage : empreinte scrypt salée dans `SIRIUS_DEMO_OPERATOR_CODE_HASH`, au format `scrypt:sel:empreinte`, sans `$` que les fichiers `.env` interpoleraient. Vérification à temps constant ; le code ne vit que dans la mémoire de l’onglet.
  - Limites : cinq échecs verrouillent le wallet quinze minutes, par instance serverless. Variable absente ou invalide : accès fermé.
  - Outil : `pnpm ops:demo-operator-code` génère un code, ou hache celui reçu sur l’entrée standard, et affiche l’empreinte.
- **Exemples.** La carte chargée est entourée et son bouton devient « Example selected ✓ ». La zone de fichier affiche nom, lignes et colonnes ; le champ natif est masqué, mais reste accessible au clavier et aux lecteurs d’écran. La sélection (fichier, cible, modèle) est remontée au-dessus du contenu indexé sur le wallet : elle n’est plus effacée par la connexion ni par la signature qui suivent le choix d’un exemple.
- **Session expirée sur `/operator`.** Un 401 réinitialise la session locale, faute de barre latérale pour se reconnecter.
- **Anglais.** Passent en anglais `/phala`, sa page de repli serveur, `/operator`, les exemples et les messages de progression. Le test i18n contrôle désormais aussi les appels `progress()` et `setProgress()`.
- **Retraits.** `EscrowCredits` n’affiche que les crédits positifs ou illisibles, et masque le panneau s’il n’y a rien à retirer. Le scénario e2e de retrait d’un ancien escrow attend désormais la disparition du panneau une fois le crédit soldé.

Validations locales :
- tests : 367 applicatifs, 20 `test:phala-demo` dont 5 nouveaux sur le code opérateur, 5 scénarios Playwright Phala simulés, 71 scénarios Playwright principaux ;
- typage, lint ciblé et build réussis ;
- captures bureau et mobile de `/phala` et `/operator` ; `/phala/operator` répond 404.

Les types générés périmés `.next/dev/types` ont été supprimés pour débloquer le build local. Aucun commit, push, déploiement ni variable distante modifiée.

Avant usage sur l’instance servie :
1. Publier ce code.
2. Générer le code et renseigner `SIRIUS_DEMO_OPERATOR_CODE_HASH` dans son projet Vercel.
3. Redéployer, puis transmettre le code aux opérateurs hors chat. Sans cette variable, `/operator` refuse tout accès.

### Retrait automatique des crédits d’escrow — avant modification, 26 septembre 2026

Demande de Noé : Sirius retire automatiquement les crédits d’escrow par `withdrawFor`, depuis le worker du VPS. Le runner Phala, les contrats et le devis v7 restent intacts.

Garde-fous retenus :
- une clé dédiée, qui ne détient que de l’ETH ;
- un seuil minimal et un plafond de gas quotidien ;
- une relecture de `creditOf` avant chaque envoi ;
- aucune relance après un échec ;
- le bouton manuel conservé.

Seuil, plafond et financement de la clé ne sont pas décidés : aucune valeur par défaut.

Le même jour, Noé indique avoir généré le code opérateur et renseigné `SIRIUS_DEMO_OPERATOR_CODE_HASH` dans Vercel. Ce n’est pas vérifié à distance, et ne prendra effet qu’après déploiement du nouveau code.

### Retrait automatique des crédits d’escrow — après modification, 26 septembre 2026

- **`src/lib/sirius/withdraw-relayer.ts`**
  - Configuration : désactivée par défaut ; clé dédiée, distincte du faucet et du vérificateur KYB ; seuil et plafond obligatoires.
  - Titulaires : ceux des prêts réglés, ou annulés avec remboursement, depuis 30 jours, sur les escrows approuvés.
  - Passe séquentielle, du crédit le plus important au plus faible, selon le rapport crédit/seuil, indépendant des décimales du jeton.
  - Relecture puis estimation avant chaque envoi : « rien à retirer » est ignoré, tout autre revert est un échec définitif.
  - Plafond vérifié au pire coût avant l’envoi ; dépense mesurée ensuite par le solde et par le reçu.
  - Arrêts : réserve insuffisante, ou reçu perdu (compté au pire coût).
- **`src/worker/reaper.ts`** : passe toutes les cinq minutes, après la réconciliation. Une configuration invalide arrête le worker au démarrage avec un message explicite.
- **`deploy/vps/compose.yaml`, `.env.example`** : quatre variables `SIRIUS_WITHDRAW_RELAYER_*`, désactivées par défaut.
- **Tests** :
  - neuf tests unitaires, dont la classification de vraies erreurs viem ;
  - `test:billing` retire désormais un crédit provider réel sur Hardhat avec le relayeur : fonds au titulaire, gas payé par le relayeur, second passage sans envoi.
- **Traductions et doc** : erreurs de configuration traduites ; procédure d’activation dans `DEPLOYMENT.md`. Elle génère la clé directement dans `.env.vps`, sans l’afficher.

Validations locales : 376 tests applicatifs, `test:billing` sur Hardhat, typage, lint ciblé et build.

Aucun commit, push ni déploiement ; aucune clé générée, aucune variable distante modifiée. Le coût réel par retrait reste à mesurer puis à reporter dans le business plan.

### Audit avant publication — avant modification, 26 septembre 2026

Demande de Noé : tests, audit, corrections, commit et push, puis mise sur staging. Un audit de sécurité et une relecture de code indépendants ont porté sur l’ensemble des modifications non commitées.

Constats retenus :
- **Sécurité, moyen.** Le verrou d’essais du code opérateur, tenu en mémoire, n’était pas partagé entre instances serverless.
- **Relecture, critique.** Le relayeur reprenait le pourboire de `estimateFeesPerGas`, alors que le séquenceur FCFS impose un pourboire nul, appliqué par tous les autres envois.
- **Relecture, avertissements.**
  - Une réponse tardive pouvait écraser l’état de la console opérateur, voire la rouvrir après « Lock ».
  - Le test e2e du polling vérifiait avant le premier tick.
  - Aucun test ne couvrait le vrai parcours connexion + signature.
- **Bas, acceptés.**
  - Un retrait peut être renvoyé une fois si le worker redémarre entre l’envoi et le reçu : gas perdu, plafonné, fonds intacts.
  - `SignInCta` partagerait son état si deux boutons coexistaient sur un même écran.

### Audit avant publication — après modification, 26 septembre 2026

- **Code opérateur.**
  - Nouvelle table `OperatorCodeAttempt`, migration additive `20260926120000_add_operator_code_attempts`.
  - Chaque tentative est inscrite avant le comptage, et seuls les échecs sont conservés. Un succès n’efface pas les échecs antérieurs ; un refus pendant le verrou ne le prolonge pas.
  - La garde de route passe dans `operator-access.ts`. `operator.ts` reste sans base, car le contrôleur du VPS l’importe : la régression a été détectée par son test, puis évitée.
- **Relayeur.** Pourboire nul et prix plafonné au double du prix courant, comme `boundedGas`.
- **Console opérateur.** Requêtes séquencées, polling suspendu pendant une commande, « Lock » invalide les réponses en vol.
- **Tests.**
  - Course PostgreSQL entre huit processus, avec et sans quatre échecs préalables.
  - E2E du vrai bouton connexion + signature sur `/phala`, via un simulateur de wallet extrait dans `e2e/helpers/wallet.ts` et réutilisé par `wallet.spec.ts`.
  - E2E du polling de la console après un tick réel.

Validations locales :
- tests : 376 applicatifs, 21 `test:phala-demo`, 77 d’exploitation ;
- `test:billing` sur Hardhat, et `test:postgres` sur un PostgreSQL 18 local jetable ;
- 6 scénarios Playwright Phala et 71 principaux ;
- typage, lint complet et build.

Publication : intégration de `origin/staging` (D-26) et de la PR #10, puis PR vers `staging`. La pipeline applique la nouvelle migration avant de servir le code.

### Publication sur staging — après exécution, 26 septembre 2026

- **Fusion.** PR #10 fusionnée (`a689942`), puis PR #11 (`c98f70b`), alors que la session de démo était fermée (D-26).
- **Pipeline** [36262709664](https://github.com/DVB-Ali-Noe/Sirius-EVM/actions/runs/36262709664) : Vérification, Images, Migrations (dont `20260926120000_add_operator_code_attempts`), Front Vercel, Fumée et reaper VPS réussis. Le reaper staging tourne sur `sirius-worker@sha256:d159e7d7…`, sans redémarrage.
- **Contrôles sur `phala.sirius-data.tech`.**
  - `/phala` est en anglais, sans texte français ; l’exemple choisi est visible (112 lignes, 6 colonnes) ; aucun lien opérateur.
  - `/operator` répond 200 avec `noindex` ; `/phala/operator` répond 404.
  - L’API opérateur répond 401 sans session.
- **Variable manquante.** `SIRIUS_DEMO_OPERATOR_CODE_HASH` est absente du projet Vercel staging (tous environnements, noms seuls lus) comme du projet principal. `/operator` refuse tout accès tant qu’elle n’est pas posée puis redéployée.
- **Inchangés.** Runner Phala et empreintes épinglées. Le relayeur de retraits reste inactif, ses variables étant absentes du `.env.vps`.

### Première session de démonstration — après exécution, 26 septembre 2026

Préalable : empreinte du code opérateur générée et posée dans Vercel staging, redéploiement. La console `/operator` a accepté le premier opérateur (wallet MetaMask signé + code).

Premier « Open » bloqué en phase `opening` : le contrôleur refusait l’attestation du runner avec « L’identité du runner diffère de SIRIUS_LOCK_AUTHORIZER », puis « SIRIUS_ESCROW_ADDRESS manquante ». Le modèle `phala-demo-controller.env.example` ne listait ni le signataire ni les contrats que la vérification d’identité exige. Variables ajoutées au fichier privé du contrôleur (mêmes valeurs que le collecteur), service redémarré ; l’état est passé en `error` « Commande interrompue » comme prévu, puis un second « Open » a réussi : contrôleur `open`, runner `open`, page publique `open`, financement crédits, 20 opérations, 4 par wallet, 1 simultanée. Le modèle de fichier est corrigé dans ce commit.

Entraînements réels dans l’enclave depuis `/phala`, même wallet : exemple immobilier (régression linéaire, 112 lignes, R² 0,976, RMSE 24 743) puis exemple crédit (régression logistique, 480 lignes, F1 0,599, exactitude 0,763). Modèles téléchargés (JSON avec coefficients et métriques). Compteurs cohérents entre contrôleur et runner : 2 puis 4 opérations utilisées, 0 en cours. Rapport de budget attesté après le premier entraînement : 0,43 USD engagés, 9,57 USD restants, aucun échec. Troisième tentative du même wallet refusée « Demo quota reached », session restée ouverte. Un essai avec un second wallet n’a pas modifié le compteur : à rejouer en observant la console.

Fermeture envoyée au contrôleur (`close`, révision 2) : phase `closing` puis `closed` en 20 secondes, CVM `stopped`, page publique `closed`. Durée totale d’allumage de la CVM : environ 8 h 40, dont la majorité sans calcul entre le déploiement et le premier test ; coût estimé 0,53 USD de crédits.

Publication pendant la session fermée : PR #13 fusionnée (`e9dbbab`) — dates d’entraînement sur `/phala` et de publication sur la marketplace, migration additive `20260927000000_add_dataset_listed_at`.

Anomalies notées pour la suite : (1) les tests du contrôleur échouent sur Windows par vérification de droits de dossier, sans lien avec le code ; (2) `verify-init` du raccourci VPS ne peut pas conclure tant que les logs conteneur de la CVM sont privés ; (3) la copie de code `/opt/sirius-ops` n’a pas `dotenv`, la capture d’attestation se fait depuis un poste avec dépendances complètes.

### Deuxième session et annulation du démarrage — après exécution, 27 septembre 2026

Réouverture depuis `/operator` après la fusion des dates (révision 4), fermeture par « Deactivate » (révision 5, CVM arrêtée), nouvelle ouverture (révision 6) puis fermeture par « Deactivate » (révision 7). Le bouton de fermeture fonctionne dès que l’état est `open`.

Constat d’ergonomie : pendant la phase `opening`, qui dure une à deux minutes quand la CVM doit être rallumée, seul « Emergency stop » était cliquable. Un opérateur qui change d’avis devait passer par un bouton d’urgence alors qu’aucun calcul n’est encore admis. Correction fusionnée dans staging (`c06ca9a`) : un `close` reçu pendant l’ouverture est traité par le contrôleur comme une annulation, sur le chemin de l’urgence ; la console laisse « Deactivate » actif pendant l’ouverture et son texte d’aide le dit ; test ajouté, suite du contrôleur 7/7 sous Linux. La copie `/opt/sirius-ops` du VPS est mise à jour sur ce commit et le service redémarré ; état `closed` confirmé.

Dates d’entraînement et de publication (`e9dbbab`) vérifiées sur l’instance servie : l’API des datasets renvoie `listedAt` (reprise de la dernière modification pour l’existant) et la carte marketplace l’affiche ; la date de fin d’entraînement apparaît sous chaque résultat de `/phala`.

Fin de nuit : session fermée, CVM arrêtée, contrôleur et Next alignés sur `c06ca9a`.

### Homogénéisation des pages de l’application — après modification, 5 octobre 2026

Avant : chaque page de `(app)` posait son propre conteneur (`max-w-xl` à `max-w-6xl`, centré, `px-4`/`px-6`), si bien que le titre changeait de position d’une page à l’autre ; invites de connexion, liens retour et sous-titres (`h2`) avaient des tailles et styles divergents ; `/phala` et `PhalaDemo` utilisaient un titre héros (`text-4xl`/`text-5xl`).

Après : gabarit commun `components/layout/Page.tsx` (`Page`, `PageHeader`, `BackLink`), conteneur extérieur unique et largeur de contenu `wide`/`default`/`narrow` alignée à gauche ; `ConnectPrompt` pour l’état sans wallet ; `CardTitle` et `SectionTitle` (`components/ui/Heading.tsx`). Pages migrées : dashboard, wallet, train, explorer, datasets (liste, création, fiche), marketplace (catalogue, fiche), KYB, réglages, `/phala` fermé et `PhalaDemo`. Aucun changement de logique ni de texte, hors le lien retour de la création de dataset (« Mes datasets » au lieu de « Mes actifs data »). Contrôle : titres à la même position sur toutes les pages (desktop 1440 px et mobile 390 px), sans débordement horizontal ; typage, lint ciblé et 901 tests réussis.

Marketplace : la colonne de filtres latérale est remplacée par une barre sous la recherche (catégorie et modèle en listes déroulantes, prix et taille en menus de fourchette, case KYB, réinitialisation) ; le tri rejoint la ligne du nombre de résultats ; grille de deux colonnes sur mobile. Test e2e des filtres adapté (listes au lieu de boutons radio, ouverture du menu de prix), non rejoué : Next refuse un second serveur dev tant que `pnpm dev` tourne.

Barre latérale desktop rétractable : bouton d’en-tête pour la replier en rail d’icônes (une icône par page), état mémorisé par appareil (`sidebarCollapsed` dans `useUiStore`). Repliée, le survol (après 150 ms) ou le focus clavier la déplie par-dessus le contenu sans le décaler ; le bouton l’épingle ouverte. Les libellés glissent vers leur icône et s’effacent, « Sirius » se replie en « S » ; animations coupées avec `prefers-reduced-motion`. Barre mobile inchangée.

Révision de la barre latérale : glyphes pleins dessinés pour Sirius à la place des icônes Lucide, affichés seulement quand la barre est repliée ; chaque libellé se contracte et devient son glyphe, et inversement. Le dépliage au survol pousse désormais la page (`sidebarPeek` dans `useUiStore`, non mémorisé).

Barre latérale, suite : icônes Lucide rétablies pour les pages ; repliée, le mot « Sirius » devient l’emblème `components/layout/SiriusMark.tsx`, image fournie de l’anneau de particules (`public/images/sirius-mark.png`, recadrée, fond détouré par luminosité). À la fermeture, les lettres de « Sirius » convergent vers le centre de l’emblème en tournant et s’effacent pendant qu’il apparaît en pivotant ; séquence inverse à l’ouverture. Icône « My datasets » remplacée par un tableau.

Animations de la barre, suite : au repli, le « s » final de « Sirius » glisse vers l’emblème en avalant chaque lettre qu’il croise, pivote d’un quart de tour et laisse place à l’emblème (inverse à l’ouverture, lettres redéposées avec un léger rebond). Navigation : la pastille de la page active est un élément unique qui glisse d’un onglet à l’autre et suit la largeur pendant le repli ; libellés en `mix-blend-difference` pour s’inverser sous la pastille ; léger enfoncement au clic.

Menu profil (haut à droite) : point vert/rouge identique au bouton wallet de la barre latérale ; connexion signée possible depuis le menu (bouton, mention des conditions, erreur), et rappel « Sign in » sur le bouton tant que la session n’est pas signée. Wallet, Settings et KYB passent en pleine largeur : grille solde + carte compte (réseau, adresse copiable, statut de session avec connexion) pour Wallet, cartes en grille pour Settings, statut et invitation côte à côte pour KYB, éléments « Coming soon » en grille. États connectés non vérifiés visuellement (pas de wallet dans le navigateur de test).

Bouton « Sign in » en haut à droite : à la réussite de la signature, les lettres de « Signing… » convergent vers le centre en tournant, le bouton se resserre en pastille ronde où une coche se dessine, puis la pastille s’efface (environ 2 s). Séquence vérifiée par capture continue avec le wallet simulé des tests e2e. Correctif : le bouton ne disparaît plus dès que la session est signée, avant la fin du chargement.

Barre latérale : bouton de sortie placé avant le bouton wallet, à la même position repliée ou dépliée ; une marge invisible de 16 px au bord gauche de l’écran déplie aussi la barre repliée.

### Capacité CSV et calcul — avant modification, 17 octobre 2026

Demande : lever le refus des jeux tabulaires d’environ 30 000 lignes sans augmenter le plafond d’upload de 3 Mio. Diagnostic reproduit localement : une logistique à 23 variables et 4 200 lignes (201 685 octets) échoue sur le budget de 20 M opérations ; à 30 000 lignes (1 440 085 octets), le parseur refuse d’abord le plafond de 20 000 lignes. Le même profil à 4 000 lignes termine dans le worker actuel en 236 ms, avec un pic RSS du processus de 105 Mio sur ce poste. Le plafond Vercel de 4,5 Mo concerne le corps HTTP chiffré, non ces refus de calcul.

Prévoir une augmentation bornée des opérations et des lignes, puis mesurer une exécution réelle de 30 000 lignes dans le worker et tester les frontières de refus. Ne relever la mémoire du worker que si le besoin est observé ; conserver les 3 Mio, le modèle, la facturation et les contrats inchangés. Pas de CVM, de dépense, de mutation distante, de Git ni de lancement de PR dans cette passe locale.

### Capacité CSV et calcul — après modification locale, 17 octobre 2026

`MAX_TRAINING_OPERATIONS` passe de 20 M à 200 M, `MAX_CSV_ROWS` de 20 000 à 50 000 (en-tête compris). 30 000 lignes × 24 paramètres × 200 = 144 M en logistique. Le budget refuse encore dès 31 251 lignes avec 32 paramètres ; l’analyse côté navigateur et le runner suivent les mêmes bornes. Le plafond de 3 Mio, le worker à 128 Mio d’old-gen, les délais de 15 s et la facturation restent inchangés.

Sur ce poste, le vrai worker accepte 30 000 lignes et 23 variables avec un CSV synthétique de 2 820 085 octets en 759 ms, pic RSS du processus 148 Mio ; un exemple plus compact (1 440 085 octets) termine en 748 ms, pic RSS 128 Mio. Les 20 tests ciblés de validation navigateur/runner et entraînement passent, dont la limite exacte du budget et l’entraînement de 30 000 lignes sous le timeout. RSS du processus ≠ heap du worker. Ces mesures locales ne prouvent ni le temps, ni la mémoire disponibles sur tdx.small à 1 vCPU.

Restent à faire avant ouverture : créneau et coût de la CVM staging explicitement validés, déploiement/attestation de la nouvelle image, mesures d’un CSV représentatif de 30 000 lignes et parcours réel. Si le délai doit changer, synchroniser aussi le maximum signé du devis v7. Aucun déploiement, dépense ni opération Git dans cette passe.

Vérification finale locale : `pnpm test` 1 032/1 032, `pnpm test:phala-demo` 27/27, typage et build Next réussis, lint des fichiers touchés sans erreur. Le lint global reste bloqué par 10 erreurs dans `experiments/kev-decision-tune/.vendor/kev/` (dépendances tierces hors chantier). En navigateur, la page réelle de publication affiche 50 000 lignes ; un CSV logistique synthétique de 30 000 lignes et 23 variables (2 760 083 octets) est accepté avec le bon compte de lignes ; à 31 251 lignes et 31 variables (2 000 179 octets), le navigateur affiche le refus de budget. Le serveur de production local sans `SIRIUS_SESSION_SECRET` a refusé le démarrage comme prévu ; le parcours visible a été vérifié avec le serveur de développement, arrêté ensuite. Le test d’inventaire exact de `public/`, fragile à la présence locale de `.DS_Store`, est remplacé par des assertions comportementales : les fichiers cachés ne franchissent pas la porte de prévisualisation.

### Portage isolé depuis staging — 17 octobre 2026

Après accord pour préparer une branche, le correctif a été transféré dans `fix/staging-training-capacity`, créée depuis `origin/staging` à `3ba030c`. Les expériences et fichiers d’environnement copiés automatiquement par l’outil de worktree ont été retirés **du nouveau dossier seulement**, avec accord explicite ; le dossier initial et les branches distantes existantes restent intacts. Sur cette base staging propre : 1 065 tests applicatifs et 27 tests Phala réussis, lint global et typage réussis, build Next réussi avec une URL PostgreSQL locale fictive et un secret de session de test. Aucun service distant ni CVM n’a été modifié ou démarré par ces contrôles. Le créneau CVM et la dépense restent à valider séparément avant de publier des mesures matérielles.

La branche a été poussée et la [PR #105](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/105) est ouverte en brouillon vers `staging` ; aucune branche distante existante n’a été modifiée ou fusionnée. Noé reporte le test matériel jusqu’au réapprovisionnement Phala : ne pas démarrer la CVM, déployer l’image staging ni fusionner cette PR avant ce financement, l’estimation de coût actualisée et les mesures matérielles. Le testnet EVM n’annule pas le coût de la CVM.

### Chemin réel du self-train — avant correctif complémentaire

Relecture de la PR : le test de 30 000 lignes exerçait `trainInWorker` isolément, mais `/api/train` → `runSelfTraining` → `runTraining` appelait `trainAndSeal` sans signal, donc `trainOnData` dans le processus runner. La protection mémoire du worker et son annulation n’étaient pas exercées sur le parcours Phala réel. Relier uniquement le self-train de la démonstration au worker et au délai configurable de 15 s par défaut ; préserver le parcours in-process hors démonstration et les emprunts v6. Vérifier avec un CSV synthétique chiffré et un stockage IPFS simulé localement, sans CVM ni dépense.

### Chemin réel du self-train — après correctif complémentaire

`runSelfTraining` accepte désormais un délai et l’opération runner `run-training` le fournit quand `SIRIUS_PHALA_DEMO=true`, via `RUNNER_TRAINING_TIMEOUT_MS` (15 s par défaut). Le self-train Phala passe donc par `trainInWorker`, son plafond de 128 Mio d’old-gen et son annulation ; un délai dépassé retourne une erreur 503 et ne publie aucun modèle. Hors démonstration, le comportement self-train antérieur et les emprunts v6/v7 ne changent pas. Nouvelle régression : CSV synthétique de 30 000 lignes chiffré, stocké dans un IPFS simulé, entraîné et republié ; le même parcours avec 1 ms est interrompu sans nouvel upload. Aucun appel réseau extérieur, CVM ou dépense.

Consigne de Noé pour la future mesure : Phala sera réapprovisionné, mais ne pas consommer tout le solde. Relever d’abord tarif et solde, puis faire valider un plafond explicite très inférieur au solde et un créneau court ; fermer et confirmer l’arrêt dès les mesures prises.

### Revue approfondie de la PR #105 — avant corrections

Deux relectures indépendantes (sécurité, exactitude) sans faille critique. À corriger : (1) le délai de 15 s couvrait aussi le téléchargement IPFS et l’envoi du modèle, et un dépassement devenait une 503 comptée par le coupe-circuit financier (3 échecs ferment le runner à tous) ; (2) les noms de colonnes non bornés (jusqu’à 10 000 caractères) faisaient dépasser l’output-gate de 256 Kio, avec une 500 comptée : trois entraînements d’un visiteur suffisaient à fermer la démo ; (3) le test d’inventaire de `public/` et des tests de textes avaient été supprimés au lieu d’être adaptés. Également : self-train hors démonstration et emprunts v6 encore dans le processus runner malgré un budget ×10 ; double analyse du CSV à l’ingestion ; parseur construisant environ 96 Mio de tas pour 3 Mio de cellules longues (mesuré), proche du plafond de 128 Mio du worker ; erreur de délai v7 dans `COMPUTE-BILLING.md`.

### Revue approfondie de la PR #105 — après corrections

- Dans l’enclave (`TEE_MODE=phala`), self-train et emprunts v6 passent toujours par le worker borné, sans dépendre du handler. Le délai démarre après téléchargement, déchiffrement et Merkle ; les reprises IPFS sont conservées. Un délai ou une mémoire de worker épuisés (`TrainingLimitExceeded`) deviennent une 422 « Calcul trop long ou trop lourd pour ce fichier » : coût et quota consommés, coupe-circuit intact. Le parcours facturé v7 garde sa 503 comptée et son délai de devis inchangés. Le Next en processus (sans `TEE_MODE=phala`) reste inchangé.
- Noms de colonnes limités à 128 caractères dans le navigateur et le runner (`MAX_HEADER_CHARS`), message traduit ; un modèle refusé par l’output-gate devient une 422. Les datasets déjà scellés avec un nom plus long deviennent inexploitables à l’entraînement (422) et doivent être réimportés.
- `parseCsv` copie par tranches : 3 Mio de cellules de 10 000 caractères passent de 96 Mio de tas et 261 ms à moins de 1 Mio et 23 ms ; 200 000 entrées aléatoires donnent un résultat et des erreurs identiques à l’ancien parseur. L’ingestion ne relit plus le fichier pour ses volumes.
- Tests restaurés avec 50 000 lignes : textes communs, rendu de l’avertissement, message « Too many rows », inventaire de `public/` (fichiers cachés ignorés). Nouveaux : bornes 128/129 caractères, 422 non comptée au dépassement du délai.
- Retour arrière : une image antérieure refuserait l’analyse des datasets scellés avec plus de 19 999 lignes de données.

### Mesure réelle sur la CVM staging — 18 octobre 2026

Budget accordé : 0,50 USD et 2 h. Solde avant : 10,11 USD. Depuis le VPS (clé `sirius_vps`, empreinte `o710R0…` vérifiée), `demo-active.fast.compose.json` copié en `demo-active.capacity.compose.json` avec la seule image remplacée par `sirius-runner@sha256:78839668…6eff4` (pipeline de `712fbb2`) ; un rendu local du Compose courant ne diffère que par cette image. Déploiement sur la CVM `e8a8b8cb…` à 15:36 UTC, prête en 115 s. Attestation active recapturée : quote vérifiée, MRTD, chaîne KMS, empreinte d’ingestion, signataire `0x3b31…c8c8d` et `RUNNER_DEPLOYMENT_ID` inchangés ; nouveau hash Compose `61581af7…950a`, épinglé dans `phala-demo-controller.env` et `runner-monitor.env` (sauvegardes `.bak-capacity-*`, contrôleur redémarré) et dans Vercel staging (job « Front Vercel » relancé, fumée verte). `phala.sirius-data.tech` a vérifié la nouvelle attestation ; l’alias `demo.sirius-data.tech` n’a pas été déplacé.

Deux self-trains de 30 000 lignes × 23 variables (CSV synthétique de 2 760 083 octets) en régression linéaire, à 15:48 et 15:53 UTC : import 200, entraînement 201, environ 5 s entre l’appel `/api/train` et l’affichage du résultat (téléchargement IPFS, worker et envoi du modèle compris), `n = 30000`, aucune 503 ni arrêt du worker. Le cas logistique (144 M d’opérations) n’a pas été mesuré : quota de 4 opérations par wallet atteint ; quatre tentatives refusées en 429. Délai de 15 s et heap de 128 Mio conservés. Session fermée et CVM `stopped` vérifiées à 16:03 UTC ; solde 10,09 USD.

Constats d’interface : le refus 429 s’affichait en haut de la page, hors écran ; chaque refus laissait un brouillon vide ; le lien « Runner attestation » ouvrait un JSON brut. Corrigés dans la PR [#106](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/106) : erreur sous le bouton d’entraînement, suppression du brouillon sur tout refus 4xx du runner, page `/phala/attestation` (contrôles passés, mesures, lecture sans jargon, état « runner éteint », téléchargement de la preuve brute ; autorisée sur l’adresse démo).

### Test navigateur « un seul bouton » — avant correctif, 18 octobre 2026

Sur `origin/staging` (`54cbf37`), `pnpm exec playwright test -c playwright.phala.config.ts --retries=0 -g "un seul bouton"` échoue : `e2e/phala/demo.spec.ts:99` attend le bouton « Connect my testnet wallet » pendant 30 s ; les 5 autres scénarios passent. L’instantané de page montre à la place le bouton « Connect » du menu de choix du wallet.

Cause : le test était devenu faux, pas le code. Depuis les PR #54 et #55 (`582d552`, `675a99c`, 4 octobre), sans wallet connecté, `/phala` affiche `ConnectButton` (menu Google/extensions EIP-6963) au lieu de `SignInCta`. Ce choix est consigné dans `docs/passage-mainnet/12-test-phala.md`. `SignInCta` n’est plus rendu qu’une fois le wallet connecté et affiche alors « Sign in » : le libellé « Connect my testnet wallet » n’apparaît plus jamais. Le parcours compte donc deux gestes, choisir le wallet puis signer.

### Test navigateur — après correctif, 18 octobre 2026

Le scénario devient « menu de choix du wallet puis signature, sans perdre l’exemple choisi ». Il suit le parcours réel : « Connect » dans la page → « Test Wallet » dans le menu → aucune signature tant que l’utilisateur n’a pas cliqué → « Sign in » → une signature exactement → « Train with Phala » actif, `housing.csv` conservé. Aucune attente assouplie ni délai allongé ; code applicatif inchangé.

Vérifié : 6/6 scénarios `playwright.phala.config.ts`, typage, lint, `pnpm test:phala-demo` 28/28. Le lint local ignore `experiments/`, dossier non suivi copié depuis le dépôt principal à la création du worktree et absent de la CI.

Fusionné dans staging le 18 octobre (PR [#107](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/107), commit `0bf7fea`), pipeline staging verte sur les 7 jobs.

### Adresse démo figée — avant déplacement, 18 octobre 2026

`demo.sirius-data.tech` est un alias posé sur un déploiement figé du projet Vercel `sirius-evm-staging` (PR #51), pas un domaine du projet. **Ancienne cible, pour retour arrière :** `sirius-evm-staging-hftbdgjta-byezzaali-gmailcoms-projects.vercel.app`. Relevé curl avant : `/phala` 200, `/phala/attestation` 307 vers `/phala` (page absente de ce déploiement), `/dashboard` 307 vers `/phala`, `/api/loans` 404.

Nouvelle cible retenue : dernier déploiement Production de staging, `sirius-evm-staging-kp3g34898-byezzaali-gmailcoms-projects.vercel.app` (créé à 19:46 CEST). Selon `vercel api /v13/deployments`, `githubCommitSha` = `0bf7fea` (fusion de #107), qui contient donc #105, #106 et #107.

### Adresse démo figée — après déplacement, 18 octobre 2026

`vercel alias set sirius-evm-staging-kp3g34898-byezzaali-gmailcoms-projects.vercel.app demo.sirius-data.tech --scope byezzaali-gmailcoms-projects` : succès. L’alias vise une URL de déploiement précise, pas le domaine du projet : les prochaines fusions dans staging ne le déplacent pas. `vercel alias ls` confirme la cible `kp3g34898`.

Relevé curl après : `/phala` 200 ; `/phala/attestation` 200 avec « Attestation not available right now » (CVM arrêtée) ; `/dashboard` 307 vers `/phala` ; `/api/loans` 404.

Retour arrière : `vercel alias set sirius-evm-staging-hftbdgjta-byezzaali-gmailcoms-projects.vercel.app demo.sirius-data.tech --scope byezzaali-gmailcoms-projects`.

### Mesure logistique 30 000 lignes sur la CVM staging — avant, 18 octobre 2026

Créneau confirmé par Noé. Plafond : 0,30 USD et 1 h. Coût annoncé : environ 0,06 USD/h (tdx.small à 0,058 USD/h, plus le disque). Noé ouvre et ferme la session depuis `/operator` et entraîne avec un autre wallet ; Claude ne démarre rien. État à 17:49:52 UTC : solde 10,085743 USD, CVM `sirius-phala-production` et `sirius-mainnet` `stopped`, session `phase=closed`, contrôleur VPS `active` (révision 34, 0 opération). Suivi en lecture : `/api/phala-demo/session`, `/phala/attestation`, `vercel logs` filtré sur `/api/datasets` et `/api/train`.

### Mesure logistique 30 000 lignes sur la CVM staging — après, 18 octobre 2026

Chronologie, relevée toutes les 20 s par `/api/phala-demo/session` et `phala cvms list` :

- 17:53:35 UTC : ouverture par Noé, CVM `starting`.
- 17:53:58 : CVM `running`.
- 17:54:22 : `open`, révision de session 27.
- 18:01:56 : Désactiver, `closing` et CVM `stopping`.
- 18:02:19 : `closed` et CVM `stopped`.

Contrôleur VPS ensuite : `phase=closed`, révision 36, 0 opération active.

Self-train avec un autre wallet : `capacity-30000x23.csv` (30 000 lignes, 24 colonnes), profil « Binary logistic regression », cible `y`. Logs Vercel de `sirius-evm-staging` :

- 18:00:12.049Z : `POST /api/datasets` 201.
- Upload 200, puis `POST` et `PUT …/list` 200, puis `GET /api/datasets/:id` 200.
- 18:00:27.912Z : `POST /api/train` 201.
- 18:00:33.648Z : `GET /api/train` 200.

**Durée POST → GET : 5,74 s**, du même ordre que la régression linéaire et loin du délai de 15 s. Résultat affiché : `n = 30000`, f1, recall, accuracy et precision = 1 (CSV synthétique à cible séparable ; ce n’est pas une mesure de qualité). Aucune 503 ni 422. Pendant la session, `/phala/attestation` affichait « Attestation verified » sur `phala.sirius-data.tech` et sur `demo.sirius-data.tech`.

Coût : solde 10,085743 → 10,074990 USD à 18:02:30 UTC, soit **0,010753 USD** pour environ 9 min de CVM, sous le plafond de 0,30 USD et 1 h. Délai de 15 s et heap de 128 Mio conservés ; aucun réglage modifié.

### Libellé mort « Connecter mon wallet testnet » — avant, 18 octobre 2026

`PhalaDemo` ne rend `SignInCta` qu’une fois le wallet connecté. Or `SignInCta` n’affiche son libellé (`children`) que sans wallet connecté, sinon « Sign in ». Le libellé « Connecter mon wallet testnet » et sa clé dans `phala-en.ts` ne servaient donc plus. Le prop reste utile ailleurs : `/operator` (« Connect operator wallet », affiché avant connexion) et `/wallet`.

### Libellé mort — après, 18 octobre 2026

`children` devient optionnel dans `SignInCta` ; sans libellé, le bouton affiche « Se connecter » (« Sign in »). `PhalaDemo` rend `<SignInCta />` et la clé « Connecter mon wallet testnet » est retirée de `phala-en.ts`. Rendu inchangé pour l’utilisateur.

Vérifié : test i18n `english.test.ts` 7/7, `pnpm test:phala-demo` 28/28, typage, lint, 6/6 scénarios Playwright Phala (dont « Connect operator wallet » sur `/operator`).

### Page d'attestation en chaîne de confiance — avant, 18 octobre 2026

`/phala/attestation` (PR #106) listait quatre contrôles « Passed » et des mesures brutes. Le MRTD venait de `SIRIUS_EXPECTED_MRTD`, pas de la quote. L'état indisponible affirmait « machine éteinte », alors que `readDemoAttestation` renvoie `null` aussi quand la preuve est refusée. Rien ne reliait le hash Compose à l'image runner ni au commit. La commande de revérification n'était pas donnée.

### Page d'attestation en chaîne de confiance — après, 18 octobre 2026

PR [#110](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/110). Quatre maillons, chacun avec sa valeur, ce qu'il prouve et un état réel :

- Puce Intel : signature, TCB `UpToDate`.
- Machine : MRTD lu dans la quote.
- Code : hash Compose → image → commit.
- Connexion : certificat dans `report_data`. Chaîne KMS, clé d'ingestion et signataire en lignes secondaires, « annoncés sur le canal attesté et comparés aux pins ».

La page ajoute aussi un résumé en tête, l'encadré « prouve / ne prouve pas » et un bloc « Verify it yourself » (`dcap-qvl verify --hex`, CLI v0.7.0). L'état indisponible devient « éteinte ou non vérifiable ».

Lien Compose → image (`resolveCodeRelease`, `src/lib/phala-demo/attestation.ts`) :

- **Prouvé** : `composes/<hash>.json` existe et le SHA-256 de ses octets exacts égale le hash attesté. L'image est celle du service `runner` du `docker_compose_file`.
- **Déclaré** : le hash figure seulement dans `DECLARED_RELEASES`. Image et commit sont affichés en texte, sans lien (dépôt et GHCR privés).
- **Non répertorié** : seul le hash Compose est affiché.

`docker_compose_hash` n'est pas utilisé, car il n'est pas dans la quote. Table actuelle : `61581af7…950a` → `sirius-runner@sha256:78839668…6eff4`, commit `712fbb2`. `composes/` est vide. `next.config.ts` trace `composes/*.json` pour la page et l'API.

Procédure :

1. À chaque nouvelle image CVM, ajouter l'entrée dans la table.
2. À la session suivante, récupérer `phala cvms attestation --json` → `tcb_info.app_compose`, vérifier que son SHA-256 égale le `compose_hash` attesté, puis l'ajouter tel quel par une PR de suivi.

L'écart RTMR0–2 / `os-image-hash` / `app-id` / `key-provider` est suivi dans l'issue [#112](https://github.com/DVB-Ali-Noe/Sirius-EVM/issues/112), sans correctif. Reportés : colonne `composeHash` sur `TrainingJob`, `app_compose` exposé par le runner, preuve image → commit si le dépôt devient public. Alias `demo.sirius-data.tech` non déplacé.

Vérifié : `pnpm test:phala-demo` 38/38 (10 nouveaux), typage, ESLint hors `experiments/`, build. Rendu navigateur bureau et mobile des vues déclarée, prouvée, non répertoriée et éteinte, sur une page d'aperçu supprimée ensuite. Aucune quote actuelle revérifiée de bout en bout : CVM éteinte.

### Compose publié : image prouvée — 18 octobre 2026

Avant : `composes/` vide, la page affichait l'image et le commit « déclarés ». Session ouverte par Noé à 20:16 UTC uniquement pour cette lecture (aucun entraînement). `phala cvms attestation --json` → `tcb_info.app_compose` : 23 765 octets, SHA-256 `61581af7…950a`, égal au hash Compose attesté et épinglé ; image du service `runner` `sirius-runner@sha256:78839668…6eff4` ; aucune valeur secrète (les variables d'environnement sont chiffrées à part, seuls leurs noms figurent dans `allowed_envs`).

Après : fichier versionné tel quel dans `src/lib/phala-demo/composes/61581af7….json`, protégé par `-text` dans `.gitattributes` pour que Git n'en modifie pas les octets. `resolveCodeRelease` renvoie `proven` avec cette image et le commit `712fbb2` : la page passe de « déclaré » à « Image : prouvée par le hash Compose ». Le commit reste « déclaré » (dépôt privé).

### Politique de sortie et API sur modèles privés — avant, 19 octobre 2026

Seule barrière de sortie : `gateModel` (`src/lib/tee/output-gate.ts`), arrondi et taille. Aucune route de prédiction ; aucune règle commune aux modèles livrés et à une future API ; décision du 14 octobre écartant les modèles à servir depuis l’enclave. Linéaire et logistique v1 livrent `n` exact et des métriques mesurées sur l’entraînement ; les arbres de la #111 livrent des métriques held-out et `trainAuc`.

### Politique de sortie et API sur modèles privés — après, 19 octobre 2026

PR [#115](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/115), documentation seule : note [`EGRESS-POLICY-API.md`](EGRESS-POLICY-API.md) et décision D-27 (décision seule en sortie, politique de sortie unique dans l’enclave, dataset jamais modifié et préparation dans le modèle, API réservée aux modèles dangereux à livrer). Aucun changement dans `src/` ni `contracts/`, aucune session Phala.

Mesuré par un prototype jetable hors dépôt (logistique à 23 variables, synthétique, 20 tirages) : la probabilité exacte reconstruit les poids en 24 requêtes ; la décision seule donne 74 % d’accord équilibré à 24 requêtes, mais environ 2 400 appels d’usage normal clonent le modèle (99,3 %). Débit estimé sur 1 vCPU à partir de mesures M2 : 390 à 1 550 réponses signées EIP-712 par seconde, à confirmer sur la CVM.

Seuils provisoires : AUC d’appartenance ≤ 0,55, plafond d’influence k = 2, `n` arrondi à la centaine pour les nouveaux profils ; doublons seulement signalés ; écarts `trainAuc − heldOutAuc` et de perte non applicables avant calibration (annexe B), qui doit laisser passer les exemples de la #111. Tranche de test alignée sur la #111 (une ligne sur cinq selon l’index). Restent : calibration, quotas et prix, crédits prépayés (proposition), CVM continue (décision séparée), prototype `/predict` après la fusion de la #111.

### Profil arbres boostés, phase 1 — avant, 19 octobre 2026

Deux profils seulement : régression linéaire et logistique. `SiriusDatasetRegistry` v4 les codait en dur (`isSupportedTrainingProfile` `pure`), le tarif exigeait exactement ces deux profils, et le contrôle de sortie ne connaissait que des coefficients. Sur Taïwan (24 000 / 6 000), la logistique atteint une AUC de test de 0,727.

### Profil arbres boostés, phase 1 — après, 19 octobre 2026

PR [#111](https://github.com/DVB-Ali-Noe/Sirius-EVM/pull/111), **interrupteur coupé** : rien n'est déployé, et le profil n'est proposé nulle part tant que `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS` ne contient pas `gradient_boosted_trees`.

- **Profil `gradient_boosted_trees` v1** : 150 arbres, profondeur 2, feuilles d'au moins 1 000 lignes, sans aléa ; minimum 10 000 lignes. Une ligne sur cinq est mise de côté : les métriques livrées sont « held-out », avec `trainAuc` à côté.
- **Seuils** : milieux entre valeurs voisines, arrondis à 3 chiffres significatifs. Un audit repasse les lignes dans le modèle livré.
- **Contrôle de sortie** : refuse tout arbre hors profil ou tout champ ajouté.
- **Registre v5** (code et tests Hardhat) : liste de profils gérée par l'administrateur, à laquelle on ne peut qu'ajouter.
- **Contrôles applicatifs** : le contrôle de déploiement et le pré-vol vérifient que chaque profil proposé est accepté on-chain.
- **Tarif** : un profil facultatif sans tarif est refusé par `/api/datasets` en v7. Les politiques déjà installées dans les volumes restent valides.

Mesures (Mac, worker de 128 Mio) :
- 30 000 lignes en 0,8 s, comme la logistique. Pire cas au budget en 0,93 s ; moins de 40 Mio de tas.
- AUC de test sur Taïwan : 0,786, contre 0,787 pour scikit-learn au même réglage.
- Canaris : 22 % contre 13 % pour une ligne répétée 5 fois. Signal transmis au chantier C.

Vérifié : `pnpm test` 1 083/1 083, `test:phala-demo` 38/38, `test:operations`, `contracts:test` 85, `test:billing`, typage, ESLint hors `experiments/`, build, CI de la PR (e2e et PostgreSQL compris). Aucune mesure sur la CVM : estimation d'environ 6 s de bout en bout à partir de la logistique (5,74 s).
