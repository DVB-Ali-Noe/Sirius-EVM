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
