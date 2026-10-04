# Points de contrôle pour l'audit

Chaque slice du passage au mainnet remplit **sa propre section**, déjà réservée ci-dessous. Une slice ne touche jamais la section d'une autre : les fusions restent ainsi sans conflit.

L'audit interne final vérifie chacun de ces points **en plus** de l'audit général du code. Une section restée « À remplir » est elle-même un point à signaler.

Références : [plan global](00-PLAN-GLOBAL.md), [audit du 1er octobre](../AUDIT-2026-10-01.md), [runbooks](../MAINNET-RUNBOOKS.md).

## Points transverses

### Ajoutés par Ali et Noé
_Points supplémentaires à prendre en compte pendant l'audit interne._

### Rappels du premier audit
- Connexion anti-phishing (SIWE) reportée après le lancement : vérifier que les sessions restent limitées à 24 heures et que la délégation runner aussi.
- Une seule transaction runner en vol à la fois : vérifier qu'aucune slice n'introduit d'envoi de transaction hors du registre de budget.
- Aucun contrôle d'accès ne doit reposer sur le masquage d'un lien dans l'interface.
- Aucune signature d'assistant dans les commits, les PR et les fichiers.

---

## A1 — Socle base de données

Branche `feat/socle-profils`, PR vers `staging`, six commits (`27d3f35` implémentation ; `aa9bb6c`, `e9ed707`, `3dbd044`, `f515d25` et `eb1b09d` correctifs issus des trois passages de revue interne). Tout ce qui suit est vérifiable depuis `git diff staging...HEAD` (15 fichiers plus cette section).

### 1. Ce qui a changé

**Base de données**

| Objet | Détail |
|---|---|
| `prisma/schema.prisma` | Nouveau modèle `UserProfile` ; nouveau modèle `DatasetAccessLog` ; cinq colonnes ajoutées à `Dataset` (`category`, `listingExpiresAt`, `trainingConsentAt`, `trainingConsentVersion`, `trainingConsentRevokedAt`) et la relation `accessLogs`. Aucun modèle, enum, colonne ou index existant modifié. |
| `prisma/migrations/20261003000000_add_user_profiles/migration.sql` | Migration additive écrite à la main dans le style des migrations générées : cinq `ALTER TABLE "Dataset" ADD COLUMN` (toutes nullables, sans défaut) ; `CREATE TABLE "DatasetAccessLog"` avec clé primaire, clé étrangère vers `Dataset` (`ON DELETE RESTRICT ON UPDATE CASCADE`, nommée `DatasetAccessLog_datasetId_fkey` comme Prisma le ferait) et contrainte `CHECK ("address" ~ '^0x[0-9a-f]{40}$')` ; deux `CREATE INDEX` (`datasetId`, `address`) ; `CREATE TABLE "UserProfile"` avec `address` en clé primaire et le même `CHECK`, `featureTours` et `settings` en `JSONB NOT NULL DEFAULT '{}'`, `createdAt` et `lastSeenAt` en `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`. Aucun `DROP`, aucun `ALTER` de colonne existante, aucune contrainte posée sur une table existante. Prisma ignore les `CHECK` : `migrate diff` entre base migrée et schéma reste vide. |

Colonnes de `UserProfile` : `address` (clé, minuscules, vérifiées par la base), `tourCompletedAt`, `featureTours`, `settings`, `kybStatus`, `kybCheckedAt`, `blockedAt`, `blockedReason`, `blockedBy`, `createdAt`, `lastSeenAt`.
Colonnes de `DatasetAccessLog` : `id` (cuid), `datasetId` (clé étrangère), `loanId` (texte, sans clé étrangère), `address` (minuscules, vérifiées), `modelCid`, `modelFingerprint`, `createdAt`.

**Code serveur**

| Fichier | Rôle |
|---|---|
| `src/lib/users/profile.ts` (nouveau) | `ensureUserProfile` (upsert sans transaction propre, `createdAt` et `lastSeenAt` de la même horloge, reprise unique sur P2002 en ceinture), `ensureUserProfileWithin` (le même upsert dans une transaction courte sous `lock_timeout` et `statement_timeout`, utilisé par GET), `readUserProfile` (lecture sans création), `updateUserProfile` (validation stricte puis délais PostgreSQL, fusion clé par clé en transaction sérialisable, création par upsert si le profil manque, 409 quand les reprises sont épuisées), `validateProfilePatch`, `sanitizeFeatureTours`, `sanitizeSettings`, `toUserProfileView`, `normalizeProfileAddress`, `touchUserProfileAfterLogin` (ne lève jamais : délai de garde de 2 s, délais PostgreSQL du même ordre, au plus deux mises à jour en vol par instance, classe d'erreur seule en journal), `recordDatasetAccess` (journal des accès, accepte une transaction, P2003 converti en 404), constantes `FEATURE_TOUR_KEYS`, `PROFILE_LANGUAGES`, `MAX_PROFILE_PATCH_CHARS`, `PROFILE_DB_TIMEOUT_MS`, `LOGIN_PROFILE_TIMEOUT_MS`, `MAX_IN_FLIGHT_LOGIN_TOUCHES`. |
| `src/app/api/profile/route.ts` (nouveau) | `GET` : profil du wallet de la session, créé au besoin, `lastSeenAt` daté. `PATCH` : modification validée. Les deux passent par `requireAuth` et `errorResponse`, un `FixedWindowRateLimiter` chacun (60 lectures, 20 modifications par minute et par wallet), `cache-control: private, no-store`. |
| `src/app/api/auth/verify/route.ts` | Après `verifyChallenge`, appel de `touchUserProfileAfterLogin(verifiedAddress)` avant la pose du cookie. Quatre lignes ajoutées, rien d'autre ne change. |
| `src/lib/db.ts` | `omit` global étendu de `wrappedKey` aux trois colonnes de consentement de `Dataset` : elles ne sortent plus par défaut d'aucune lecture Prisma, donc jamais sur le catalogue public dont `datasetResponse()` projette la ligne entière. Les lectures qui en ont besoin les ré-incluent avec `omit: { trainingConsentAt: false, … }`. |
| `src/lib/i18n/errors-en.ts` | Quatorze traductions pour les nouveaux messages `AppError`, dont les deux messages d'adresse construits par gabarit dans `normalizeAddress`. |
| `scripts/operations/db-inventory.mjs` | L'outil du runbook de migration lit désormais les `CREATE TABLE` : tables, colonnes et clé primaire annoncées ; écarts `table-not-added`, `column-not-added` (tables neuves) et `index-not-added` en critique ; une table annoncée n'est plus un `table-unexpected`. |
| `package.json` | `src/lib/users/profile.test.ts` ajouté au script `test`. |

**Tests et documentation**

| Fichier | Rôle |
|---|---|
| `src/lib/users/profile.test.ts` (nouveau) | Seize tests `node:test` : normalisation, validation, fusion, vue, journal des accès, hook de connexion (panne, base gelée, plafond en vol, délais PostgreSQL), délais sur GET et PATCH sans imbrication de transaction, 409 sous contention, et les deux routes chargées dans un contexte VM avec leurs dépendances simulées (motif de `audit-regressions.test.ts`). |
| `src/lib/db.test.ts` | Un test ajouté : garde de source sur l'`omit` global (`wrappedKey` et les trois colonnes de consentement). |
| `src/lib/postgres.integration.test.ts` | Après le rejeu de toutes les migrations : une adresse en casse mixte est refusée par `UserProfile_address_lowercase` et `DatasetAccessLog_address_lowercase`, la forme minuscule passe, les JSON par défaut sont `{}`. |
| `scripts/operations/db-inventory.test.ts` | Attentes de la migration A1 (tables, colonnes, index), comparaison avec et sans attentes, table, colonne ou index annoncés mais absents. |
| `docs/passage-mainnet/16-socle-technique.md` | Section 1 : comportement exact des routes et du hook de connexion. Section 2 : suppression de `listingStatus`, pause via `UNLISTED`, règles d'affichage dérivées, consentement omis par défaut. Section 3 : colonnes réelles du journal, `RESTRICT`, état du branchement. |
| `docs/MIGRATION-RUNBOOK.md` | Description de `ops:db-inventory expect` étendue aux tables ; paragraphe sur les écarts attendus pour une migration qui crée des tables, la limite connue de l'outil, et le fait que `prisma migrate deploy` n'applique pas un fichier en une transaction (procédure en cas d'échec). |

**Non touché** : `src/app/(app)/**`, `src/components/**`, `contracts/**`, `src/runner/**`, `src/lib/runner/**`, aucun composant, aucune page, aucun contrat. Vérifié par `git diff --name-only staging...HEAD` (section 9).

### 2. Décisions et écarts par rapport au cahier des charges

- **Pas de `listingStatus`** (demandé explicitement). La pause d'un dataset = `status` de `LISTED` à `UNLISTED`. Conséquence documentée dans 16 § 2 : `UNLISTED` signifie aujourd'hui « semi-privé, empruntable par lien direct », donc un dataset en pause reste empruntable par qui connaît son identifiant. Le socle ne tranche pas ; c'est au couloir des prêts ou de la marketplace de fermer l'emprunt direct si la pause doit l'interdire.
- **`listingExpiresAt` absent = sans expiration** pour les datasets publiés avant ce champ. La migration ne remplit pas la colonne : le cahier des charges impose une migration purement additive, et une date arbitraire aurait fait expirer des annonces existantes.
- **Contraintes `CHECK` sur les adresses** des deux tables créées (ajout du second tour de revue). Le cahier des charges limite la migration à `CREATE TABLE`, `ADD COLUMN` et `CREATE INDEX` : une contrainte déclarée dans le `CREATE TABLE` d'une table nouvelle reste dans cette lettre (comme la clé primaire et la clé étrangère), ne touche aucune table existante, et ferme un vrai trou : sans elle, une écriture manuelle en casse EIP-55 (script, correction en `psql`, futur outil de blocage) créait un second profil que l'application, qui lit toujours en minuscules, ne voyait jamais. Prisma ignore les `CHECK` et les préserve.
- **`tourCompletedAt` en booléen côté API** sous le même nom que la colonne : `true` pose la date serveur si elle n'existe pas encore (renvoyer `true` deux fois ne déplace pas la date), `false` l'efface pour permettre de relancer le tuto depuis Réglages. Le cahier des charges ne précisait pas le cas `false` ; l'alternative (ignorer `false`) aurait empêché la fonction « relancer le tuto » de 13-reglages.md de se persister. Documenté dans 16 § 1 pour qu'un client n'envoie pas `false` par défaut.
- **Fusion clé par clé** de `featureTours` et `settings` plutôt que remplacement : une page qui marque son tuto n'efface pas celui des autres. Réalisée dans `serializableTransaction` (lecture puis écriture, reprise automatique ×3 sur conflit) : deux PATCH simultanés sur des clés différentes conservent les deux. Vérifié de bout en bout sur PostgreSQL (section 9).
- **Clé inconnue refusée (400), pas ignorée** : un client qui envoie `kybStatus`, `blockedAt`, `address` ou `__proto__` reçoit « Champ de profil non modifiable ». Même règle à l'intérieur de `featureTours` et `settings`. Choix volontaire pour qu'une tentative d'écriture d'un champ protégé soit visible, pas silencieuse.
- **Modification vide refusée** (« Aucune modification de profil », 400) plutôt qu'acceptée comme no-op.
- **Bornes** : `MAX_PROFILE_PATCH_CHARS = 2048` caractères JSON (413 au-delà), corps HTTP limité à 4096 octets par `readJson` (413 « Requête trop volumineuse » avant lecture complète). La plus grande modification légitime (toutes les clés) fait environ 160 caractères.
- **Vue renvoyée** : `blockedAt` est exposé (l'utilisateur doit pouvoir savoir qu'il est bloqué), `blockedReason` et `blockedBy` ne le sont pas (notes internes et adresse de l'admin). Si un motif doit être montré après le 6, il faudra un champ public distinct plutôt que rouvrir `blockedReason`. `kybStatus` et `kybCheckedAt` sont exposés (cache d'affichage, c'est leur raison d'être). Les dates sont des chaînes ISO 8601.
- **Lecture défensive** : `featureTours` et `settings` sont re-filtrés à la lecture (clés connues, valeurs bien typées). Une ligne JSONB altérée à la main ne remonte jamais de clé inconnue et n'empêche pas la fusion ; le PATCH suivant la réécrit proprement.
- **`GET` crée le profil** (`ensureUserProfileWithin`) et date `lastSeenAt` à chaque lecture : une session ouverte avant la migration obtient son profil au premier GET. `PATCH` crée aussi le profil s'il manque. `readUserProfile` (lecture pure) est exporté pour les usages serveur qui ne doivent pas créer de ligne, mais aucune route ne l'utilise encore.
- **Limite de débit sur GET aussi** (60/min/wallet, 1000/min global), en plus du PATCH demandé (20/min/wallet, 400/min global) : GET écrit `lastSeenAt`, donc coûte une écriture. Clé `subject:<adresse de session>` comme dans `settle/route.ts`. Le limiteur précède la validation (un corps invalide reçoit 429 une fois le quota atteint).
- **Reprise unique sur P2002** dans `ensureUserProfile` : sur PostgreSQL, Prisma compile cet upsert en `INSERT … ON CONFLICT DO UPDATE`, atomique, donc la reprise n'est jamais exercée (vérifié au journal des requêtes et avec vingt premières connexions simultanées : une ligne, aucune erreur). Conservée comme ceinture, documentée comme telle, jamais en boucle.
- **Délais PostgreSQL sur GET et PATCH** (troisième passage) : l'upsert de GET et la transaction de PATCH commencent par `SET LOCAL lock_timeout` et `statement_timeout` à 5 s (`PROFILE_DB_TIMEOUT_MS`). Sans cela, une ligne de profil verrouillée par une autre session (futur chemin admin sur la même ligne, opération manuelle, transaction oubliée) suspendait chaque GET du wallet sans borne et cinq GET retenaient tout le pool de l'instance. Vérifié sous verrou réel : GET et PATCH échouent en 5 s (erreur 57014, 500 opaque pour le client, qui réessaie) et le pool reste libre. Piège rencontré et couvert par un test : le client de transaction Prisma expose encore `$transaction` à l'exécution, donc `ensureUserProfile` n'ouvre jamais de transaction lui-même (une imbrication épuisait le pool) ; seule `ensureUserProfileWithin`, appelée avec le client racine, en ouvre une.
- **409 sous contention** : quand les trois reprises de `serializableTransaction` sont épuisées (P2034), `updateUserProfile` répond 409 « Profil modifié en même temps, réessaie » plutôt qu'un 500 opaque. Mesures des relecteurs : aucun rejet avec deux à quatre écrivains simultanés, un rejet occasionnel à sept, treize à quinze sur quarante écrivains simultanés sur la même ligne avec un pool de cinq. Aucune écriture perdue dans tous les cas. La fusion atomique en SQL (`jsonb ||` dans l'`ON CONFLICT`) supprimerait cette classe de conflits : notée en reste à faire, pas entreprise si près du gel.
- **Hook de connexion en trois gardes** : `touchUserProfileAfterLogin` est `await`é (en serverless, une promesse non attendue peut être tuée) mais ne lève jamais. (1) Une base qui répond par une erreur : rattrapée, journal `[auth] profil utilisateur non mis à jour (<classe>)` sans adresse ni cause. (2) Une base qui ne répond pas : `Promise.race` avec un délai de 2 s, et l'upsert lui-même tourne dans une transaction courte sous `SET LOCAL lock_timeout` et `statement_timeout` égaux à ce délai, pour que PostgreSQL annule la requête et rende la connexion au pool au lieu de la garder. (3) Au plus deux mises à jour en vol par instance ; au-delà, la mise à jour est sautée (`ProfileSkipped`) : cinq connexions simultanées ne peuvent plus saturer le pool de cinq connexions depuis cette route. Les valeurs passées à `SET LOCAL` sont un entier calculé par le code, jamais une entrée.
- **`DatasetAccessLog.loanId` sans clé étrangère** (le cahier des charges demande `loanId String?` sans relation) : le journal doit survivre à tout nettoyage de prêts. `datasetId` a une clé étrangère `RESTRICT` : un dataset ne peut pas être supprimé physiquement tant qu'il a des accès journalisés, ce qui correspond au modèle actuel où `DELETED` est un statut et non une suppression de ligne ; les seuls `delete` physiques du dépôt (`pipeline.ts`) visent des brouillons `DRAFT` sans contenu, jamais journalisés. Un futur script de purge devra détacher les journaux d'abord (16 § 3).
- **Bornes du journal** : `datasetId` et `loanId` ≤ 64 caractères, `modelCid` ≤ 256, `modelFingerprint` ≤ 128, tous sur l'alphabet `[A-Za-z0-9:_.-]` (cuid, CID IPFS, hexadécimal, préfixes `sha256:`). Le format exact de l'empreinte n'est pas imposé : il sera fixé par le couloir qui branche la livraison. Un `datasetId` inconnu est refusé en 404 « Dataset introuvable » (clé étrangère).
- **`recordDatasetAccess` n'est branché nulle part** (demandé : « testée, pas encore branchée »). Il accepte un client de transaction pour s'inscrire plus tard dans la transaction de livraison du modèle.
- **Consentement omis par défaut** (`src/lib/db.ts`, correctif du premier tour) : la slice crée les colonnes, et `datasetResponse()` projette la ligne `Dataset` entière vers `GET /api/datasets` (anonyme) et `GET /api/datasets/[id]` (public pour `LISTED`/`UNLISTED`). Sans cet `omit`, la date, la version et la révocation du consentement du fournisseur auraient été visibles de tout visiteur dès que l'upload les remplira. Le vote des contradicteurs l'avait jugé non bloquant tant qu'aucune route n'écrit ces colonnes ; corrigé quand même parce que le coût est de quatre lignes et que le motif `wrappedKey` existe déjà. Conséquence pour les couloirs N1 et N2 : la fiche du fournisseur lit ces colonnes avec `omit: { trainingConsentAt: false, trainingConsentVersion: false, trainingConsentRevokedAt: false }` (documenté dans 16 § 2) ; l'écriture n'est pas affectée.
- **Outil d'inventaire du runbook étendu** (`scripts/operations/db-inventory.mjs`, correctifs des deux tours) : sans cela, l'étape 6 du runbook sur cette migration aurait signalé quatre écarts « warning » (`UserProfile`, `DatasetAccessLog` et leurs `_pkey`) et rendu le code de sortie 1. Limitation préexistante (déjà vraie pour `OperatorCodeAttempt`), corrigée ici parce que cette migration est la première que le runbook de production devra passer avec des tables neuves. Fichier hors de la liste initiale de la slice, mais dans le couloir « schéma et migrations » ; le relecteur conformité a jugé le périmètre légitime.
- **Tests de route dans `profile.test.ts`** en plus de la validation demandée : les deux routes sont chargées par `ts.transpileModule` + `runInNewContext` avec `requireAuth`, `@/lib/db` et le module profil simulés, ce qui prouve que l'adresse vient de la session et que le vrai code de validation est exercé par la route.
- **Aucune interface** : pas de composant, pas de page, pas d'appel client. Les couloirs tutos et réglages consomment `GET`/`PATCH /api/profile`.

### 3. Ce que l'audit doit vérifier

**Contrôle d'accès, route par route**

- `GET /api/profile` : `requireAuth(req)` (`src/lib/auth/require-auth.ts`) lit le cookie de session signé HMAC ; sans session → 401 avant toute lecture de base. L'adresse est `session.address`, jamais un paramètre. `assertMutationOrigin` ne contrôle pas l'origine sur GET (comme pour toutes les routes GET du dépôt), le cookie `sameSite: lax` protège la lecture croisée.
- `PATCH /api/profile` : `requireAuth` applique `assertMutationOrigin` (en-tête `Origin` égal à `SIRIUS_APP_ORIGIN`, `Sec-Fetch-Site` same-origin ou none) puis la session. L'adresse vient de la session ; un champ `address` dans le corps est refusé en 400 par la validation (clé inconnue). Vérifié par test et par requêtes forgées contre la vraie route (section 10) : le profil de l'autre wallet reste intact.
- `POST /api/auth/verify` : inchangé en termes de contrôle ; le profil est touché **après** `verifyLoginSignature` et `verifyChallenge`, avec l'adresse vérifiée. Une signature invalide ou un challenge refusé ne crée aucun profil (testé).
- Aucune route ne lit ni n'écrit `DatasetAccessLog` : aucune exposition.
- Aucune route ne modifie `kybStatus`, `kybCheckedAt`, `blockedAt`, `blockedReason`, `blockedBy`. Ils ne sont écrits par aucun code de cette slice.
- Aucun contrôle ne repose sur un lien masqué : les gardes sont serveur, route par route.

**Validation et bornes de chaque entrée**

- Corps du PATCH : `readJson(req, 4096)` exige `content-type: application/json`, refuse `Transfer-Encoding`, `Content-Encoding` non identity, `Content-Length` > 4096 (413 avant lecture), un JSON non objet (`null`, tableau, chaîne → 400 « JSON invalide »).
- `validateProfilePatch` : objet simple obligatoire ; `JSON.stringify(input).length > 2048` → 413 ; clés autorisées `tourCompletedAt` (booléen), `featureTours` (objet simple, clés parmi sept, valeurs booléennes), `settings` (`language` ∈ {`en`}, `sidebarCollapsed` booléen) ; toute autre clé → 400 ; objet vide → 400. `__proto__` et `constructor` créés par `JSON.parse` sont des propriétés propres et tombent dans « clé inconnue ».
- Adresse : `normalizeAddress` de `src/lib/evm/address.ts` (viem `isAddress` non strict puis minuscules) ; 400 « adresse du profil EVM invalide » sinon. Jamais contournable depuis le client puisque l'adresse vient de la session. La base refuse en plus toute adresse qui ne serait pas `0x` + 40 hexadécimaux minuscules.
- `recordDatasetAccess` : voir les bornes en section 2.
- `SET LOCAL lock_timeout = <n>` et `statement_timeout = <n>` : `n` est `Math.max(1, Math.floor(timeoutMs))`, calculé par le code (`LOGIN_PROFILE_TIMEOUT_MS` ou le paramètre de test), jamais une entrée utilisateur.

**Fuites possibles**

- Réponses : la vue est construite champ par champ (`toUserProfileView`), jamais par `...row`. `blockedReason`, `blockedBy` absents (testé : clés de la réponse énumérées).
- Journaux : `touchUserProfileAfterLogin` n'écrit que la classe d'erreur (`PrismaClientInitializationError`, `ProfileTimeout`, `ProfileSkipped`, `AppError`…) ; testé avec une erreur contenant l'adresse, un mot de passe et un hôte : aucun ne figure dans le message. `errorResponse` (existant) ne journalise que la classe des erreurs techniques.
- Cache : `cache-control: private, no-store` sur GET et PATCH.
- Un wallet ne peut pas deviner si un autre a un profil : aucune route n'accepte d'adresse.
- Catalogue public : les trois colonnes de consentement sont omises par défaut par le client Prisma ; vérifier qu'aucune lecture future n'utilise `select` explicite sur ces colonnes dans une route publique (l'`omit` ne s'applique pas à un `select`).

**Impact sur l'argent, l'escrow, les contrats, le moteur Phala**

- Aucun. Aucune transaction, aucun appel RPC, aucun appel runner. `kybStatus` est un cache d'affichage non alimenté : la source de vérité KYB reste le contrat (`src/lib/sirius/access.ts`, inchangé). Vérifier que personne ne lit `UserProfile.kybStatus` pour une décision d'accès dans un couloir futur.

**Base de données**

- Rejouer `prisma migrate deploy` sur une copie de staging : la migration est appliquée une fois, en une transaction, et ne touche pas aux lignes existantes.
- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` après déploiement : « No difference detected » (section 9), y compris avec les `CHECK` que Prisma ignore.
- `src/lib/postgres.integration.test.ts` rejoue toutes les migrations dans l'ordre sur une base neuve puis lance huit processus concurrents : vert (section 9).
- `scripts/check-evm-migration.ts` : « Préflight EVM validé » sur la base migrée (section 9).
- `UserProfile.address` : clé primaire plus `CHECK` minuscules ; `DatasetAccessLog.address` : `CHECK` minuscules. Toute écriture du code passe par `normalizeProfileAddress`/`normalizeAddress`.
- `featureTours` et `settings` : `JSONB NOT NULL DEFAULT '{}'`. La fusion se fait en mémoire dans une transaction `Serializable` (`serializableTransaction`, reprise ×3 sur 40001/40P01/P2034).
- Transaction de connexion : `$transaction` interactif Prisma avec l'adaptateur pg exécute `SET LOCAL` et l'upsert sur la même connexion ; un `lock_timeout` dépassé lève 55P03 côté PostgreSQL, rattrapé comme `PrismaClientKnownRequestError`.
- Runbook : `ops:db-inventory expect --migrations=20261003000000_add_user_profiles` doit lister `tablesAdded: [DatasetAccessLog, UserProfile]`, cinq colonnes sur `Dataset`, les colonnes des deux tables et quatre index ; `compare` avant/après ne doit donner aucun écart.

**Interface**

- Rien de rendu par cette slice. Les valeurs renvoyées sont des booléens, des chaînes fermées (`en`, statuts) et des dates ISO : aucun contenu libre fourni par l'utilisateur n'est stocké dans le profil.

**Textes**

- Aucun texte utilisateur nouveau en dehors des messages d'erreur, tous traduits dans `errors-en.ts` et vérifiés par `english.test.ts` (littéraux) et `profile.test.ts` (messages construits par gabarit, que `english.test.ts` ne voit pas). Aucune promesse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging

Préparation : une session ouverte dans le navigateur sur staging ; ouvrir la console et utiliser `fetch` avec `credentials: "include"`. Les PATCH doivent partir du site lui-même (en-tête `Origin` vérifié).

1. **Création au premier GET** : `fetch("/api/profile").then(r => r.json())` → 200, objet avec `address` en minuscules égal au wallet connecté, `featureTours: {}`, `settings: {}`, `tourCompletedAt: null`, `createdAt` égal à `lastSeenAt`. Rejouer : `createdAt` identique, `lastSeenAt` avancé.
2. **Sans session** : même appel en navigation privée → 401 `{"error":"Authentification requise"}`.
3. **Marquer un tuto** : `fetch("/api/profile",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({featureTours:{dashboard:true}})})` → 200, `featureTours: {dashboard: true}`.
4. **Fusion** : PATCH `{featureTours:{upload:true}}` → `featureTours: {dashboard: true, upload: true}` (le premier n'a pas disparu).
5. **Tuto terminé** : PATCH `{tourCompletedAt:true}` → `tourCompletedAt` daté. Rejouer → même date. PATCH `{tourCompletedAt:false}` → `null`.
6. **Champ protégé** : PATCH `{kybStatus:"ACCEPTED"}` → 400 « Champ de profil non modifiable », et GET montre `kybStatus: null`.
7. **Adresse dans le corps** : PATCH `{address:"0x000…dead", featureTours:{train:true}}` → 400 ; GET sur le wallet montre `train` absent.
8. **Tuto inconnu** : PATCH `{featureTours:{admin:true}}` → 400 « Tuto de profil inconnu ». `{featureTours:{dashboard:"yes"}}` → 400 « Tutos de profil invalides ».
9. **Langue** : PATCH `{settings:{language:"fr"}}` → 400 « Langue non prise en charge » ; `{settings:{language:"en",sidebarCollapsed:true}}` → 200.
10. **Vide et non-objet** : PATCH `{}` → 400 « Aucune modification de profil » ; corps `[]` ou `null` → 400 « JSON invalide » ; `content-type: text/plain` → 415.
11. **Trop gros** : PATCH avec une clé de 3000 caractères → 413 « Modification de profil trop volumineuse » ; corps de 10 Ko → 413 « Requête trop volumineuse ».
12. **Débit** : 21 PATCH en moins d'une minute → le 21ᵉ répond 429 « Trop de requêtes — réessaie plus tard », même avec un corps invalide. 61 GET → 429 au 61ᵉ.
13. **Origine** : depuis une autre origine (par exemple la console d'un autre site), PATCH → 403 « Origine de requête non autorisée ».
14. **Connexion** : se déconnecter, se reconnecter avec le wallet → la connexion réussit ; en base, `lastSeenAt` du profil est mis à jour. Avec un nouveau wallet, la ligne est créée.
15. **Base indisponible pendant la connexion** (environnement de recette seulement) : pointer `DATABASE_URL` vers un port fermé, se connecter → la connexion réussit, le journal serveur contient `[auth] profil utilisateur non mis à jour (PrismaClientInitializationError)` sans adresse.
16. **Base qui ne répond pas** (recette seulement) : en `psql`, `BEGIN; SELECT * FROM "UserProfile" WHERE address = '<wallet>' FOR UPDATE; SELECT pg_sleep(30);` puis se connecter avec ce wallet → la connexion réussit en environ 2 s, journal `(ProfileTimeout)` ; `SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle' AND query ILIKE '%UserProfile%'` ne montre que la session `psql` (la requête abandonnée a été annulée par `lock_timeout`). Trois connexions simultanées du même wallet dans cet état : au plus deux `(ProfileTimeout)`, les autres `(ProfileSkipped)`, les trois connexions réussies.
17. **Ligne altérée** : en base, `UPDATE "UserProfile" SET "featureTours" = '{"dashboard":true,"junk":1}'` → GET montre `{dashboard: true}` ; PATCH `{featureTours:{upload:true}}` → `{dashboard: true, upload: true}` et la clé `junk` a disparu de la ligne.
18. **Casse** : `INSERT INTO "UserProfile" (address) VALUES ('0xABAB…')` → refusé par `UserProfile_address_lowercase` ; `SELECT address FROM "UserProfile"` : tout en minuscules, une seule ligne par wallet.
19. **Consentement non public** : `UPDATE "Dataset" SET "trainingConsentAt" = now(), "trainingConsentVersion" = 'test' WHERE id = '<dataset LISTED>'` puis `GET /api/datasets/<id>` sans session → la réponse ne contient aucune clé `trainingConsent*` ni `wrappedKey`, mais contient `category` et `listingExpiresAt` (nuls). Remettre les deux colonnes à `NULL` ensuite.
20. **Migration** : `SELECT column_name FROM information_schema.columns WHERE table_name='Dataset' AND column_name IN ('category','listingExpiresAt','trainingConsentAt','trainingConsentVersion','trainingConsentRevokedAt')` → cinq lignes ; `SELECT count(*) FROM "DatasetAccessLog"` → 0 ; `SELECT conname FROM pg_constraint WHERE conrelid = '"UserProfile"'::regclass` → `UserProfile_pkey`, `UserProfile_address_lowercase`.
21. **Runbook** : `node scripts/operations/db-inventory.mjs expect --migrations=20261003000000_add_user_profiles` → `tablesAdded` avec les deux tables ; `compare` d'une photo prise avant et d'une photo prise après (avec `--before`) → `ok: true`, aucun écart.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

`src/lib/users/profile.test.ts`, quinze tests, dans le script `test` de `package.json` :

1. normalisation et refus des adresses invalides, y compris sur `ensureUserProfile` et `readUserProfile` ; `createdAt = lastSeenAt` à la création ; traductions explicites des trois messages construits par gabarit ;
2. `ensureUserProfile` crée puis ne fait que dater ;
3. reprise unique sur P2002, remontée des autres erreurs ;
4. vue sans `blockedReason`/`blockedBy`, filtrage d'une ligne altérée (`__proto__` comme propriété propre créée par `JSON.parse`) ;
5. `validateProfilePatch` : tous les refus (non-objet, vide, clés protégées, types, tutos et réglages inconnus, langue) ;
6. borne de taille à 413, et la plus grande modification légitime passe ;
7. fusion clé par clé, pose et effacement de la date du tuto, création du profil manquant par upsert avec dates cohérentes, course où la ligne apparaît entre la lecture et l'écriture, rien d'écrit si la validation échoue ;
8. `recordDatasetAccess` : normalisation, champs optionnels, dix-huit entrées invalides refusées sans écriture et avec un message traduit, P2003 → 404, autres erreurs inchangées ;
9. `touchUserProfileAfterLogin` : ne lève jamais, journal sans adresse ni cause, classe seule ;
10. base gelée abandonnée après le délai de garde (50 ms en test), avertissement `(ProfileTimeout)`, constante entre 1 et 5 s ;
11. plafond de deux mises à jour en vol (`ProfileSkipped`), reprise une fois les touches terminées, instructions `SET LOCAL lock_timeout`/`statement_timeout` émises avec le délai demandé quand le client sait ouvrir une transaction ;
11 bis. délais PostgreSQL de GET (`ensureUserProfileWithin`) et de PATCH, une seule transaction même quand le client de transaction expose `$transaction`, `ensureUserProfile` n'en ouvre jamais, P2034 épuisé → 409 traduit, autres erreurs inchangées ;
12. `GET /api/profile` : 200, `no-store`, clés de la réponse énumérées, 401 sans session, casse mixte ;
13. `PATCH /api/profile` : isolation entre wallets, refus d'`address` et des champs protégés, codes 400/413/415/401 ;
14. limites de débit : 20 PATCH puis 429 y compris sur un corps invalide (le limiteur précède la validation), 60 GET puis 429 ; sur la même instance de route (donc les mêmes limiteurs), un autre wallet passe et le premier reste refusé ;
15. `POST /api/auth/verify` : profil touché avec l'adresse vérifiée en minuscules, connexion réussie malgré une base en panne et malgré une base gelée, aucun profil sans preuve de possession ni quand le challenge est refusé.

`src/lib/db.test.ts` : garde de source sur l'`omit` global (les quatre colonnes doivent rester `true`).
`scripts/operations/db-inventory.test.ts` (dans `test:operations`) : attentes lues dans la migration A1 (tables, colonnes, clés primaires, index), table historique à colonne énumérée (`KeyGrant.status`) correctement lue, comparaison avec et sans attentes (`ok` vrai, aucun écart), table, colonne ou index annoncés mais absents en critique ; le test PostgreSQL existant rejoue toutes les migrations dont A1. Les bases gelées des tests de connexion sont libérées en `afterEach` : un échec d'assertion ne laisse plus de touche en vol pour les tests suivants.

**Ce qu'ils ne couvrent pas**

- Le vrai client Prisma : les tests utilisent une base en mémoire. Le comportement réel (upsert `ON CONFLICT`, transaction sérialisable, JSONB, clé étrangère, `CHECK`, annulation par `lock_timeout`) a été vérifié par des scripts manuels sur PostgreSQL 16 local (section 9), non versionnés.
- La concurrence réelle de PATCH et le verrou de ligne (couverts par les scripts manuels et par les relecteurs, pas par un test automatique).
- `assertMutationOrigin` sur PATCH : `requireAuth` est simulé dans les tests de route ; l'origine est couverte par les tests existants de `src/lib/http/security.test.ts` et a été éprouvée par les relecteurs avec la vraie garde.
- Le limiteur global (`maxGlobal`).
- L'`omit` global n'est vérifié que sur la source de `db.ts` (le client ne l'expose pas), plus un essai manuel (cas 19).
- Les contraintes `CHECK` sont vérifiées par le test d'intégration PostgreSQL, mais l'outil d'inventaire ne les photographie pas : leur disparition lors d'une future migration ne serait pas signalée par `compare`.
- La fausse base ne modélise pas P2025 ; P2003 est simulé par un stub qui lève.
- Le build Next.js de la route est couvert par `pnpm build` (section 9), pas par un test.

### 6. Hypothèses

- Prisma 7 avec `@prisma/adapter-pg` compile l'upsert en `INSERT … ON CONFLICT` (vérifié au journal des requêtes sur PostgreSQL 16 local), et exécute une transaction interactive sur une seule connexion (vérifié : `SET LOCAL` suivi de l'upsert, annulation observée). Non vérifié sur Neon ou derrière un pooler en mode transaction ; `SET LOCAL` reste correct derrière PgBouncer en mode transaction puisque tout est dans une transaction.
- La base de staging accepte `JSONB`, `CURRENT_TIMESTAMP` et les `CHECK` avec expression régulière sans extension (PostgreSQL ≥ 9.4).
- Les sessions ouvertes avant le déploiement restent valides (cookie inchangé) et obtiennent leur profil au premier GET ou PATCH.
- `FixedWindowRateLimiter` et le compteur de mises à jour en vol sont en mémoire par instance : sur Vercel, chaque instance a les siens. Même limite que les autres routes du dépôt.
- `serializableTransaction` reprend au plus trois fois ; au-delà, l'erreur remonte en 500 opaque « Erreur interne — réessaye. ». Jugé acceptable pour une écriture de confort (tutos, réglages) : observé une fois sur cinq tours de sept PATCH simultanés sur la même ligne, jamais avec deux à quatre écrivains.
- `Dataset.category` est stocké en texte libre ; la liste fermée est tenue par le code de l'upload (couloir N2). Une valeur hors liste en base n'est pas empêchée par un `CHECK`.
- Le format de `modelFingerprint` sera fixé par le couloir qui branche la livraison (hexadécimal SHA-256 attendu).
- `prisma migrate dev --create-only` sur une base jetable produit une migration vide avec les `CHECK` en place (vérifié par un relecteur) ; `migrate dev` et `reset` rejouent les fichiers SQL et les recréent ; seul `prisma db push` les perdrait, et le dépôt ne l'utilise pas.
- `prisma migrate deploy` n'applique pas un fichier de migration en une transaction (démontré par un relecteur avec un fichier dont le second ordre échoue : le premier reste appliqué). La migration A1 est donc à appliquer par la pipeline sur une base sauvegardée, avec la procédure du runbook en cas d'échec.

### 7. Risques résiduels et limites connues

- **Pause = `UNLISTED`** : un dataset en pause reste empruntable par lien direct tant que le couloir des prêts n'en décide pas autrement. Documenté dans 16 § 2.
- **`listingExpiresAt` absent** sur les datasets existants : la marketplace doit traiter `null` comme « sans expiration » sous peine de masquer tout le catalogue actuel.
- **Limiteurs par instance** : la limite réelle sur Vercel est multipliée par le nombre d'instances chaudes ; même chose pour le plafond de mises à jour en vol.
- **`blockedAt` exposé** sans mécanisme de blocage effectif : aucune route ne refuse encore un wallet bloqué. Le blocage est prévu après le 6 (15-dashboard-admin.md).
- **`kybStatus` non alimenté** : reste `null` tant que le couloir KYB ne l'écrit pas ; l'interface ne doit pas interpréter `null` comme « non vérifié » sans consulter le contrat.
- **`DatasetAccessLog` non alimenté** : le traçage annoncé dans les conditions d'utilisation ne sera effectif qu'une fois `recordDatasetAccess` branché sur la livraison du modèle.
- **Connexion plus lente d'un aller-retour base**, au plus 2 s de plus si la base ne répond pas ; au-delà de deux mises à jour en vol, `lastSeenAt` n'est pas daté pour les connexions suivantes tant que la base ne répond pas (journal `ProfileSkipped`).
- **Contention extrême sur un même profil** : un 409 « Profil modifié en même temps, réessaie » après trois reprises sérialisables (mesuré : jamais avec deux à quatre écrivains simultanés, environ un tiers des écritures avec quarante) ; aucune écriture perdue, le client rejoue.
- **Ligne verrouillée par une autre session** : GET et PATCH échouent en 5 s (500 opaque) au lieu d'attendre ; la connexion continue sans profil après 2 s.
- **`omit` global et `select`** : une future lecture qui utilise `select` explicite sur les colonnes de consentement n'est pas protégée par l'`omit`.
- **Outil d'inventaire** : il vérifie l'existence d'une table créée, ses colonnes, sa clé primaire et ses index, mais pas les types ni les contraintes `CHECK` d'une table neuve.

### 8. Reste à faire

| Priorité | Quoi | Où |
|---|---|---|
| P0 | Brancher `recordDatasetAccess` sur la livraison de la clé du modèle, dans la même transaction | couloir N4 ou livraison (`src/lib/sirius/*`) |
| P0 | Faire lire `status = LISTED` et `listingExpiresAt` (null ou futur) par la marketplace et dériver les états des cartes | couloirs N1, N3 |
| P0 | Écrire `category`, `listingExpiresAt`, `trainingConsent*` à l'upload et depuis la fiche, en ré-incluant le consentement à la lecture (`omit: { …: false }`) | couloirs N2, N1 |
| P1 | Décider si la pause ferme l'emprunt par lien direct (`UNLISTED`) | couloir des prêts |
| P1 | Alimenter `kybStatus`/`kybCheckedAt` depuis le contrat, et préciser que `null` = inconnu | couloir A6 |
| P1 | Poser `connectionTimeoutMillis`, `statement_timeout` ou `lock_timeout` globaux dans `src/lib/db.ts` : toutes les routes partagent aujourd'hui un pool sans délai, la slice n'a protégé que la connexion | socle, après le 6 |
| P2 | Refus des wallets bloqués (`blockedAt`) dans `requireAuth` ou une garde dédiée, et route admin de blocage | après le 6 (15) |
| P2 | Lecture admin du journal des accès | après le 6 (15) |
| P2 | Fusion atomique en SQL (`ON CONFLICT … SET "featureTours" = "featureTours" \|\| EXCLUDED."featureTours"`) pour supprimer la classe des conflits sérialisables sur le profil | socle |
| P2 | Photographier les contraintes `CHECK` dans `ops:db-inventory` pour que `compare` signale leur disparition | outillage |

### 9. Résultats des vérifications

Environnement : conteneur Linux, Node 22.22.0, pnpm 11.18.0, PostgreSQL 16.14 lancé localement à partir des binaires du système (Docker indisponible dans le conteneur : `docker info` échoue, aucun démon ; `initdb` lancé sous l'utilisateur `postgres`). Toutes les commandes lancées depuis la racine du dépôt sur la branche `feat/socle-profils`, à son état final (`eb1b09d`, après le dernier correctif), avec `DATABASE_URL="postgresql://ci:ci@localhost:5432/ci?schema=public"` comme en CI. La même séquence avait été passée en vert sur chaque état intermédiaire (`27d3f35`, `aa9bb6c`, `e9ed707`, `f515d25`).

| Commande | Résultat |
|---|---|
| `pnpm install --frozen-lockfile` | `Done in 553ms using pnpm v11.18.0`, code 0 (premier passage, cache vide : `Done in 3.8s`, `postinstall: ✔ Generated Prisma Client (7.8.0)`). Sans `DATABASE_URL`, le postinstall échoue sur `PrismaConfigEnvError` : comportement préexistant du dépôt, la CI fournit la variable. |
| `pnpm prisma generate` | `✔ Generated Prisma Client (7.8.0) to ./src/generated/prisma`, code 0 |
| `pnpm prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `pnpm prisma migrate deploy` sur une base neuve | `All migrations have been successfully applied`, 13 migrations dont `20261003000000_add_user_profiles` |
| `pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (base neuve migrée) | `No difference detected`, code 0 |
| `pnpm prisma migrate status` | `13 migrations found`, `Database schema is up to date!` |
| `INSERT` en casse mixte dans `UserProfile` et `DatasetAccessLog` (base neuve) | `violates check constraint "UserProfile_address_lowercase"` et `"DatasetAccessLog_address_lowercase"` ; l'insertion en minuscules passe |
| `EVM_NETWORK=testnet node --import tsx scripts/check-evm-migration.ts` (base migrée) | `Préflight EVM validé`, code 0 |
| `pnpm exec tsc --noEmit` | code 0, aucune erreur |
| `pnpm lint` | code 0, aucune remarque |
| `pnpm test` (après `pnpm datasets:generate` comme en CI) | `# tests 446`, `# pass 446`, `# fail 0`, code 0 |
| `node --import tsx --test src/lib/users/profile.test.ts` | `# tests 16`, `# pass 16`, `# fail 0` |
| `pnpm test:operations` (avec `SIRIUS_TEST_DATABASE_URL`, donc le test PostgreSQL de l'inventaire inclus) | `# tests 83`, `# pass 83`, `# fail 0`, `# skipped 0`, code 0 |
| `pnpm test:postgres` | `ok 1 - migrations additives et quotas sur PostgreSQL entre huit processus`, `# pass 1`, code 0 |
| `pnpm test:phala-demo` | `# tests 24`, `# pass 24`, code 0 |
| `pnpm audit:deps` | `2 vulnerabilities found`, `Severity: 1 low \| 1 high (1 ignored)`, code 0 : état identique à `staging`, aucune dépendance ajoutée |
| `pnpm build` | `✓ Compiled successfully` (34,7 s au premier passage complet, 1,2 s avec le cache au dernier), route `ƒ /api/profile` présente, code 0 |
| Script manuel sur PostgreSQL local : dix tours de quatre écritures concurrentes sur un profil absent (trois PATCH sur des clés différentes et une connexion) | « 40 réussites, 0 rejets », fusion complète et une seule ligne à chaque tour |
| Script manuel sur PostgreSQL local : `ensure`, `patch`, trois PATCH concurrents sur des clés différentes, `tourCompletedAt`, `recordDatasetAccess`, clé étrangère, dix connexions simultanées | Fusion complète `{dashboard, upload, train}` et `{language, sidebarCollapsed}` ; `P2003` sur un dataset inexistant (désormais 404) ; une seule ligne après dix `touchUserProfileAfterLogin` simultanés ; JSONB brut conforme |
| Script manuel : ligne du profil verrouillée par `SELECT … FOR UPDATE` en `psql` pendant 12 s, puis `ensureUserProfileWithin` (chemin de GET) et `updateUserProfile` (chemin de PATCH) | « GET échoue en 5038 ms : DriverAdapterError / 57014 », « PATCH échoue en 5017 ms : DriverAdapterError / 57014 », « pool libre : SELECT 1 en 2 ms » |
| Script manuel : ligne du profil verrouillée par `SELECT … FOR UPDATE` en `psql` pendant 6 s, quatre `touchUserProfileAfterLogin` simultanés avec un délai de 300 ms | « 4 touches sous verrou rendues en 302 ms », journal : deux `(ProfileTimeout)`, deux `(ProfileSkipped)` ; « requêtes encore actives sur UserProfile après le délai : 1 (celle de psql) » ; « pool libre : SELECT 1 en 1 ms » |
| Script manuel : `datasetResponse()` sur un dataset avec consentement rempli | clés `trainingConsent*` et `wrappedKey` absentes, `category` et `listingExpiresAt` présentes ; ré-inclusion par `omit: { …: false }` fonctionnelle |
| `git diff --name-only staging...HEAD` | 15 fichiers : `docs/MIGRATION-RUNBOOK.md`, `docs/passage-mainnet/16-socle-technique.md`, `package.json`, `prisma/migrations/20261003000000_add_user_profiles/migration.sql`, `prisma/schema.prisma`, `scripts/operations/db-inventory.mjs`, `scripts/operations/db-inventory.test.ts`, `src/app/api/auth/verify/route.ts`, `src/app/api/profile/route.ts`, `src/lib/db.test.ts`, `src/lib/db.ts`, `src/lib/i18n/errors-en.ts`, `src/lib/postgres.integration.test.ts`, `src/lib/users/profile.test.ts`, `src/lib/users/profile.ts` (plus `docs/passage-mainnet/audit.md`, cette section). Aucun fichier interdit. |
| `git log staging..HEAD --format=%B \| grep -i "claude\|co-authored\|anthropic\|skip ci"` | aucune occurrence ; `ls CLAUDE.md AGENTS.md .claude` : absents |

### 10. Revue interne de la session

Méthode : quatre relecteurs indépendants, chacun sous un angle (sécurité et contrôle d'accès ; exactitude, migration et cohérence de la base ; tests et cas limites ; conformité au cahier des charges et aux conventions), avec accès au dépôt, à la base PostgreSQL locale migrée et au droit d'écrire des scripts d'attaque hors du dépôt. Chaque défaut remonté a ensuite été soumis à trois contradicteurs indépendants chargés de le réfuter, chacun sous une lentille distincte (exploitabilité, lecture du code, importance). Un défaut est « confirmé » quand au moins deux contradicteurs sur trois le jugent réel et digne d'une correction. Le premier passage a été interrompu volontairement pendant la phase de vote, une fois les défauts importants confirmés et corrigés : les votes restants auraient porté sur un code déjà modifié, et un second passage complet a été relancé sur le code corrigé (deux commits), avec la liste des défauts du premier passage, pour vérifier les corrections et chercher autre chose, jusqu'à deux tours consécutifs sans rien de nouveau. « Non voté » ci-dessous signifie que l'interruption est survenue avant les trois votes ; la suite donnée repose alors sur la reproduction par le ou les relecteurs et sur ma propre lecture.

**Ce que les relecteurs ont tenté sans trouver de défaut** (synthèse des quatre rapports) :

- requêtes forgées contre la vraie route avec le vrai `requireAuth` (`assertMutationOrigin` + cookie HMAC signé) et le vrai Prisma, `NODE_ENV=production` : PATCH sans `Origin` → 403, `Origin` tiers → 403, `sec-fetch-site: cross-site` → 403, GET sans cookie → 401 ; aucune façon de passer une adresse hors session ;
- champs protégés (`kybStatus`, `kybCheckedAt`, `blockedAt`, `blockedReason`, `blockedBy`, `address`, `createdAt`, `lastSeenAt`) refusés en 400 ; `blockedReason` et `blockedBy` absents de la réponse ;
- pollution de prototype (`__proto__`, `constructor.prototype`, `toJSON`, `toString`, clés unicode et zéro-largeur) → 400 sans effet sur `Object.prototype` ;
- bornes : 2048 caractères pile acceptés puis rejetés sur clé inconnue, 2049 → 413 ; corps de 4096 octets → 413 « Modification de profil trop volumineuse », 4097 → 413 « Requête trop volumineuse » ; `Content-Length` faux, `transfer-encoding`, `content-encoding: gzip`, `text/plain`, BOM, JSON imbriqué sur 500 niveaux, clés JSON dupliquées, `Date`, `NaN`, booléens en chaîne : tous refusés comme attendu ;
- débit : 21ᵉ PATCH → 429, 61ᵉ GET → 429, clé non forgeable (adresse de session signée) ;
- concurrence sur la vraie base : 5 PATCH simultanés sur un profil absent → 5 × 200 et une seule ligne ; 2, 3 et 4 écrivains concurrents sur 5 tours → aucune clé perdue ; 10 `touchUserProfileAfterLogin` simultanés → une ligne ;
- lignes JSONB altérées (`'null'`, `'[1,2]'`, `'"x"'`, `42`, objet avec `__proto__` et clés inconnues) → lues comme `{}` ou filtrées, puis réécrites proprement par PATCH ;
- migration : `prisma migrate diff` vide sur la base migrée et sur une base neuve après `migrate deploy` ; SQL généré par Prisma depuis l'état précédent équivalent au SQL manuscrit (seule différence : clé étrangère inline au `CREATE TABLE` plutôt qu'un `ALTER` séparé, sans effet) ; strictement additive ; `postgres.integration.test.ts` et `check-evm-migration.ts` non affectés ; la clé étrangère `RESTRICT` n'entrave aucun chemin existant (`pipeline.ts` ne supprime que des `DRAFT` sans CID) ;
- journaux : seule la classe d'erreur est écrite, aucune adresse ni cause pendant les scénarios de panne ; le profil est touché après `verifyLoginSignature` et `verifyChallenge`, avant `setSession` ;
- aucun autre test ne charge `verify/route.ts` par VM (pas de « Dépendance inattendue ») ; aucun fichier interdit touché ; aucune signature d'assistant ; doc 16 cohérente avec le schéma.

**Défauts remontés, vote des contradicteurs et suite donnée**

| Défaut | Angle | Gravité annoncée | Vote (réel / 3) | Suite |
|---|---|---|---|---|
| Une base qui ne répond pas (connexion acceptée, aucune réponse, pool saturé) suspend `/api/auth/verify` au lieu de laisser la connexion réussir : seul le cas « erreur levée » était rattrapé. Reproduit avec un serveur TCP muet : encore en attente après 15 s. | tests ; conformité | moyenne ; faible | non voté (voir note) | **Corrigé** : `touchUserProfileAfterLogin` court contre un délai de garde de 2 s (`LOGIN_PROFILE_TIMEOUT_MS`) via `Promise.race`, journalise `(ProfileTimeout)` et laisse la connexion continuer ; la requête en cours est abandonnée à son sort. Tests ajoutés : fonction seule avec un upsert qui ne résout jamais, et route de connexion avec base gelée → 200 et session posée. |
| `lastSeenAt` antérieur à `createdAt` sur un profil créé : `now` était capturé côté Node pour `lastSeenAt` et `tourCompletedAt`, `createdAt` posé par le défaut SQL quelques millisecondes plus tard. | sécurité ; base ; tests ; conformité | info à faible | 2 / 3 (deux fois, remonté sous deux titres) | **Corrigé** : `createdAt: now` passé explicitement dans les deux chemins de création. La fausse base des tests date désormais `createdAt` après coup comme `CURRENT_TIMESTAMP`, et trois assertions vérifient `createdAt = lastSeenAt` à la création et `tourCompletedAt` jamais antérieur à `createdAt`. |
| « adresse du profil EVM invalide » et « adresse du journal des accès EVM invalide » (messages construits par gabarit dans `normalizeAddress`) tombaient sur la règle dynamique et donnaient « Invalid EVM adresse du profil » ; `english.test.ts` ne voit que les littéraux. | sécurité ; tests ; conformité | info à faible | 2 / 3 | **Corrigé** : deux entrées explicites dans `errors-en.ts`, et une assertion dans `profile.test.ts` que la traduction ne contient plus « adresse ». |
| L'outil d'inventaire du runbook (`scripts/operations/db-inventory.mjs`) ne lisait pas les `CREATE TABLE` : la comparaison avant/après de cette migration aurait signalé quatre écarts « warning » (`UserProfile`, `DatasetAccessLog` et leurs `_pkey`) et rendu le code de sortie 1 à l'étape 6 du runbook. Limitation préexistante (déjà vraie pour `OperatorCodeAttempt`). | base | faible | 2 / 3 | **Corrigé** : `expectedChanges()` lit `CREATE TABLE` en `tablesAdded` et ajoute `<table>_pkey` aux index attendus ; `compareInventories()` ne signale plus une table annoncée et signale en critique (`table-not-added`) une table annoncée mais absente. Tests ajoutés dans `db-inventory.test.ts` (attentes de la migration A1, comparaison avec et sans attentes, table manquante). |
| Les nouvelles colonnes de consentement de `Dataset` sortiraient telles quelles sur les routes publiques du catalogue (`datasetResponse()` fait `{ ...dataset }`), dès que l'upload les remplira : trace contractuelle du fournisseur visible par un visiteur anonyme. | sécurité | faible | 1 / 3 | **Corrigé malgré un vote minoritaire** (deux contradicteurs sur trois l'ont jugé réel mais non bloquant tant qu'aucune route n'écrit ces colonnes) : la correction coûte quatre lignes et suit le motif existant de `wrappedKey`. `src/lib/db.ts` omet globalement `trainingConsentAt`, `trainingConsentVersion` et `trainingConsentRevokedAt` ; la fiche du fournisseur et l'admin les ré-incluent avec `omit: { …: false }` (documenté dans 16 § 2). Vérifié sur la base locale : `datasetResponse()` ne contient plus ces clés, `category` et `listingExpiresAt` restent publics, la ré-inclusion fonctionne. Pas de test automatique sur l'`omit` global (non introspectable) : point à vérifier à la main (section 4, cas 19). |
| La reprise sur P2002 dans `ensureUserProfile` ne peut pas s'exécuter sur PostgreSQL : Prisma compile l'upsert en `INSERT … ON CONFLICT DO UPDATE`, atomique. Le commentaire et le test décrivaient un chemin inexistant en production. | base | info | non voté (voir note) | **Corrigé dans le commentaire** : la reprise est présentée comme une ceinture pour le cas où Prisma retomberait sur le chemin non natif ; le code et le test sont conservés (ils ne nuisent pas et garantissent l'absence de boucle). |
| Sous forte contention sur un même profil (7 PATCH simultanés, 5 tours), une tentative a dépassé les trois reprises de `serializableTransaction` et a répondu 500 « Erreur interne — réessaye. » au lieu d'un statut réessayable ; aucune écriture perdue. | base | info | non voté (voir note) | **Écarté** : comportement commun à toutes les routes du dépôt, aucune perte de donnée, 2 à 4 écrivains simultanés n'y arrivent jamais, et le message invite déjà à réessayer. Noté en risque résiduel (section 7). |
| Limite de débit ajoutée sur GET, GET avec effet de bord (création et `lastSeenAt`). | conformité | info | non voté (voir note) | **Assumé et documenté** (16 § 1, section 2 ci-dessus) : GET écrit, donc il est limité. |
| `tourCompletedAt: false` efface la date ; `true` ne déplace pas une date déjà posée. | conformité | info | non voté (voir note) | **Assumé et documenté** dans 16 § 1 pour que le client n'envoie pas `false` par défaut. |
| `blockedAt`, `kybStatus`, `kybCheckedAt` exposés, `blockedReason` et `blockedBy` masqués. | conformité | info | non voté (voir note) | **Assumé et documenté** dans 16 § 1 : si un motif doit être montré après le 6, il lui faudra un champ public distinct. |
| Clé étrangère `DatasetAccessLog.datasetId` en `ON DELETE RESTRICT` : un futur script de purge devra détacher les journaux d'abord. | conformité | info | non voté (voir note) | **Assumé et documenté** dans 16 § 3. |

**Second passage, sur le code corrigé** (quatre relecteurs, mêmes angles, avec la liste ci-dessus) :

| Défaut | Angle | Gravité annoncée | Vote (réel / 3) | Suite |
|---|---|---|---|---|
| Le délai de garde rend la main mais l'upsert abandonné continue et garde sa connexion du pool (cinq par instance, sans `connectionTimeoutMillis`) ; reproduit avec un `SELECT … FOR UPDATE` tenu sur la ligne : sept connexions « réussies » en 300 ms, pool saturé derrière, écritures en rafale à la levée du verrou. Cinq connexions suffisent à bloquer toutes les routes de l'instance. | sécurité | moyenne | 1 / 1 collecté (les deux autres contradicteurs ont échoué faute de crédits d’usage) | **Corrigé** : l'upsert de connexion tourne dans une transaction courte sous `SET LOCAL lock_timeout` et `statement_timeout` égaux au délai de garde, pour que PostgreSQL annule la requête et rende la connexion ; et un compteur par instance (`MAX_IN_FLIGHT_LOGIN_TOUCHES = 2`) saute la mise à jour (`ProfileSkipped`) quand deux sont déjà en vol. Vérifié sur la base locale avec une ligne verrouillée : quatre connexions rendues en 301 ms, aucune requête du pool encore active après le délai, `SELECT 1` immédiat. Tests ajoutés : plafond en vol, reprise une fois les touches terminées, instructions `SET LOCAL` émises avec le délai demandé. |
| La casse minuscule de l'adresse n'est garantie que par le code : une écriture manuelle ou un futur chemin admin en casse EIP-55 crée un second profil invisible pour l'application (blocage ou cache KYB sans effet). Reproduit en psql : deux lignes pour un même wallet. | base ; sécurité | faible | non voté (crédits épuisés) ; remonté indépendamment par trois relecteurs (base, sécurité, tests) et reproduit en psql | **Corrigé** : contrainte `CHECK ("address" ~ '^0x[0-9a-f]{40}$')` posée dans le `CREATE TABLE` de `UserProfile` et de `DatasetAccessLog` (toujours additif, tables nouvelles seulement ; Prisma ignore les `CHECK` et `migrate diff` reste vide). Vérifié : insertion en casse mixte refusée, en minuscules acceptée, `migrate deploy` sur base neuve puis `migrate diff` « No difference detected ». |
| `recordDatasetAccess` sur un dataset inexistant lève une `PrismaClientKnownRequestError` P2003 brute (500 opaque une fois branchée). | base | info | non voté (crédits épuisés) ; reproduit sur la base locale | **Corrigé** : P2003 converti en `AppError("Dataset introuvable", 404)` (chaîne déjà traduite) ; test ajouté, les autres erreurs remontent telles quelles. |
| Le runbook de migration décrivait `ops:db-inventory expect` sans les tables, et ne disait pas que `table-not-added` est critique. | conformité | faible | non voté (crédits épuisés) | **Corrigé** : description de l'outil et paragraphe sur les migrations qui créent des tables dans `docs/MIGRATION-RUNBOOK.md`. |
| `compare` ne contrôlait ni les colonnes des tables créées ni les index annoncés mais absents. | conformité ; tests | info | non voté | **Corrigé** : `expectedChanges` lit les colonnes de chaque `CREATE TABLE` (y compris un type énuméré entre guillemets, piège trouvé par le test sur `KeyGrant.status`) ; `compare` signale `column-not-added` sur une table neuve et `index-not-added` en critique ; tests ajoutés. Limite restante (types et `CHECK` d'une table neuve non vérifiés) documentée dans le runbook. |
| GET écrit `lastSeenAt` à chaque lecture, ce que la doc 16 ne disait pas. | conformité | info | non voté | **Corrigé dans la doc** (16 § 1). |
| L'`omit` global du consentement n'était couvert par aucun test. | tests | faible | non voté | **Corrigé** : garde de source dans `src/lib/db.test.ts` sur les quatre clés de l'`omit`. |
| « Entrée du journal des accès invalide » (message passé en paramètre, invisible pour `english.test.ts`) n'était asserté par aucun test. | tests | faible | non voté | **Corrigé** : chaque rejet de `recordDatasetAccess` est vérifié traduit ; la boucle des messages par gabarit l'inclut. |
| Test de débit PATCH au message trompeur, limite GET non exercée. | tests | info | non voté | **Corrigé** : corps invalide après le quota → 429 (prouve l'ordre limiteur puis validation) ; 61ᵉ GET → 429 ; limite par wallet. |
| L'ordre « profil après `verifyChallenge` » n'était pas établi par le test de connexion. | tests | info | non voté | **Corrigé** : un challenge refusé avec signature valide ne touche aucun profil et ne pose aucune session. |
| Périmètre des correctifs (`src/lib/db.ts`, `scripts/operations/*`). | conformité | info | non voté | **Jugé légitime** par le relecteur : petits, testés, dans le couloir « schéma et migrations ». |

Le second passage s'est arrêté pendant la phase de vote et avant son second tour de recherche : les agents contradicteurs ont échoué faute de crédits d'usage (49 agents sur 54). Les suites données ci-dessus reposent sur la reproduction par les relecteurs (chaque défaut porte un script ou une commande exécutée contre la base locale) et sur ma propre vérification avant correction.

**Troisième passage, sur le code final** (quatre relecteurs, mêmes angles, avec la liste des deux premiers passages) :

| Défaut | Angle | Gravité annoncée | Vote (réel / 3) | Suite |
|---|---|---|---|---|
| Dans `updateUserProfile`, la branche « profil absent » faisait `findUnique` puis `create` : si la ligne apparaissait entre les deux (connexion dans un autre onglet, GET du shell), le `create` levait une violation d'unicité (P2002) que `serializableTransaction` ne reprend pas (elle ne couvre que 40001/40P01/P2034), d'où un 500 opaque. Reproduit sur la base locale en insérant la ligne entre la lecture et l'écriture. | sécurité | faible | 0 / 3 sur le code final (déjà corrigé quand les contradicteurs ont voté ; un contradicteur a confirmé le défaut sur `e9ed707`) | **Corrigé** : la création passe par `upsert` (`INSERT … ON CONFLICT`, atomique) ; test de course ajouté (la ligne apparaît après la lecture, l'écriture aboutit, une seule ligne) ; quarante écritures concurrentes sur profil absent (trois PATCH et une connexion par tour, dix tours) sur PostgreSQL : aucun rejet, fusion complète à chaque tour. |
| Le paragraphe ajouté au runbook disait que l'outil d'inventaire ne vérifie pas les colonnes d'une table créée, alors que le même commit ajoutait ce contrôle. | base | faible | 0 / 1 collecté (déjà corrigé par `3dbd044` quand le contradicteur a voté) | **Corrigé** : phrase remplacée par ce que l'outil vérifie réellement (existence, clé primaire, colonnes, index annoncés) et sa vraie limite (types, nullabilité, défauts et `CHECK` d'une table neuve). |
| Plafond global du limiteur de lecture (1 000/min/instance) atteignable avec dix-sept sessions : 429 pour tous les wallets de l'instance pendant la minute. Motif commun du dépôt. | sécurité | info | 0 / 3 (comportement voulu, commun au dépôt, documenté) | **Documenté** dans 16 § 1 : plafonds globaux explicités, à relever si le shell lit le profil à chaque page. |
| `GET /api/profile` (et `PATCH`) sans délai PostgreSQL : une ligne de profil verrouillée par une autre session suspendait chaque GET du wallet sans borne, et cinq GET retenaient tout le pool de l'instance (reproduit : « STILL PENDING après 9002 ms », `dataset.count()` bloqué derrière). Le correctif du second passage ne couvrait que la connexion. | tests | moyenne | non voté (revue arrêtée) ; reproduit sur la base locale par le relecteur et par moi | **Corrigé** : `ensureUserProfileWithin` (transaction courte sous `SET LOCAL lock_timeout`/`statement_timeout` à 5 s) pour GET, mêmes délais en tête de la transaction de PATCH. Une première version faisait ouvrir la transaction par `ensureUserProfile` quand le client le permettait : le client de transaction Prisma expose encore `$transaction` à l'exécution, l'appel s'imbriquait jusqu'à épuiser le pool (découvert à l'essai réel, pas par le test, dont le faux client n'avait pas `$transaction`). Corrigé avant commit, test de non-régression ajouté (une seule transaction même avec un faux client fidèle), vérifié sous verrou réel : échec en 5 s, pool libre. |
| Assertion « la limite est par wallet » tautologique : chaque chargement de la route recréait les limiteurs. | tests | moyenne | non voté | **Corrigé** : session mutable sur une seule instance de route ; le quota épuisé pour un wallet, un autre wallet passe (GET et PATCH) et le premier reste refusé. |
| Bases gelées libérées en fin de corps de test, pas en `finally` : un échec en cascade masquerait la cause. | tests | faible | non voté | **Corrigé** : toute base gelée est enregistrée et libérée en `afterEach`. |
| Filtre mort dans le test de table créée (`column-not-added:Dataset.*`), qui laissait croire à des écarts tolérés. | tests | info | non voté | **Corrigé** : filtre retiré, `ok` vrai et aucun écart assertés, commentaire sur ce que la photo synthétique ne couvre pas. |
| Le runbook affirmait que `prisma migrate deploy` applique chaque fichier en une transaction « tout ou rien » ; démontré faux par le relecteur (fichier dont le second ordre échoue : le premier reste appliqué, migration marquée non terminée). | conformité | moyenne | non voté ; reproduit par le relecteur | **Corrigé** : phrase remplacée par la réalité et la procédure en cas d'échec (constater l'état, nettoyer, `migrate resolve --rolled-back`, relancer). Hypothèse ajoutée en section 6. |
| Les `CHECK` n'étaient couverts par aucun test. | conformité | faible | non voté | **Corrigé** : assertions dans `src/lib/postgres.integration.test.ts` (casse mixte refusée avec le nom de la contrainte, minuscules acceptées, sur les deux tables). La photographie des `CHECK` par l'inventaire est en reste à faire. |
| Docs 16 ne mentionnait pas la contrainte de casse que les scripts et le couloir admin doivent connaître. | conformité | faible | non voté | **Corrigé** : phrases ajoutées en 16 § 1 et § 3. |
| Le message du commit `f515d25` disait « quarante écritures concurrentes sans rejet » ; le relecteur mesure treize à quinze rejets P2034 sur quarante écrivains simultanés avec un pool de cinq. | conformité | info | non voté | **Précisé** : ma mesure portait sur dix tours successifs de quatre écrivains simultanés (quarante écritures, zéro rejet) ; à quarante écrivains simultanés sur la même ligne, un tiers échoue après les reprises. Depuis `eb1b09d`, cet échec répond 409 réessayable ; la fusion atomique en SQL est en reste à faire. |

Le troisième passage a été arrêté pendant la phase de vote : les votes collectés (sept) portaient sur des défauts déjà corrigés par les commits intermédiaires, et chaque constat restant avait été reproduit par son relecteur avec une commande ou un script contre la base locale.

Ce que le troisième passage a vérifié sans trouver de défaut (relecteurs base et sécurité, par exécution) : base neuve, `migrate deploy`, `migrate diff` vide, redéploiement idempotent ; `prisma migrate dev --create-only` sur base jetable produit une migration vide (les `CHECK` ne sont pas vus comme une dérive et sont préservés) ; les deux `CHECK` rejettent la casse EIP-55, une adresse de 41 octets et un retour à la ligne final ; transaction interactive sur une seule connexion (`pg_backend_pid()` identique), `SHOW lock_timeout` à la valeur demandée dans la transaction et 0 hors transaction ; ligne verrouillée par une autre session → touche abandonnée au délai, backend vu en `ROLLBACK` puis idle, aucune ligne fantôme après `ROLLBACK` du détenteur ; `statement_timeout` précède `lock_timeout` à budget égal (erreur 57014, classe `DriverAdapterError` journalisée sans adresse) ; pool de cinq saturé par cinq transactions tenues → les touches reviennent après l'attente maximale de Prisma, compteur en vol libéré ; base « trou noir » → compteur libéré en moins de 3 s ; le plafond en vol ne peut pas être tenu par un attaquant (la seule attente contrôlable est un verrou sur son propre profil, et aucun chemin client ne garde une transaction ouverte) ; `$executeRawUnsafe` ne reçoit qu'un entier calculé par le code ; l'`omit` global n'est contourné par aucun `select` ni `$queryRaw` du dépôt ; pollution de prototype à tous les niveaux → 400 ; bornes exactes 4096/4097 octets et 2048/2049 caractères ; session à adresse non EVM → 400 sans écriture ; `FOREIGN KEY RESTRICT` sans régression ; `postgres.integration.test.ts` et `db-inventory.test.ts` verts sur PostgreSQL ; suite complète 445/445, typage et lint propres.

**Angles morts signalés par les relecteurs, non corrigés** : la fausse base des tests ne modélise ni P2003 ni P2025 (un `recordDatasetAccess` sur un dataset inconnu donne un 500 opaque, observé sur la vraie base : acceptable tant que `datasetId` vient d'un prêt) ; le limiteur GET et les en-têtes `Content-Length` faux ne sont pas testés dans `profile.test.ts` (couverts par `security.test.ts` et vérifiés à la main) ; l'assertion « la plus grande modification légitime passe la borne » compare environ 150 caractères à 2048 et n'apporte presque rien.

**Vérifications relancées après correction** (section 9, colonne « après revue ») : typage, lint, suite complète, tests d'exploitation avec PostgreSQL, test d'intégration PostgreSQL, tests Phala, audit des dépendances, build.

---

## A2 — Composants et textes partagés

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A3 — Tutos de première connexion et par page

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A4 — Avertissements et conditions d'utilisation

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A5 — Bouton profil et page Wallet

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A6 — Réglages et KYB

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A7 — Explorer

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A8 — Passage à USDG

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N1 — Mes datasets

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N2 — Upload en deux étapes

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N3 — Marketplace

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N4 — Train

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N5 — Self training réservé à l'équipe

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N6 — Certificat d'exécution

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

