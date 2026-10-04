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
| `git log staging..HEAD --format=%B` passé au crible des motifs de signature d'assistant (nom de l'assistant, ligne de co-auteur, mention de génération automatique, lien de session) et de `[skip ci]` | aucune occurrence ; aucun fichier ni dossier de configuration d'assistant dans l'arbre (ceux que le cahier des charges interdit de versionner) |

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

Branche `feat/composants-partages`, partie de `staging` (2990a9f). Aucune page existante n'est modifiée : les composants ne sont donc utilisés par aucune page tant que les autres slices ne les branchent pas. Tout ce qui suit décrit du code **non encore exercé en production**.

### 1. Ce qui a changé

Aucune route, table, colonne, migration, contrat ni appel réseau. Uniquement des fichiers sous les chemins autorisés (`git diff --name-only staging...HEAD` : 17 fichiers, tous listés ici).

**Textes communs (`src/lib/copy/`)**
- `disclaimers.ts` : `CONTACT_EMAIL` (`sirius.data.contact@gmail.com`), `DISCLAIMER_IDS`, `DISCLAIMERS` (clé française + variables pour `modelQuality`, `contactUs`, `betaLimits`, `retrainDeterministic`, `dataLimits`), `disclaimerText(id, t)`, `dataLimitsVariables(limites)`, `contactMailtoHref(objet?)`. Les limites sont **lues** : `MAX_DATASET_BYTES` (`src/lib/tee/contract.ts`), `MAX_CSV_ROWS` (`src/lib/sirius/metrics.ts`), `MIN_TRAINING_ROWS` et `MAX_TRAINING_FEATURES` (`src/lib/tee/train.ts`).
- `numbers.ts` : `groupDigits`, `formatCount`, `formatLimitBytes` (séparateur de milliers écrit à la main, pas de `toLocaleString`, pour que serveur et navigateur produisent la même chaîne).

**Composants d'interface (`src/components/ui/`)**
- `DisclaimerNote.tsx` : `<DisclaimerNote variant="info"|"warning" messages={DisclaimerId[]} className>{contenu de page}</DisclaimerNote>`. Par défaut `modelQuality` puis `contactUs`. Le texte de contact devient un lien `mailto:` vers `CONTACT_EMAIL`.
- `StatusPill.tsx` + `status.ts` : `<StatusPill status="online|borrowed|paused|expired|destroyed|pending|failed|refunded" />`. `status.ts` (pur) : `STATUS_KINDS`, `STATUS_META` (clé de libellé + variante de `Badge`), `STATUS_DOT_CLASS`, `isStatusKind`, `statusMeta` (repli « Unknown status » pour une valeur inattendue).
- `safe-href.ts` : `safeInternalHref(valeur)` ne laisse passer qu'un chemin interne (`/…`).
- `shared-components.render.tsx` (+ `shared-components.test.ts`) : script de rendu HTML statique, voir §5.

**Composants de datasets (`src/components/datasets/`)**
- `PriceBreakdown.tsx` + `price.ts` : `<PriceBreakdown providerAtomic computeAtomic token={{symbol, decimals}} minimumAtomic? perspective="neutral|provider|borrower" />`. `price.ts` (pur) : `parseAtomic`, `isValidDecimals`, `formatTokenAmount`, `formatTokenWithSymbol`, `computePriceBreakdown`.
- `DatasetCard.tsx` : `<DatasetCard name category? modelId? modelVersion? rowCount? columnCount? sizeBytes? priceAtomic? priceKind="borrowerPays|providerReceives" token status borrowCount revenueAtomic? verified? href? />` et `<DatasetAddTile href />` (tuile « + Publier un dataset »).

**Traductions**
- `src/lib/i18n/shared-en.ts` (nouveau) : traductions anglaises, fusionnées dans `EN_MESSAGES` par `src/lib/i18n/english.ts` (+2 lignes : un import et un `...SHARED_MESSAGES_EN`). Clés déjà existantes réutilisées, non redéfinies : « En attente », « Profil absent », « {count} lignes », « {count} colonnes ».

**Tests et script**
- `package.json` : 4 fichiers ajoutés à la fin du script `test` (`disclaimers.test.ts`, `price.test.ts`, `status.test.ts`, `shared-components.test.ts`). Aucune autre ligne touchée.

### 2. Décisions et écarts par rapport au cahier des charges

1. **Constantes importées là où elles sont, rien déplacé.** La consigne ne prévoit un déplacement que si un module est réservé au serveur. Vérifié : `contract.ts` n'a que des `import type`, `metrics.ts` n'a aucun import, `train.ts` n'importe que `registry.ts` (viem) et `metrics.ts`, aucun des trois n'atteint `server-only`, un module Node ou la base. Je n'ai de toute façon pas le droit de modifier `src/lib/tee/` ni `src/lib/sirius/`. Le test d'égalité prévu en cas de déplacement est remplacé par les tests décrits en §5.
2. **Coût de `train.ts` côté client.** Importer `train.ts` pour deux constantes embarque en théorie le code d'entraînement. Mesuré par un relecteur : tree-shaké, `train.ts` pèse 21 octets ; sans tree-shaking, 5,2 Ko minifiés. `process.env` et `performance.now()` n'apparaissent que dans des corps de fonction, jamais à l'évaluation du module. Extraire les deux constantes dans un module minuscule serait plus propre mais sort du périmètre.
3. **Texte `dataLimits` conservé mot pour mot, alors qu'il est optimiste (écart connu, voir §7).** Le propriétaire impose le texte de `16-socle-technique.md`. Je ne l'ai pas modifié et je le signale.
4. **Clés de traduction françaises, texte anglais identique à `16`.** Les cinq textes anglais sont ceux du tableau de la section 4, au mot près (test d'égalité exacte). `contactUs` utilise un paramètre `{email}` pour pouvoir en faire un lien.
5. **Fichier de traduction séparé** (`shared-en.ts`) au lieu d'ajouter des lignes à `english.ts`, pour limiter les conflits de fusion avec les autres slices qui complètent `english.ts`. Même mécanisme que `errors-en.ts` et `phala-en.ts`. Conséquence : l'objet est fusionné par *spread*, le dernier gagne, donc une clé identique ajoutée plus tard dans `english.ts` avec une autre traduction écraserait silencieusement la nôtre. Aucune collision aujourd'hui (vérifié par script), aucun garde-fou automatique.
6. **« MB » = Mio.** `formatLimitBytes` affiche 3 × 1024 × 1024 octets comme « 3 MB » (comme `formatBytes` existant et comme le texte de `16`). Un reste est tronqué, jamais arrondi vers le haut (2,99 Mio donne « 2.9 MB »).
7. **Formateur de montants propre à la slice, pas `formatUsdcAtomic`.** `formatUsdcAtomic` dépend de `USDC_DECIMALS` global (lu dans l'environnement, avec une exception au chargement du module si hors bornes) et supprime les zéros finaux ; or le composant reçoit les décimales en paramètre et le cahier montre « 20,00 ». J'ai réutilisé `formatUnits` de viem (déjà utilisé dans `train/page.tsx`, `ComputeQuoteDialog.tsx`), puis : au moins deux décimales (« 20.00 »), toutes les décimales significatives sinon, milliers séparés par des virgules, jamais d'arrondi. Un test vérifie l'accord numérique avec `formatUsdcAtomic`. Écart par rapport à « utilise les helpers existants » : partiel, justifié ci-dessus.
8. **Jeton passé en paramètre, sans valeur par défaut.** `token={{ symbol, decimals }}` est obligatoire pour `PriceBreakdown` et `DatasetCard`. Le site écrit « USDC » en dur partout ; le mainnet doit afficher « USDG » (`01-decisions-avant-samedi.md`). Forcer l'appelant à choisir évite d'afficher le mauvais jeton ou de mauvaises décimales (6 sur mainnet, 18 sur le testnet, `USDC_DECIMALS_BY_NETWORK`). Il n'existe pas encore de fabrique centrale du jeton : chaque page devra le construire correctement.
9. **Bornes des montants.** `parseAtomic` n'accepte que `0` ou un entier décimal sans zéro de tête, au plus 29 chiffres et au plus 2⁹⁶−1 (borne uint96 de `quote.ts`) ; le total aussi. Décimales : entier de 0 à 36. Tout le reste donne « — » plus une alerte, jamais une exception ni un montant approché.
10. **Le minimum porte sur la part du fournisseur** (hypothèse, voir §6). `belowMinimum` est vrai si la part du fournisseur est strictement inférieure au minimum ; un minimum nul est accepté.
11. **Perspectives de `PriceBreakdown`.** Par défaut les libellés du cahier (« Provider receives / Compute fee (Phala enclave) / Borrower pays »). `perspective="provider"` donne « You receive », `"borrower"` donne « You pay ».
12. **Ajouts à `DatasetCard` au-delà de la liste du cahier :** `sizeBytes` (la fiche 06 demande « taille et nombre de lignes »), `priceKind` (prix payé par l'emprunteur ou gain du fournisseur), `verified` à trois états (`true` : badge « KYB-verified provider » ; `false` : « Provider not KYB-verified » ; absent : rien), `href` (chemin interne seulement), repli « Untitled dataset » pour un nom vide. Le badge dit « KYB » exprès : il atteste le fournisseur, pas la qualité de la donnée ni du modèle.
13. **Pas de dérivation d'état depuis la base.** `StatusPill` ne reçoit qu'un `StatusKind` déjà calculé. Les champs `listingStatus` / `listingExpiresAt` n'existent pas encore dans `prisma/schema.prisma` (slice A1). Le pont `DatasetStatus` / `LoanStatus` → `StatusKind` est à écrire par les pages.
14. **Test de rendu dans un processus enfant.** `pnpm test` lance tout avec `--conditions=react-server`, condition sous laquelle React n'expose ni contexte ni `react-dom/server`. `shared-components.test.ts` lance donc `shared-components.render.tsx` dans un processus sans cette condition (`NODE_OPTIONS` vidé) et vérifie le HTML. Effet de bord utile : les composants se chargent sans le contournement `server-only`.
15. **Identité des commits.** L'identité git globale de l'environnement est celle de l'assistant ; pour respecter « aucune signature d'assistant », l'auteur et le committeur de la branche sont réglés **localement** (`git config --local`) sur l'identité du propriétaire déjà présente dans l'historique (`alibenyezza <149864846+alibenyezza@users.noreply.github.com>`). `.claude/`, `CLAUDE.md` et `AGENTS.md` sont exclus par `.git/info/exclude` (local, non versionné). Les worktrees jetables de la revue avaient été capturés par erreur par un `git add -A` ; retirés avant tout push (jamais présents dans l'historique publié).
16. **Pas d'accord de pluriel** : « 1 rows » reste possible, comme avec les clés existantes `{count} lignes`. Un jeu de données publiable a au moins 100 lignes, donc le cas ne se présente pas pour les lignes.

### 3. Ce que l'audit doit vérifier

- **Contrôle d'accès côté serveur.** Aucune route ni accès serveur dans cette slice. Rien à vérifier route par route. Rappel : aucun contrôle d'accès ne doit reposer sur l'affichage de `verified` ou de `StatusPill` : ce sont des affichages, pas des gardes.
- **Validation et bornes des entrées.** `parseAtomic`, `isValidDecimals`, `safeInternalHref`, `statusMeta`, `modelSelection` (profil inconnu ou version inconnue → « Profil absent », jamais un profil valide), `formatCount`, `sizeBytes` (entier sûr strictement positif sinon « — »), `contactMailtoHref`. Relire les expressions régulières : `parseAtomic` est ancrée (rejette 10 millions de caractères en moins de 10 ms) ; `groupDigits` est quadratique mais ne reçoit que des chaînes de moins de 30 chiffres.
- **Aucun HTML injecté.** Rechercher `dangerouslySetInnerHTML`, `innerHTML`, `target="_blank"` dans la slice : aucun. Le texte traduit est coupé autour de l'adresse de contact et rendu par React (échappé) ; seule la constante `CONTACT_EMAIL` devient un lien. Nom, catégorie, symbole du jeton et `children` hostiles (`<img onerror>`, `"`) sont échappés (tests de rendu). Les attributs `data-status`, `data-variant`, `data-disabled` sont normalisés ou constants.
- **Liens `mailto:` sûrs.** `mailto:` + adresse constante ; l'objet éventuel passe par `encodeURIComponent` après remplacement des contrôles (C0, DEL, C1) par une espace et des substituts UTF-16 isolés par U+FFFD, coupure à 200 points de code. Un objet hostile (`\r\nBcc:`, `&cc=`, `?body=`) ne produit que le paramètre `subject`. Aucun composant de la slice ne passe d'objet aujourd'hui (`DisclaimerNote` appelle `contactMailtoHref()` sans argument). Relire l'appelant futur qui en passerait un.
- **Liens internes.** `DatasetCard` et `DatasetAddTile` refusent tout `href` qui n'est pas un chemin interne (`javascript:`, `https://`, `//hôte`, `/\hôte`, espaces, contrôles, plus de 2048 caractères). Un fuzz de 400 000 chaînes hostiles par un relecteur n'a trouvé aucun contournement.
- **Montants exacts, sans arrondi trompeur.** Tout est en `bigint`. Vérifier : `computePriceBreakdown` (total = somme exacte, au-delà de 2⁵³), `formatTokenAmount` (6 et 18 décimales, 1 unité atomique, zéro, plus grand uint96), « — » + alerte pour toute entrée invalide, jamais « 0 ». Un relecteur a comparé `formatTokenAmount` à une référence indépendante sur 200 000 tirages (décimales 0 à 36) : aucun écart.
- **Cohérence des textes avec les constantes.** `DISCLAIMERS` ne contient aucun littéral numérique (test AST) ; la clé `dataLimits` ne contient aucun chiffre. Si une constante change, le texte suit. Vérifier à la main après tout changement des quatre constantes que « CSV up to … » reste vrai (voir §7).
- **Aucune promesse fausse sur les modèles.** `modelQuality` : « baseline models: linear and logistic regression… Results depend on the data. New models are in development. » `retrainDeterministic` : vrai tant que `train.ts` n'introduit ni aléa ni dépendance à l'ordre des lignes (aucun `Math.random`, `crypto` ou tri dans `train.ts` aujourd'hui) ; le déterminisme est celui d'un même moteur numérique et d'un même ordre de lignes. Le badge « KYB-verified provider » ne dit rien de la donnée. **Réserve majeure : `dataLimits`, voir §7.**
- **Impact sur l'argent, l'escrow, les contrats, Phala.** Aucun : pas de transaction, pas de signature, pas de lecture de contrat. Ces composants **affichent** des montants fournis par l'appelant ; un montant faux fourni à `PriceBreakdown` s'affichera tel quel. L'exactitude de la décomposition affichée par rapport au devis réellement signé (`datasetAmount`, `computeAmount`, `maxFailureFee`, `tariffVersion`) doit être vérifiée **page par page** par l'audit des slices qui branchent le composant.
- **Fuites vers le bundle client.** Aucun `server-only`, module Node, `pg`, `prisma`, `better-sqlite3`, `@phala` atteignable depuis les modules de la slice (test du graphe d'imports + bundle navigateur esbuild vérifié par un relecteur : 162 Ko minifiés pour toute la page de test, dont 2,2 Ko pour `shared-en`).
- **Base de données.** Aucune.
- **Traductions.** Aucune clé française sans traduction (tests), paramètres `{…}` conservés. Collisions : voir §2.5.
- **Signatures d'assistant.** `git log staging..HEAD --format=%B` : aucune ligne `Co-Authored-By`, `Claude-Session`, lien claude.ai, « Generated with ». Vérifier aussi l'auteur des commits (§2.15).

### 4. Cas limites à essayer à la main sur staging

Les composants ne sont montés par aucune page à ce stade : ces essais valent **après branchement** par les slices pages. Les cas de rendu automatiques (HTML) sont dans `shared-components.render.tsx`.

1. **Décomposition 20 + 3.** Fournisseur 20 000 000 (6 décimales), calcul 3 000 000 → « 20.00 / 3.00 / 23.00 » avec le bon symbole. Sur le testnet (18 décimales), 20 × 10¹⁸ et 3 × 10¹⁸ → les mêmes affichages, sans décalage.
2. **Un cent atomique.** Montant 1 (6 décimales) → « 0.000001 », pas « 0.00 » ni « 0 ».
3. **Sous le minimum.** Part du fournisseur = minimum − 1 → texte rouge « Below the minimum set by the tariff… » et annonce par un lecteur d'écran ; égale au minimum → pas d'alerte. Minimum 0 → « Minimum set by the tariff: 0.00 … ».
4. **Montant invalide** (champ vide, `12.5`, `-1`, `1e6`, plus grand que 2⁹⁶−1) → trois « — » et une alerte « Amount unavailable », jamais de montant partiel.
5. **Très grand montant, écran 320 px** : pas de défilement horizontal, le montant passe à la ligne et reste aligné à droite.
6. **Encart.** Cliquer le lien de contact → le client de messagerie s'ouvre avec uniquement `sirius.data.contact@gmail.com` en destinataire. Variante `warning` : lisible, icône décorative non annoncée.
7. **Pastilles.** Les huit états s'affichent avec leur libellé ; un état venu de l'API que la page ne sait pas convertir doit être traité avant le composant (le composant affiche « Unknown status » en repli).
8. **Carte, clavier.** Tab : un seul arrêt par carte (le titre), anneau de focus visible, Entrée ouvre la fiche. Clic n'importe où sur la carte ouvre la fiche. Mode contraste forcé de Windows : le focus reste visible.
9. **Carte, contenus hostiles.** Nom de dataset `<img src=x onerror=alert(1)>`, nom de 300 caractères sans espace, nom vide, catégorie vide, version de modèle inconnue (`9.9.9`) → « Missing profile », prix `null` → « — », 0 emprunt, sizeBytes négatif → « — ». Aucun script exécuté, aucune mise en page cassée.
10. **Tuile d'ajout.** Mène à l'upload ; avec un `href` non sûr, elle s'affiche sans lien.
11. **Hydratation.** Charger une page avec des nombres de 5 chiffres et des montants, navigateur en français : pas d'avertissement d'hydratation, pas de « 12 345 » (séparateur uniquement la virgule).
12. **Traduction.** Chaque texte visible est en anglais ; aucune clé française ne s'affiche.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

Ajoutés (62 tests de plus que la ligne de base de `staging` : 429 → 491) :
- `src/lib/copy/disclaimers.test.ts` : textes anglais exacts (cahier §4), email, traduction et paramètres résolus, `dataLimits` recalculé indépendamment depuis les constantes et avec d'autres limites, absence de chiffre dans les clés et de littéral numérique dans `DISCLAIMERS` (AST), formatage (milliers, troncature, valeurs invalides), `mailto` (encodage, injection d'en-têtes, substituts isolés, bornes exactes D800–DFFF, contrôles, longueur), **graphe d'imports** de tous les modules de la slice (aucun `server-only`, module Node, `pg`, prisma, `@phala` atteignable, et les trois sources de constantes sont bien dans le graphe).
- `src/components/datasets/price.test.ts` : exemple 20 + 3, aucun arrondi, 0 / milliers / décimales 0–2 / 18 décimales, uint96 (valeur maximale, total à la borne, au-delà de 2⁵³), somme exacte, accord avec `formatUsdcAtomic`, minimum (égalité, nul, null), entrées invalides rejouées pour chaque champ.
- `src/components/ui/status.test.ts` : table complète des huit états (libellé, variante, point), traductions distinctes, repli pour `constructor`, `__proto__`, etc., liens internes sûrs et refusés.
- `src/components/ui/shared-components.test.ts` : HTML réel des composants dans un processus sans `react-server` : un seul lien `mailto`, échappement, couleurs exactes du point et de la bordure de chaque état, perspectives, 18 décimales, minimum nul et sous le minimum, entrées invalides, plus grand montant, carte complète / minimale / hostile / sans nom / profil inconnu / taille invalide / lien étiré, tuile, identifiants de titre distincts, identifiant d'encart répété.

Mutations jouées par moi, toutes détectées après correction des tests : point de pastille constant, repli « 0 » d'un montant invalide, limite codée en dur dans `disclaimers.ts`, garde du montant de calcul retirée, test de minimum falsy, version de modèle figée à « 1.0.0 ».

**Angles morts connus :**
- Aucun test en navigateur réel dans la suite (pas de Playwright pour ces composants) : focus, contraste, retour à la ligne, hydratation et rendu à 320–1280 px n'ont été vérifiés qu'**une fois**, à la main, par un relecteur dans un worktree jetable (`next dev` + page de prévisualisation supprimée, captures à 320, 360, 768 et 1280 px, aucun défilement horizontal, aucun avertissement d'hydratation, focus clavier observé). Rien de cela n'est rejouable depuis le dépôt.
- Les tests de rendu comparent du HTML par expressions régulières : ils ne détecteraient pas une classe Tailwind absente de la feuille de style générée.
- Le test AST de `DISCLAIMERS` détecte les littéraux numériques, pas des limites recopiées en chaînes de caractères.
- `next build` complet n'a pas été exécuté sur les composants : aucune page ne les importe, donc il ne les compilerait pas. Un relecteur n'a pas pu le faire dans son worktree (erreurs d'environnement Turbopack étrangères à la slice) ; il a compilé un bundle navigateur avec esbuild à la place.
- Pas de test d'accessibilité automatisé (axe) ni de lecteur d'écran.
- Les modèles et textes anglais de `07` et `08` (encarts de l'upload et de la marketplace) diffèrent de la source unique de `16` ; aucun test ne le contrôle, voir §7.
- Le test de rendu dépend de `tsx` lancé depuis la racine du dépôt (`cwd` fixé) ; il a été vérifié depuis d'autres répertoires de travail et sans variables d'environnement.

### 6. Hypothèses

- Le « minimum imposé par le tarif » (`07-upload.md`) s'applique à ce que reçoit le fournisseur. Dans le code actuel `MIN_PRICE_USDC_ATOMIC` (0,001) est un plancher de prix et `quote.ts` exige un total au moins égal à 10^(décimales−3). Si le minimum du tarif porte sur le total ou sur les frais de calcul, la page appelante doit passer le bon montant ; le composant ne le sait pas.
- Les montants fournis par les pages sont déjà en unités atomiques, décimales lues sur le contrat du réseau (6 sur mainnet pour l'USDG, « annoncé », **à confirmer on-chain** selon `01`).
- `verified` provient du registre KYB on-chain ; la slice ne le vérifie pas.
- `MAX_CSV_ROWS`, `MIN_TRAINING_ROWS`, `MAX_TRAINING_FEATURES` et `MAX_DATASET_BYTES` restent des constantes statiques lisibles dans un bundle client (aucun passage à une lecture d'environnement).
- Le texte « retraining on the same data gives the same model » suppose un même moteur numérique et un même ordre de lignes ; non testé à travers des versions de Node ou de plateformes différentes.
- « Beta: invitation-only access, capped amounts per loan and in total » est une affirmation de fonctionnement (accès sur invitation, plafonds) que la slice ne vérifie pas ; elle suppose que les plafonds par prêt et au total existent bien au lancement.
- L'adresse `sirius.data.contact@gmail.com` est donnée par le cahier ; elle n'a pas été vérifiée (boîte active, redirection).
- L'interface reste en anglais seul (`LocaleProvider` fixe `locale = "en"`).

### 7. Risques résiduels et limites connues

1. **`dataLimits` est plus optimiste que le code (promesse fausse possible).** Texte : « CSV up to 3 MB, 100 to 20,000 rows, numeric columns, up to 31 input features. » Vérifié par exécution de `validateTrainingDataset` :
   - minimum de lignes = max(100, 10 × (variables + 1)) : avec 31 variables il faut **320** lignes (319 refusées, 320 acceptées) ; avec 1 variable, 100 ;
   - plafond de lignes : 20 000 lignes **de données** sont refusées (« trop de lignes CSV (max 20000) »), le maximum accepté est 19 999 ;
   - budget de calcul (`MAX_TRAINING_OPERATIONS` = 20 000 000) : régression logistique à 31 variables, **3 125** lignes acceptées et 3 126 refusées ; régression linéaire à 31 variables, 19 531 acceptées et 19 532 refusées. Un CSV de 20 000 lignes avec 31 variables n'est donc jamais entraînable en logistique.
   Un fournisseur peut lire ce texte, déposer un fichier « dans les limites » et se voir refuser le fichier ou l'entraînement. Décision à prendre par le propriétaire : reformuler (par exemple en citant le minimum de lignes par variable et le budget de calcul) ou accepter l'écart. Les composants lisent déjà les constantes ; seule la clé de `dataLimits` changerait.
2. **Textes 07 et 08 non alignés sur 16.** Les encarts cités dans `07-upload.md` et `08-marketplace.md` sont des variantes plus longues de `modelQuality` + `contactUs`. Les composants suivent `16` (source unique). Si les pages veulent la variante de 07/08, elles doivent l'ajouter à `disclaimers.ts` plutôt que la recopier.
3. **« Provider receives » vrai seulement en cas de règlement.** La décomposition affiche ce que le fournisseur reçoit si le prêt est réglé ; en cas d'échec seul le calcul consommé est retenu et le reste est remboursé (`08`, « ce qui se passe en cas d'échec »). Cette mention n'est volontairement pas dans le composant ; la fiche marketplace doit l'afficher à côté.
4. **Jeton en dur sur le site.** Tant que les pages affichent « USDC » en dur, l'affichage mainnet (USDG) dépend entièrement de chaque intégrateur. Aucune fabrique centrale.
5. **États de la carte sans pont.** Une page qui passerait un état erroné (par exemple « En ligne » pour un dataset expiré) afficherait faux : le composant n'a pas de source de vérité.
6. **Cartes hors liste.** `DatasetCard` rend un `article` ; la mosaïque doit être enveloppée dans une liste (`ul`/`li`) par la page pour l'accessibilité.
7. **Clés de traduction.** Fusion par *spread* sans détection de collision (§2.5). Clés au vouvoiement (« Contactez-nous ») alors que le reste de l'interface tutoie (« Colle le code… ») : sans effet visible (interface anglaise), mais à harmoniser si le français revient.
8. **Troncature du nom à deux lignes** avec le nom complet dans `title` : sur tactile, le nom complet n'est pas accessible depuis la carte.
9. **Dépendance du test de rendu** à un processus enfant : si `tsx` ou `--import` change de comportement, le test échoue bruyamment (jamais silencieusement).
10. **`pnpm audit:deps`** signale 2 vulnérabilités (1 faible, 1 haute, 1 ignorée), **identiques à `staging` avant ma branche** ; non traitées ici.

### 8. Reste à faire

- **P0** : décision du propriétaire sur le texte `dataLimits` (§7.1).
- **P0** : les slices pages (Mes datasets, upload, marketplace, train, dashboard, tutos) doivent brancher les composants, passer `token` correct (USDG, décimales on-chain) et vérifier la décomposition affichée contre le devis.
- **P1** : fabrique unique du jeton (symbole + décimales par réseau) et pont `DatasetStatus` / `LoanStatus` / `listingStatus` → `StatusKind` testé.
- **P1** : texte de mention d'échec/remboursement à côté de la décomposition, côté marketplace.
- **P1** : test navigateur (Playwright) d'une page réelle utilisant les composants : focus, mobile, contraste forcé.
- **P2** : extraire les deux constantes de `train.ts` dans un module sans dépendance si le bundle client devient un sujet ; garde-fou de collision des clés de traduction ; enveloppe `ul`/`li` fournie par un composant de grille ; accessibilité automatisée (axe).

### 9. Résultats des vérifications

Environnement : Node v22.22.0, pnpm 11.18.0. `DATABASE_URL=postgresql://x:y@localhost:5432/z` (factice) exportée.

| Commande | Résultat exact |
|---|---|
| `pnpm install --frozen-lockfile` (sans `DATABASE_URL`) | **échec, exit 1** : le `postinstall` `prisma generate` lève `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`. Cause : environnement, sans rapport avec la slice. |
| `pnpm install --frozen-lockfile` (avec `DATABASE_URL` factice) | `Already up to date`, `Prisma Client (7.8.0) généré`, exit 0 |
| `pnpm exec tsc --noEmit` | aucune sortie, exit 0 |
| `pnpm lint` | `eslint`, aucune sortie, exit 0 (vérifié sans worktree jetable dans `.claude/`) |
| `pnpm test` | `tests 491`, `pass 491`, `fail 0`, exit 0 (`staging` avant ma branche : 429 tests, 429 réussis) |
| `pnpm audit:deps` | `2 vulnerabilities found — Severity: 1 low | 1 high (1 ignored)`, exit 0 ; résultat identique avant ma branche |
| `git diff --name-only staging...HEAD` | 17 fichiers, tous dans les chemins autorisés (liste en §1) |
| `git log staging..HEAD --format=%B` | aucune signature d'assistant (recherche de `co-authored`, `claude`, `anthropic`, `generated`, `session`, `skip ci` : aucune occurrence) |

Non exécuté : `pnpm build` / `next build` (aucune page ne consomme les composants), tests e2e Playwright, tests de contrats.

Vérifications ponctuelles (hors suite) : exécution de `validateTrainingDataset` pour les limites de §7.1 ; recherche de collisions de clés entre `shared-en.ts`, `english.ts`, `errors-en.ts`, `phala-en.ts` (aucune) ; bundle navigateur esbuild par un relecteur.

### 10. Revue interne de la session

Méthode : cinq passes de revue adversariale, chacune avec six relecteurs indépendants aux angles différents (sécurité et injection ; exactitude des montants et des textes ; tests et cas limites avec **test de mutation** dans un worktree isolé ; accessibilité et rendu réel ; build et bundle client ; périmètre et conformité ; mécanisme de traduction et style), puis deux sceptiques par constat (l'un cherche à le reproduire, l'autre à le réfuter) ; un constat n'est retenu que si les deux le jugent réel. Soit 215 agents.

| Passe | Constats retenus | Écartés |
|---|---|---|
| 1 | 13 entrées (environ 8 problèmes distincts) | 25 |
| 2 | 2 | 23 |
| 3 | 2 | 7 |
| 4 | 3 | 11 |
| 5 | **0** | 4 |

**Retenus et corrigés :**
- `contactMailtoHref` levait une `URIError` sur un substitut UTF-16 isolé ou un emoji coupé à 200 unités (trouvé par deux angles) → coupure par points de code, substituts remplacés par U+FFFD, tests des bornes exactes.
- `DatasetCard` n'affichait pas la taille du fichier exigée par `06-mes-datasets.md` (trouvé par trois angles) → prop `sizeBytes`, valide seulement si entier sûr > 0, sinon « — ».
- Aucun indicateur de focus en mode contraste forcé sur la carte → `outline-hidden` à la place de `outline-none`.
- Montant aligné à gauche après retour à la ligne sur mobile ; très grands montants sans `wrap-anywhere` → `ml-auto text-right` et `wrap-anywhere`.
- Nom vide donnant un lien sans nom accessible → « Untitled dataset ».
- Variante inconnue de `DisclaimerNote` qui plantait ; identifiant répété affiché deux fois avec clés React dupliquées → repli sur `info`, dédoublonnage.
- `formatLimitBytes` affichait « 0 KB » sous 1 Ko ; helper de montant dupliqué (`formatTokenWithSymbol` inutilisé) → corrigés.
- Mutations survivantes dans les tests, corrigées une à une et rejouées : couleur du point de pastille (la sous-chaîne `bg-positive` était déjà dans le badge), repli « 0 » d'un montant invalide, limite codée en dur dans `disclaimers.ts`, garde sur les frais de calcul, minimum nul traité comme faux, `modelVersion` figé, états de carte, jeton à 18 décimales, bornes uint96, bornes D800–DFFF.
- Section A2 d'`audit.md` vide : remplie par ce texte.

**Écartés avec la raison :**
- `dataLimits` optimiste (trouvé par trois angles, les sceptiques divisés) : texte imposé mot pour mot par le propriétaire ; **consigné en §7.1 et dans la PR, non corrigé**.
- « Le plafond de 20 000 lignes est en réalité 19 999 » et « le budget de calcul n'est pas cité » : même sujet, regroupés en §7.1.
- Pluriels « 1 rows », vouvoiement des clés françaises, « Borrows » contre « Loan » : conventions existantes ou goût (§7.7).
- Absence de `ul`/`li` autour des cartes : rôle de la page (§7.6).
- `priceKind` par défaut `borrowerPays`, jeton sans fabrique, formateur à deux décimales, train.ts dans le bundle : choix documentés (§2) ou hors périmètre.
- Pas de pont `DatasetStatus` → `StatusKind`, pas d'état « en attente de saisie » pour `PriceBreakdown`, `revenueAtomic` absent contre `null` : rôle des pages ; précisions de documentation ajoutées.
- `role="alert"` sur les messages de `PriceBreakdown` : voulu pour une saisie en direct.
- Tuile inactive sans rôle, `aria-disabled` : attribut retiré (sans sens sur un `div`), pas de rôle ajouté.
- Textes 07/08 différents de 16 : 16 est la source unique (§7.2).
- Plusieurs mutations de style mineures (couleurs d'avertissement, `aria-hidden` du pictogramme, bornes 2048 de `safeInternalHref`, ordre par défaut) : coût de test disproportionné.
- `groupDigits` quadratique : entrée bornée à moins de 30 chiffres.
- Collisions de la ligne `test` de `package.json` avec d'autres slices : à résoudre à la fusion.

**Passe 5, sans constat retenu.** Les relecteurs ont, entre autres : fuzzé `safeInternalHref` sur 400 000 chaînes ; comparé `formatTokenAmount` et `formatLimitBytes` à des références indépendantes sur 200 000 tirages chacun ; rejoué environ 190 mutations ; vérifié le rendu réel dans Chromium (`next dev`, page de prévisualisation supprimée) à 320, 360, 768 et 1280 px, au clavier, avec espacement de texte WCAG et police à 200 % ; compilé un bundle navigateur (esbuild) et exécuté le rendu dans un contexte sans `Buffer`.

**Limite de la revue :** elle n'a pas pu lancer `next build` sur le dépôt (erreurs d'environnement Turbopack sans rapport avec la slice dans les worktrees jetables). Les constats écartés l'ont été sur avis de deux sceptiques IA, pas d'une relecture humaine.

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

Branche `feat/explorer`, base `staging` (tête `2990a9f` au moment du départ). Cahier des charges : [11-explorer.md](11-explorer.md), partie « Avant le 6 ».

### 1. Ce qui a changé

**Fichiers modifiés (tous dans le périmètre autorisé de la slice) :**

| Fichier | Changement |
|---|---|
| `src/app/(app)/audit/page.tsx` → `src/app/(app)/explorer/page.tsx` | Page déplacée (`git mv`, historique conservé) puis réécrite. L'ancien dossier `audit/` n'existe plus. Composant `AuditPage` → `ExplorerPage`. |
| `next.config.ts` | Ajout de `redirects()` : `/audit` → `/explorer`, `permanent: true` (HTTP 308). |
| `src/components/layout/Sidebar.tsx` | Une seule ligne : `{ href: "/audit", label: "Audit" }` → `{ href: "/explorer", label: "Explorer" }`. Le `href` change aussi : sinon chaque clic passerait par la redirection et l'onglet actif (`pathname === href`) ne s'allumerait jamais. |
| `src/lib/i18n/english.ts` | 6 clés exclusives à l'ancienne page supprimées, 13 clés ajoutées (voir ci-dessous). |
| `e2e/audit-regressions.spec.ts` | Test « Audit remplace l'historique… » renommé et adapté ; 8 tests ajoutés (voir §5). |
| `e2e/sirius.spec.ts` | `goto("/explorer")` et titre `Explorer` (au lieu de `Audit ledger`). |
| `e2e/responsive.spec.ts` | `openLayoutPage(page, "/explorer", …)`. |
| `docs/passage-mainnet/audit.md` | Cette section uniquement. |

**Routes :**

- Page `/explorer` (client, derrière le layout `(app)`), nouvelle.
- `/audit` : redirection permanente vers `/explorer`, définie dans la configuration Next (côté serveur, avant tout rendu).
- API `GET /api/audit` : **inchangée** (`src/app/api/audit/route.ts` est hors périmètre). La page continue de l'appeler. Le nom de la route API n'est donc pas renommé.

**Contenu de la page `/explorer`** (centrée sur le wallet connecté) :

- Compteurs : Borrowings, Datasets borrowed, Settled, Refunded, réseau.
- Une carte par emprunt : dataset (nom, titre on-chain avec lien vers sa transaction de mint), montant USDC, date, statut, lien « Verify » vers la transaction de lock, vers la transaction de règlement (« Release USDC ») ou de remboursement (« Refund USDC »), attestation TEE et reçu d'audit en texte, lien vers l'adresse du fournisseur (`addressExplorerUrl`), modèle, échéance.
- Badge **REFUNDED** : prêt `CANCELLED` **avec** `cancelTxHash` (logique identique à l'ancienne page, extraite dans `isRefunded`).
- États : non connecté (invite à connecter un wallet, aucun appel API), connecté non authentifié (« Sign in to see your borrowings. », aucun appel API), chargement, erreur, vide, tronqué.
- Helpers de `src/lib/evm/explorer.ts` utilisés : `transactionExplorerUrl` (lock, règlement, remboursement, mint) et `addressExplorerUrl` (fournisseur, **nouveau**). `tokenExplorerUrl` n'est pas utilisé (voir §2).

**Clés de traduction (`english.ts`)** — supprimées : `Registre d’audit`, `Connecte un wallet pour consulter ses preuves.`, `Chaîne de preuves Sirius recoupable sur EVM.`, `Registre indisponible — réessaie.`, `Chargement des preuves…`, `Aucun prêt auditable pour ce wallet.` (greps exhaustifs : plus aucune référence). Ajoutées (anglais, clé = valeur) : `Explorer`, `Connect a wallet to see your borrowings and their proofs.`, `Your borrowings, settlements and refunds, each verifiable on the chain explorer.`, `Borrowings`, `Datasets borrowed`, `Settled`, `Refunded`, `Sign in to see your borrowings.`, `Explorer unavailable — try again.`, `Loading your borrowings…`, `No borrowing for this wallet yet.`, `View provider {address} on the explorer`, `Only your {count} most recent loans were loaded: older borrowings may be missing.`

**Aucune** modification de : contrats, escrow, moteur Phala, base de données (pas de migration), `package.json`, API, parcours de remboursement (`/train`, `src/lib/loans/client.ts`, `/api/loans/[id]/cancel`).

### 2. Décisions et écarts par rapport au cahier des charges

1. **Vue limitée aux emprunts du wallet connecté (écart par rapport à l'ancienne page).** L'ancienne page affichait aussi les prêts où le wallet est fournisseur (l'API renvoie `OR borrower/provider`). Le cahier des charges demande « ses emprunts, ses datasets empruntés, ses règlements et remboursements » et « aucune donnée d'un autre wallet ». La page filtre donc `loan.borrower == wallet connecté` (`addressesEqual`, insensible à la casse). **Conséquence : un fournisseur ne voit plus nulle part le règlement reçu pour un de ses datasets emprunté.** La page « Mes datasets » (`src/app/(app)/datasets/page.tsx`) ne charge aucun prêt aujourd'hui : la vue fournisseur est une perte fonctionnelle réelle, à traiter avec la slice Mes datasets ([06](06-mes-datasets.md)). C'est le point à relire en priorité. Le filtre tient en une expression (`borrowings`, `useMemo`) : le retirer rétablit l'ancien comportement.
2. **API conservée telle quelle.** `src/app/api/audit/route.ts` n'est pas dans le périmètre. Vérifié (lecture) : `requireAuth(req)` puis `prisma.loan.findMany({ where: { OR: [{ borrower: session.address }, { provider: session.address }] }, take: 100, orderBy createdAt desc })` ; aucun paramètre client n'est utilisé. Le filtre par session est bien côté serveur, mais la réponse contient aussi les prêts où le wallet est fournisseur (donc l'adresse de l'emprunteur, le montant, le hash d'attestation). Le filtre de la page est une défense d'interface, **pas** un contrôle d'accès : un fournisseur qui ouvre l'onglet réseau voit ces lignes. Ce sont des prêts dont il est partie (même contenu que `GET /api/loans`), et l'adresse de l'emprunteur est publique on-chain, donc ce n'est pas une fuite entre tiers, mais ce n'est pas « aucune donnée d'un autre wallet » au sens strict. Correctif propre (hors périmètre) : `where: { borrower: session.address }`.
3. **Plafond de 100 prêts.** L'API coupe à 100 lignes, tous rôles confondus, avant le filtre de la page. Un wallet à la fois fournisseur très actif et emprunteur peut ne pas voir ses emprunts anciens. La page ne peut pas le corriger (pas de pagination côté API) : elle affiche un avertissement (`role="status"`) dès que la réponse contient 100 lignes ou plus, et n'affirme plus « aucun emprunt » dans ce cas. Le seuil `API_LOAN_LIMIT = 100` est dupliqué du `take: 100` de la route : si l'un change, l'autre doit suivre (commentaire dans le code).
4. **Parcours de remboursement : inchangé, et absent de l'Explorer.** L'action de remboursement (« Récupérer l'escrow », `cancelExpiredLoan`) vit dans `/train` et n'a jamais été sur la page Audit. La page ne fait que montrer le badge REFUNDED et le lien de la transaction de remboursement. Je n'ai pas ajouté de lien vers `/train` : non demandé, et le parcours est « repensé » après le 6.
5. **Libellé du badge.** Le cahier des charges parle du badge « Remboursé » ; l'interface étant en anglais et les badges de statut en capitales, il s'affiche `REFUNDED` (clé existante, déjà présente avant la slice).
6. **Redirection : source exacte `/audit` uniquement.** Pas de `/audit/:path*` : aucune sous-page n'a jamais existé, et un motif à paramètre recopierait du texte contrôlé par l'appelant dans la cible (risque de redirection ouverte). `permanent: true` = 308 (conserve la méthode). La requête (`?a=1`) est conservée par Next.
7. **Textes rédigés directement en anglais**, avec une entrée `clé = valeur` dans `english.ts`, parce que le test `english.test.ts` exige une traduction pour toute clé statique de `t()`. Les clés françaises existantes non liées au renommage (`Titre du dataset`, `Attestation TEE`, `Reçu d’audit`, `En attente`, `Vérifier …`, `modèle`, `échéance`) sont gardées telles quelles (« Audit receipt » désigne la signature HMAC du runner, pas la page).
8. **Pas de lien `tokenExplorerUrl`.** L'ancienne page n'en avait pas ; le titre du dataset est lié à sa transaction de mint. L'adresse du registre est lisible côté navigateur (`NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS`), mais la réponse de l'API ne dit pas de quel registre (courant ou historique) vient le titre : un lien construit avec le registre courant pourrait pointer au mauvais endroit. Non fait par prudence.
9. **Certificat d'exécution : non fait.** Le cahier des charges parle de « son certificat (09) » ; il appartient à la slice N6, qui n'existe pas encore (aucune route ni page de certificat). La consigne de cette slice ne le demande pas.
10. **Auteur des commits.** L'identité git locale a été réglée sur celle du propriétaire du dépôt (celle de ses commits sur `staging`) et le premier commit a été réécrit avant tout push : l'identité par défaut de l'environnement était celle de l'assistant. Aucune ligne de co-signature, aucun identifiant de session, aucun lien vers l'outil, ni dans les commits ni dans les fichiers.
11. **Pas de test unitaire ajouté.** `pnpm test` énumère ses fichiers dans `package.json` (hors périmètre) : un nouveau fichier de test ne serait pas exécuté. La logique pure est petite et couverte par les e2e. Aucun test unitaire existant ne ciblait `/audit` (recherche de `/audit` dans `src/`, `e2e/`, `scripts/`).

### 3. Ce que l'audit doit vérifier

**Contrôle d'accès côté serveur, route par route**

- `GET /api/audit` (seule route appelée par la page) : `requireAuth` → cookie de session signé ; l'adresse vient de la session, jamais de la requête ; aucune entrée client. À relire : `src/app/api/audit/route.ts`, `src/lib/auth/require-auth.ts`, `session.ts`. 401 générique sans session ; erreurs via `errorResponse` (messages d'`AppError` seulement, 500 opaque).
- Vérifier que le filtre de la page n'est **pas** le contrôle d'accès : si un jour la route cesse de filtrer par session, la page ne protège rien (le filtre ne porte que sur `borrower`).
- `/explorer` est une page : elle n'expose aucune donnée par elle-même ; tout vient de `/api/audit`. `/audit` ne sert rien (redirection avant rendu).

**Validation et bornes**

- La page valide la réponse : `network` doit être `mainnet` ou `testnet` (sinon l'état « Explorer unavailable », pas de plantage dans `EVM_CHAINS[network]`), `loans` doit être un tableau.
- Les liens explorateur : base fixe de `EVM_CHAINS`, segments passés par `encodeURIComponent` ; aucune valeur de la base ne peut changer le schéma ni l'hôte ; `target="_blank"` avec `rel="noreferrer"` partout.
- Redirection : source et destination fixes, aucun paramètre recopié. Observé sur le build de production (`next start`, `curl -i`) : `/audit` → 308 `/explorer` ; `/audit?a=1&b=2` → 308 `/explorer?a=1&b=2` ; `/audit/` → 308 `/audit` puis 308 `/explorer` (deux sauts, pas de boucle) ; `/Audit` → 308 `/explorer` (Next ignore la casse) ; `/audit?next=//evil.example` → `/explorer?next=%2F%2Fevil.example` (paramètre encodé, jamais interprété) ; `/audit//evil.example` → `/audit/evil.example` et `//evil.example/audit` → `/evil.example/audit` (normalisation des doubles barres par Next, chemin relatif au même hôte, pas par notre règle). `/audit/x` ne correspond à aucune règle. Aucune cible ne contient d'hôte externe.

**Fuites possibles**

- Données d'un autre wallet : voir §2.2. La charge réseau de `/api/audit` contient les prêts où le wallet est fournisseur (adresse de l'emprunteur incluse). Rien n'est affiché, mais c'est dans la réponse.
- Changement de compte pendant une requête : la page est remontée (`key = revision:authenticated`) à chaque changement de wallet, de réseau ou d'authentification ; la réponse tardive d'un ancien compte tombe dans une instance démontée. Test e2e existant, adapté.
- Cache : aucun en-tête `Cache-Control` explicite sur `/api/audit` ; Next 16.3.7 pose `private, no-cache, no-store` sur les réponses dynamiques (lu dans `base-server.js`, **non observé** sur un serveur réel).
- Messages d'erreur et journaux : la page n'écrit rien dans la console ; `catch` sans détail.

**Argent, escrow, contrats, Phala**

- Aucun impact : aucune transaction n'est construite ni envoyée par la page (lecture seule, liens sortants uniquement). Aucun contrat ni moteur touché. Aucune transaction runner introduite.
- Remboursement inchangé : `git diff staging...HEAD` ne touche ni `src/app/(app)/train`, ni `src/lib/loans/client.ts`, ni `src/app/api/loans/**`, ni `src/lib/sirius/cancel.ts`. Vérifier que `isRefunded` (`status === "CANCELLED" && cancelTxHash`) reste identique à l'ancien filtre `loan.status === "CANCELLED" && loan.cancelTxHash`.

**Base de données** : aucune migration, aucune colonne.

**Interface**

- Toutes les valeurs venant de l'API (nom du dataset, identifiants, hash) sont rendues comme du texte React (échappé) ; aucun `dangerouslySetInnerHTML`.
- La CSP (`src/proxy.ts`) couvre `/explorer` (seul `/api` est exclu du matcher) ; les liens sortants ne sont pas soumis à `connect-src`.
- Sidebar : libellé et lien `/explorer` ; actif sur `/explorer` et sous-chemins.

**Textes**

- Sous-titre : « each verifiable on the chain explorer » vaut pour emprunts (lock), règlements et remboursements ; l'attestation TEE et le reçu d'audit sont affichés en texte, sans lien, et ne sont pas présentés comme vérifiables sur la chaîne.
- Restes de « audit ledger » visibles **hors périmètre** : `src/app/status/page.tsx:77` (lien `/audit` + texte « audit ledger », fonctionne via la redirection), `src/app/terms/page.tsx:28` (« listed in the audit ledger »), commentaire de `src/lib/evm/explorer.ts:5` (« consommés par la page `/audit` »). À corriger par le propriétaire de ces fichiers.

### 4. Cas limites à essayer à la main sur staging

1. **Redirection** : ouvrir `/audit` → l'URL devient `/explorer`, la page s'affiche, pas de boucle. Ouvrir `/audit?utm=test` → `/explorer?utm=test`. Ouvrir `/audit/` → atterrit sur `/explorer`. Dans l'onglet réseau : statut 308 puis 200. Rechercher un favori ou un lien externe vers `/audit` (page Status) : il aboutit sur `/explorer`.
2. **Menu** : le lien « Explorer » existe (bureau et barre mobile), l'ancien « Audit » a disparu ; il est surligné sur `/explorer`.
3. **Sans wallet** : ouvrir `/explorer` déconnecté → titre « Explorer », bouton de connexion, aucun appel à `/api/audit` (onglet réseau).
4. **Wallet connecté mais pas authentifié** (avant « Sign in ») → message « Sign in to see your borrowings. », pas de message « No borrowing ».
5. **Wallet vierge authentifié** → « No borrowing for this wallet yet. », compteurs à 0, pas de bandeau jaune.
6. **Emprunt réglé** (wallet emprunteur d'un prêt `SETTLED`) → badge SETTLED, liens « Verify Lock USDC » et « Verify Release USDC » ouvrent la bonne transaction sur l'explorateur du réseau (testnet : `explorer.testnet.chain.robinhood.com/tx/<hash>`), « Settled 1 ».
7. **Emprunt remboursé** (annulé après échéance puis remboursé via `/train`) → badge REFUNDED, libellé « Refund USDC » avec lien, « Refunded 1 ». Un prêt `CANCELLED` dont le remboursement n'est pas encore confirmé reste `CANCELLED`, sans lien de remboursement (le libellé « Release USDC / Pending » est un comportement hérité).
8. **Remboursement depuis `/train`** : sur un prêt remboursable, cliquer « Récupérer l'escrow », signer, puis rouvrir `/explorer` : le prêt passe en REFUNDED. Le parcours doit être identique à avant la slice.
9. **Deux wallets** : emprunter avec A un dataset de B. Avec A : le prêt est visible. Avec B (fournisseur) : `/explorer` ne montre **pas** ce prêt (écart assumé, §2.1) ; vérifier dans l'onglet réseau que `/api/audit` le contient (comportement de l'API, §2.2).
10. **Changement de compte** dans le wallet pendant que la page charge → aucune ligne de l'ancien compte ne reste affichée.
11. **Adresse en casse mixte** (wallet qui renvoie l'EIP-55) → les emprunts s'affichent.
12. **Plus de 100 prêts** (ou un wallet fournisseur de plus de 100 prêts récents et emprunteur d'un prêt plus ancien) → bandeau jaune « Only your 100 most recent loans were loaded… » ; pas de « No borrowing ».
13. **Réponse invalide** (API en panne, 500) → bandeau rouge « Explorer unavailable — try again. », pas de plantage.
14. **Mobile (390 px) et texte agrandi** : cartes sans débordement horizontal (test e2e responsive).
15. **Navigateur ayant déjà vu la redirection** : un 308 est mis en cache durablement par les navigateurs ; après un éventuel changement futur de `/audit`, tester en navigation privée.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

**Modifiés** : `Audit remplace l'historique…` → `Explorer remplace l'historique lors d'un changement de compte authentifié` (le prêt suit maintenant l'emprunteur, sinon il serait filtré) ; `sirius.spec.ts` (titre `Explorer`, URL `/explorer`) ; `responsive.spec.ts` (URL `/explorer`).

**Ajoutés dans `e2e/audit-regressions.spec.ts`** :

1. `Explorer n'affiche jamais un prêt dont le wallet connecté n'est pas l'emprunteur` — adresses à lettres hexadécimales, casse mixte dans les deux sens (wallet minuscule/API mixte, puis l'inverse), prêt fournisseur masqué, adresse du wallet absente de la page, lien fournisseur correct. *Contre-épreuve faite* : en remplaçant `addressesEqual` par `===`, le test devient rouge.
2. `Explorer ne prétend pas qu'il n'y a aucun emprunt quand l'API atteint sa limite de 100 prêts`.
3. `Explorer annonce l'absence d'emprunt quand la réponse est complète et vide`.
4. `Explorer : remboursement confirmé, remboursement en attente, règlement et liens explorateur` — REFUNDED vs CANCELLED vs SETTLED, URL exactes des liens (lock, règlement, remboursement, fournisseur), absence de lien de remboursement sur un prêt annulé sans transaction, compteurs (3 emprunts, 2 datasets, 1 réglé, 1 remboursé).
5. `Explorer signale un registre illisible au lieu de planter` (réseau inconnu).
6. `Explorer sans wallet ne lit rien et invite à se connecter` (aucun appel `/api/audit`).
7. `/audit redirige définitivement vers /explorer, requête conservée, sans boucle` — 308 et `Location` exacts, barre finale, tentatives hostiles (`//evil`, `https://evil`, `?next=//evil`), suivi complet jusqu'à `/explorer`.
8. `le menu propose Explorer, pas Audit, et le marque actif sur /explorer`.

**Angles morts** :

- Tous les e2e moquent `/api/audit` : le filtrage par session **côté serveur** n'est testé nulle part de bout en bout (aucun test d'intégration de la route avec base). Les tests de la page prouvent seulement que la page n'affiche pas ce qu'elle ne doit pas afficher.
- Le test de redirection tourne sur `next dev` ; le comportement de production a été vérifié à la main (`curl` sur `next start`, voir §3), pas par un test automatique, ni sur le déploiement réel (Vercel).
- L'authentification réelle (SIWE, cookie) est remplacée par le pont de test `__SIRIUS_E2E__` qui force `authenticated = true`.
- Le plafond de 100 est simulé par une réponse moquée de 100 lignes ; le `take: 100` réel n'est pas testé, et la duplication de la constante n'est pas garde-fouillée par un test.
- Le test de compteurs s'appuie sur la classe CSS `.font-mono.uppercase` (fragile si le style change).
- Le clic sur « Verify » n'est pas suivi (liens vérifiés par leur `href`), l'explorateur externe n'est pas appelé.
- Aucun test unitaire (voir §2.11).
- Aucun test sur un nombre élevé de prêts affichés (performance de rendu).

### 6. Hypothèses

- Les adresses `borrower` sont stockées en minuscules (`prepareLoan` → `normalizeAddress`) et `session.address` aussi (`verify` → `normalizeAddress`) — lu dans le code, non rejoué avec une vraie base.
- Un prêt a toujours un `dataset.evmDatasetId` non nul (`prepareLoan` refuse sinon) : le repli du compteur « Datasets borrowed » sur le nom du dataset n'est qu'une garde ; la réponse de l'API ne donne pas d'identifiant interne de dataset.
- Un fournisseur ne peut pas emprunter son propre dataset (`borrower.ts:55`) : le filtre `borrower` ne peut donc pas masquer un prêt où le wallet serait les deux.
- Quand `authenticated` est vrai, l'adresse du store est celle de la session (`synchroniserSession` ferme la session sinon).
- Le `network` renvoyé par le serveur est celui des transactions listées (une même instance ne sert qu'un réseau).
- Next envoie bien `no-store` sur la route dynamique (lu, non observé).
- La redirection de `next.config.ts` est appliquée telle quelle par l'hébergement de production (Vercel) — non vérifié sur le déploiement.
- `NEXT_PUBLIC_EVM_NETWORK` et `EVM_NETWORK` désignent le même réseau que celui de l'API.

### 7. Risques résiduels et limites connues

1. **Over-fetch de l'API** : la réponse contient les prêts où le wallet est fournisseur (§2.2). Pas de fuite entre tiers étrangers, mais pas « aucune donnée d'un autre wallet » dans la charge réseau.
2. **Troncature à 100** (§2.3) : un fournisseur très actif qui emprunte aussi peut ne pas voir ses emprunts anciens ; seul un avertissement le signale.
3. **Perte de la vue fournisseur** (§2.1) : plus aucun écran ne montre à un fournisseur le règlement reçu.
4. **Redirection 308 mise en cache** par les navigateurs : si `/audit` est réutilisé plus tard (par exemple la vue globale d'équipe prévue après le 6), les navigateurs qui ont déjà suivi la redirection continueront d'aller sur `/explorer`.
5. **Compteurs à zéro** affichés pendant le chargement, en erreur ou sans session (un message explicite les accompagne, mais le « 0 » n'est pas masqué) ; réseau affiché « testnet » tant que la réponse n'est pas arrivée (valeur par défaut de l'état).
6. **Nom accessible des liens « Verify … on EVM »** identique d'une carte à l'autre (hérité de l'ancienne page).
7. **Prêt annulé sans remboursement confirmé** : affiché « Release USDC / Pending » (hérité).
8. **Seuil d'avertissement** : exactement 100 prêts déclenche l'avertissement à tort (conservateur, voulu).
9. **Textes hors périmètre** encore sur « audit ledger » (§3).
10. **Pas de lien d'action** de l'Explorer vers `/train` pour rembourser : un emprunteur doit connaître `/train`.

### 8. Reste à faire

Priorité haute (avant le 6 si possible) :

1. Corriger `src/app/api/audit/route.ts` : `where: { borrower: session.address }` et pagination par curseur (supprime l'over-fetch et la troncature, et permet de retirer l'avertissement et le filtre client). Éventuellement renommer la route en `/api/explorer` en gardant l'ancienne en alias.
2. Remplacer « audit ledger » / lien `/audit` dans `src/app/status/page.tsx` et `src/app/terms/page.tsx`, et le commentaire de `src/lib/evm/explorer.ts` (slices qui possèdent ces fichiers).
3. Décider où le fournisseur retrouve ses règlements (slice Mes datasets, [06](06-mes-datasets.md)).

Priorité moyenne :

4. Lien vers le certificat d'exécution quand la slice N6 existe.
5. Lien `tokenExplorerUrl` sur le titre du dataset, si l'API fournit l'adresse du registre d'origine.
6. Si un test unitaire est souhaité sur la logique pure, l'ajouter à la liste de `package.json`.
7. Masquer les compteurs tant que rien n'est chargé.
8. Lien « Rembourser dans Train » pour les prêts remboursables.

Après le 6 (déjà au cahier des charges) : filtres (type d'action, dataset, période, statut), indexeur, vue globale d'équipe, parcours de remboursement repensé.

### 9. Résultats des vérifications

Environnement : Node v22.22.0, pnpm 11.18.0, `DATABASE_URL=postgresql://x:y@localhost:5432/z` (factice). Playwright : le Chromium installé (`/opt/pw-browsers/chromium`, build 1194) n'est pas celui que la version de Playwright attend (1228) ; les e2e ont été lancés avec une configuration temporaire hors dépôt qui reprend `playwright.config.ts` et ajoute `executablePath: /opt/pw-browsers/chromium` et `--no-sandbox`. `playwright.config.ts` n'est pas modifié.

Résultats **finaux** (exécutés sur la tête de la branche, après les corrections de la revue) :

| Commande | Résultat exact |
|---|---|
| `pnpm install --frozen-lockfile` | Sortie 0. « Already up to date — Done in 710ms using pnpm v11.18.0 » (première installation à froid : 39,1 s, sortie 0, `postinstall: prisma generate` réussi). |
| `pnpm exec tsc --noEmit` | Sortie 0, aucune sortie (aucune erreur de type). |
| `pnpm lint` | Sortie 0, `eslint` sans aucun avertissement. |
| `pnpm test` | Sortie 0. `# tests 429`, `# pass 429`, `# fail 0`, `# cancelled 0`, `# skipped 0`. |
| `pnpm audit:deps` (`pnpm audit --audit-level=moderate`) | Sortie 0. « 2 vulnerabilities found — Severity: 1 low \| 1 high (1 ignored) ». La « high » ignorée est `braces` (GHSA-vfj7-8cjw-p6xm), ignorée par `auditConfig.ignoreGhsas` de `pnpm-workspace.yaml` (outillage Solidity de développement uniquement). La « low » est `elliptic <=6.6.1` (GHSA-848j-6mx2-7j84), sous le seuil `moderate`. Aucune des deux ne vient de la slice (aucune dépendance ajoutée ni modifiée). |
| `pnpm build` (avec `NEXT_PUBLIC_EVM_NETWORK=testnet EVM_NETWORK=testnet`, `DATABASE_URL` factice) | Sortie 0. La table des routes liste `ƒ /explorer` et plus `/audit`. |
| `playwright test` (suite complète, `e2e/`, hors `phala/`) | Sortie 0. **79 passed (1.7m)**, 0 échec, 0 ignoré. Inclut `audit-regressions.spec.ts` (17 tests), `sirius.spec.ts` (3 tests), `responsive.spec.ts` (35 tests) et les autres specs. |
| Redirection sur le build de production (`next start`, `curl -i`) | Voir §3 : 308 vers `/explorer` avec requête conservée, aucune boucle, aucun hôte externe. |
| Contre-épreuve du test de casse | Avec `addressesEqual` remplacé par `===` : `1 failed` (test attendu rouge) ; code rétabli ensuite (vérifié par `git diff`). |
| `git diff --name-only staging...HEAD` | Voir ci-dessous. |
| `git log staging..HEAD --format=%B` | Voir ci-dessous. |

**Échecs liés à l'environnement, non masqués :**

1. Le Chromium préinstallé (`/opt/pw-browsers/chromium`, build 1194) n'est pas celui que la version de Playwright du dépôt attend (1228). La première tentative a échoué avec `browserType.launch: Executable doesn't exist at …chromium_headless_shell-1228…` (15 tests en échec, sans rapport avec le code). Les résultats ci-dessus viennent d'une configuration temporaire hors dépôt qui ajoute `executablePath` et `--no-sandbox`. Le CI du dépôt installe son propre Chromium (`playwright install --with-deps chromium`) : ce contournement ne s'y applique pas.
2. `next start` en production répond 500 sur toute page tant que `SIRIUS_SESSION_SECRET` n'est pas défini (« SIRIUS_SESSION_SECRET obligatoire en production », `instrumentation`). Les vérifications de redirection par `curl` ne dépendent pas de ce secret (la redirection est appliquée avant le rendu), mais le rendu de `/explorer` n'a pas été vérifié sur le build de production, seulement sur `next dev` (e2e).
3. Non exécutés (hors périmètre de la consigne et nécessitent une base ou un compilateur de contrats) : `pnpm test:phala-demo`, `test:operations`, `test:postgres`, `contracts:test`, `test:billing`, `datasets:generate`, que le CI exécute en plus.

**Contrôles avant la PR** (exécutés sur la tête finale de la branche, une fois ce fichier commité) :

- `git diff --name-only staging...HEAD` : `docs/passage-mainnet/audit.md`, `e2e/audit-regressions.spec.ts`, `e2e/responsive.spec.ts`, `e2e/sirius.spec.ts`, `next.config.ts`, `src/app/(app)/explorer/page.tsx`, `src/components/layout/Sidebar.tsx`, `src/lib/i18n/english.ts` — tous dans le périmètre autorisé (le renommage `audit/page.tsx` → `explorer/page.tsx` apparaît comme un seul fichier). Aucun des fichiers de consignes d'assistant à la racine (non suivis, jamais ajoutés ; `next dev` en recrée un), ni le dossier de configuration de l'assistant.
- `git log staging..HEAD --format=%B` : recherche insensible à la casse des mentions de co-signature, de nom d'assistant, de domaine de son éditeur, de mention « généré par » et de marqueur d'omission de CI : aucune occurrence. Auteur et committer de chaque commit : l'identité du propriétaire du dépôt.


### 10. Revue interne de la session

Deux tours de revue adversariale, par des agents indépendants en lecture seule (angles : sécurité et contrôle d'accès ; exactitude et non-régression du remboursement ; tests et cas limites ; textes, traduction, accessibilité ; conformité au cahier des charges et au périmètre). Chaque constat était soumis à deux sceptiques chargés de le réfuter ; un constat n'est retenu que si le raisonnement survit à la lecture du code.

**Tour 1** (65 agents : 5 relecteurs, 2 sceptiques par constat) — 7 constats confirmés, 23 écartés.

Confirmés, et traitement :

| Constat | Gravité | Traitement |
|---|---|---|
| Le `take: 100` de l'API s'applique avant le filtre de la page : un wallet fournisseur actif et emprunteur peut perdre ses emprunts anciens, et la page affichait « No borrowing » (signalé par 4 relecteurs sous 4 formulations) | mineur à majeur | **Corrigé côté page** : bandeau `role="status"` dès 100 lignes, message « No borrowing » supprimé dans ce cas, test e2e. **Non corrigeable dans le périmètre** (route hors périmètre) : consigné §2.3, §7.2, §8.1. |
| Test de casse d'adresse vide : `A.toUpperCase()` d'une adresse sans lettre hexadécimale ne change rien, le test restait vert avec `===` | majeur (test) | **Corrigé** : adresses avec lettres, deux sens, contre-épreuve `===` rouge puis rétablie. |
| Commentaire de la page affirmant que les prêts fournisseur « appartiennent à Mes datasets » alors que cette page n'affiche aucun prêt ; perte de la vue fournisseur | mineur | **Commentaire corrigé** ; écart consigné §2.1, §7.3, §8.3. |
| Section A7 non remplie | mineur | Remplie (cette section). |

Écartés au tour 1 (avec la raison donnée par les sceptiques, que j'ai relue) :

- *La charge réseau de `/api/audit` contient des prêts d'autres wallets* : pas une régression (route inchangée), le fournisseur est partie au prêt, mêmes données que `/api/loans` ; **mais consigné** comme risque résiduel (§2.2, §7.1) car l'exigence « aucune donnée d'un autre wallet » est lue strictement.
- *Plafond de 100 → compteurs faux* (variante) : fusionné avec le constat confirmé ci-dessus.
- *Lien `/audit` dans la page Status, commentaire de `explorer.ts`, « audit ledger » dans les conditions d'utilisation* : réels mais hors périmètre ; la redirection les rattrape. Consignés §3 et §8.2.
- *Repli par nom du compteur « Datasets borrowed »* : inatteignable, `prepareLoan` exige `evmDatasetId` (consigné en hypothèse §6).
- *Test « sans wallet » ne peut pas échouer* / *assertions de redirection permissives* : faiblesses hypothétiques, pas des défauts ; le test de redirection vérifie statut et `Location` exacts.
- *Sous-titre qui promet trop*, *« Audit receipt » restant*, *nom accessible du lien fournisseur*, *« Release USDC / Pending » pour un prêt annulé* : textes ou comportements hérités de l'ancienne page, sans promesse fausse ; consignés §7.
- *`tokenExplorerUrl` non utilisé* : l'ancienne page ne l'utilisait pas ; la justification est précisée en §2.8 (l'écart de formulation a été relevé au tour 2 et corrigé ici).
- *Certificat d'exécution absent* : slice N6 (§2.9).
- *Badge REFUNDED ajouté sans demande* : faux, présent avant la slice.
- *Identité d'assistant comme auteur et committer du premier commit* : écarté par les sceptiques comme hors du texte de la règle (« fichiers »), mais **corrigé quand même**, la règle du propriétaire visant aussi les commits (§2.10).
- *Aucun e2e exécuté dans l'environnement de revue* : limite de l'environnement des relecteurs (Playwright interdit), pas un défaut ; les e2e ont été exécutés par la session (§9).

**Tour 2** (37 agents, sur les 2 commits corrigés) — **0 constat confirmé**, 16 écartés : charge réseau de `/api/audit` (déjà consignée) ; compteurs à zéro avant chargement (cosmétique, consigné §7.5) ; absence de test sur réponse tardive ou compte non authentifié (couverts par le remontage `key`, comportement correct) ; texte « Your 100 most recent loans » (exact : ce sont les 100 plus récents, tous rôles) ; nom accessible identique des liens « Verify » (hérité) ; sous-titre ; restes « audit ledger » hors périmètre ; couplage de la constante `API_LOAN_LIMIT` avec le `take: 100` de la route (hypothétique, mais documenté §2.3) ; « Audit receipt » ; sélecteur de compteurs fragile (correct aujourd'hui, noté §5) ; certificat ; commentaire de `explorer.ts` ; justification imprécise de `tokenExplorerUrl` (juste : l'adresse du registre est lisible côté navigateur ; la raison réelle est l'ambiguïté du registre d'origine, texte §2.8 corrigé en conséquence) ; auteur du premier commit encore à l'identité de l'assistant (corrigé avant le push par réécriture, §2.10).

Condition d'arrêt : le tour 2 n'a rien trouvé de nouveau ; la revue s'arrête là. **Limite de cette revue** : les relecteurs étaient en lecture seule et n'ont pas pu exécuter Playwright ni `next dev` (verrou et port partagés) ; seules les vérifications de la session (§9) ont été exécutées.

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

Branche `feat/self-training-admin`, PR vers `staging`. Périmètre : contrôle **côté serveur** uniquement. Le masquage dans l'interface (`src/app/(app)/**`, `src/components/**`) est fait par une autre session et n'est pas couvert ici.

### 1. Ce qui a changé

Aucune table, aucune colonne, aucune migration, aucun composant d'interface.

**Nouveaux fichiers**

- `src/lib/auth/admin.ts` : `adminAddresses(configured)` et `adminAllowed(address, configured)`. Lit `SIRIUS_ADMIN_ADDRESSES` par défaut (paramètre `configured` injectable pour les tests). Normalise avec `tryNormalizeAddress` de `src/lib/evm/address.ts` (la brique du projet : trim, `isAddress` non strict, minuscules), refuse l'adresse nulle, dédoublonne, plafonne à `MAX_ADMIN_ADDRESSES = 10`. Avertissement `console.warn` une seule fois par valeur mal formée, sans la valeur.
- `src/lib/sirius/self-training-access.ts` : `SELF_TRAINING_UNAVAILABLE = "Bientôt disponible"`, `phalaDemoInstance(env)`, `isDemoTrainingGrant(grant)`, `selfTrainingUnavailable()` (AppError 403) et la garde `assertSelfTrainingAccess(session, demoAccess = false)`.
- `src/app/api/admin/me/route.ts` : `GET`, `requireAuth` puis `{ admin: adminAllowed(session.address) }`, en-tête `cache-control: no-store`. Aucune base, aucun corps.
- `src/lib/auth/admin.test.ts` : tests unitaires de la liste.
- `src/lib/auth/self-training-routes.test.ts` : tests par inspection de source et par exécution des routes dans un bac à sable VM (même technique que `src/lib/audit-regressions.test.ts`).

**Fichiers modifiés**

- `src/app/api/train/route.ts` : `GET` appelle `assertSelfTrainingAccess(session, true)` juste après `requireAuth`, avant `prisma`. `POST` appelle `assertSelfTrainingAccess(session, true)` juste après `requireAuth` et avant `readJson`, puis `assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization))` juste après `readJson` et avant la validation du corps, `assertAuthenticGrant` et `runSelfTrain`.
- `src/app/api/train/[id]/key/route.ts` : `POST` appelle `assertSelfTrainingAccess(session)` (admin seulement, pas d'exception démo) juste après `requireAuth`, avant le rate limiter, `params`, `readJson`, la base et le runner.
- `src/lib/i18n/errors-en.ts` : inchangé au final. Le message « Bientôt disponible » existait déjà dans `src/lib/i18n/english.ts` (« Coming soon ») ; le doublon ajouté dans un premier temps a été retiré après revue, et un test vérifie que `EN_MESSAGES` garde la clé.
- `docs/BACKUP-RECOVERY.md` : une phrase sur `SIRIUS_ADMIN_ADDRESSES` pour le script de reprise `ops:verify-model-delivery` (voir 2.13).
- `package.json` : `admin.test.ts` et `self-training-routes.test.ts` ajoutés au script `test`.
- `playwright.config.ts` : `SIRIUS_ADMIN_ADDRESSES` = adresse du wallet e2e (dérivée de la clé `0x11…11` de `e2e/helpers/wallet.ts`), dans `webServer.env` uniquement.
- `.env.example` : bloc `SIRIUS_ADMIN_ADDRESSES`.
- `docs/passage-mainnet/10-self-training.md` : en-tête « Fichiers » complété, section « Contrôle côté serveur (N5) ».
- `docs/passage-mainnet/audit.md` : cette section.

**Routes concernées et comportement pour un wallet authentifié hors équipe**

| Route | Hors démo (production, mainnet) | Instance de démo Phala (testnet) |
|---|---|---|
| `GET /api/train` | 403 `{ "error": "Bientôt disponible" }`, aucune lecture en base | 200, liste de ses propres jobs (inchangé) |
| `POST /api/train` | 403, **corps non lu** (un corps mal formé donne 403, pas 400/415) | corps lu ; 403 sauf si `authorization.payload.demoSessionRevision` est un entier strictement positif ; alors flux inchangé (grant authentifié, runner vérifie la session de démo) |
| `POST /api/train/[id]/key` | 403, corps non lu, rate limiter non touché | 403, idem (la démo livre ses clés par `/api/phala-demo/results/[id]`) |
| `GET /api/admin/me` | `{ "admin": false }` | `{ "admin": false }` |

Non authentifié : 401 « Authentification requise » par `requireAuth`, comme avant, sur toutes ces routes. « Instance de démo Phala » = exactement les conditions de `demoEnabled` (`SIRIUS_PHALA_DEMO=true`, `EVM_NETWORK=testnet`, `TEE_MODE=phala`, `DSTACK_SIMULATOR_ENDPOINT` vide), évaluées sans lever par `phalaDemoInstance`.

### 2. Décisions et écarts par rapport au cahier des charges

1. **Exception pour la démo Phala (écart le plus important, à relire en priorité).** Le cahier des charges demande 403 pour tout wallet non admin. Or la démo publique « Test Phala » ([12](12-test-phala.md) : « On la garde ») est elle-même un self training sur ses propres données et passe par `GET /api/train` (liste des jobs dans `src/components/phala-demo/PhalaDemo.tsx`) et `POST /api/train` (`src/lib/phala-demo/training-client.ts`). Une garde sans exception aurait fermé la démo à tous les visiteurs, et aucun test e2e ne l'aurait vu (ils simulent toute l'API). L'exception est volontairement étroite : (a) l'instance doit réunir les conditions de `demoEnabled` (`SIRIUS_PHALA_DEMO=true`, `EVM_NETWORK=testnet`, `TEE_MODE=phala`, pas de simulateur dstack), ce qui est impossible en production mainnet (`requiresPhalaRunner` dans `src/lib/runner/config.ts` refuse déjà la démo hors testnet au démarrage, et `phalaDemoInstance` l'exige une seconde fois) ; (b) seules la liste des jobs et un `POST` porté par un grant de démo (`payload.demoSessionRevision` entier strictement positif : la première ouverture de session porte la révision 1) sont ouverts ; (c) la livraison de clé reste réservée à l'équipe partout. Conséquence à connaître : **sur staging, qui est l'instance de démo (`SIRIUS_PHALA_DEMO=true` d'après `docs/PHALA-DEMO-IMPLEMENTATION.md`), un wallet non admin peut toujours lancer un entraînement sur ses propres données en forgeant un grant avec `demoSessionRevision`**, exactement comme la démo le fait aujourd'hui ; le runner le refuse si la session de démo est fermée (`checkDemoOperation`, `withDemoAdmission` dans `src/lib/phala-demo/runner-session.ts`). Si l'équipe préfère fermer complètement le self training sur staging, il suffit de retirer `SIRIUS_PHALA_DEMO` de staging ou de supprimer les deux `demoAccess=true` ; la démo cesse alors de fonctionner.
2. **`GET /api/train` est gardé** bien que le cahier des charges cite surtout les routes d'action : la liste des jobs révèle l'existence de la fonction et des données d'entraînement. La page `/train` tolère déjà un `GET` en échec (`jobsRes.ok ? … : []` dans `src/app/(app)/train/page.tsx`, non modifié) : aucun message d'erreur visible pour un non-admin.
3. **Liste fermée par défaut** : une seule entrée invalide refuse toute la liste, comme `operatorAllowed`. Alternative écartée : ignorer l'entrée invalide et garder les autres, parce qu'une liste partiellement lue est plus difficile à auditer qu'un refus franc et visible dans les journaux.
4. **Plafond de dix adresses**, repris d'`operatorAllowed`. Au-delà, la liste est refusée.
5. **Casse** : toute casse acceptée dans la variable et dans la session, préfixe `0X` compris (mis en minuscules avant `tryNormalizeAddress`, qui n'accepte que `0x`), comparaison en minuscules, conformément à la règle du projet dans `src/lib/evm/address.ts`. La somme de contrôle EIP-55 n'est pas vérifiée (comme partout ailleurs dans le projet) : une adresse en casse mixte avec une somme fausse est acceptée si ses 40 hexadécimaux sont les bons.
6. **Message** : « Bientôt disponible » (anglais « Coming soon »), sans le mot « self training », « admin » ni « réservé ». Même message pour toutes les routes et pour une liste vide ou mal formée.
7. **Premier refus avant la lecture du corps** sur `POST /api/train` et `POST /api/train/[id]/key` : un non-admin hors démo ne reçoit jamais les messages 400/415 qui décriraient le format attendu. Sur l'instance de démo, le corps doit être lu pour reconnaître un grant de démo : un non-admin y voit donc les 400/415 habituels (comportement d'aujourd'hui).
8. **Pas de journalisation des refus** (qui, quand). Le cahier [15](15-dashboard-admin.md) demande la journalisation des actions d'admin pour V1.2, pas des refus ; non fait ici pour éviter un journal inondé par des appels directs.
9. **`/api/admin/me` répond 401 sans session**, pas `{ admin: false }` : conforme à « protégée par requireAuth ». L'interface devra traiter 401 comme « pas admin ».
10. **Emplacement** : `adminAllowed` dans `src/lib/auth/` (demandé) ; la garde spécifique au self training dans `src/lib/sirius/`, à côté de `self-train.ts`, pour que l'inspection de source puisse exiger qu'elle ne serve qu'aux routes de self training.
11. **`runSelfTrain` (la fonction de `src/lib/sirius/self-train.ts`) n'est pas gardée elle-même**, seulement ses routes. `scripts/test/postgres-worker.ts` l'appelle directement pour les tests d'intégration Postgres ; une garde dans la fonction aurait exigé la variable dans cet environnement. Le test par inspection vérifie qu'aucun autre fichier de `src/` n'importe ce module.
12. **Wallet e2e admin** via `playwright.config.ts` (`webServer.env`), pas via un fichier `.env` : la valeur ne concerne que le serveur de test local. Les e2e actuels simulent toute l'API (`page.route("**/api/**")` dans `e2e/helpers/wallet.ts`) et n'atteignent pas les routes réelles ; la déclaration sert si un e2e futur les atteint.
13. **Script de reprise `scripts/operations/verify-model-delivery.ts`** (runbook `docs/BACKUP-RECOVERY.md`) : trouvé par la revue adversariale. Il se connecte en HTTP avec l'adresse dérivée de `ROBINHOOD_DEPLOYER_KEY` et appelle `GET /api/train` puis `POST /api/train/[id]/key`. Avec la garde, si cette adresse n'est pas dans `SIRIUS_ADMIN_ADDRESSES` de l'instance interrogée, la requête reçoit 403 et le script s'arrête : l'erreur interne « Requête refusée » est avalée par son `catch` final, la seule sortie est un diagnostic JSON sur stderr (`phase`, `verified: false`) et `failurePhase` + `httpStatus: 403` dans `report.json`. Seuls les modèles d'entraînement de l'inventaire passent par les routes gardées ; les prêts passent par `/api/loans`. Choix : ne pas modifier le script (hors périmètre, couvert par ses propres tests) ; documenter la dépendance dans `.env.example`, `10-self-training.md` et `BACKUP-RECOVERY.md`. L'ancienne instance historique visée par le runbook ne porte pas ce code tant qu'elle n'est pas redéployée.
14. **`phalaDemoInstance` ne réutilise pas `demoEnabled`** (`src/lib/phala-demo/runner-session.ts`), qui lève des 503 explicites sur une configuration incomplète : ici une configuration incomplète ferme simplement l'exception, sans message qui révélerait l'instance. Les conditions sont les mêmes ; un test les fixe.
15. **Pas de traduction nouvelle** : « Bientôt disponible » existait dans `english.ts`. Le cahier des charges demandait une traduction dans `errors-en.ts` pour toute chaîne nouvelle ; la chaîne n'étant pas nouvelle, le doublon a été retiré.

### 3. Ce que l'audit doit vérifier

**Contrôle d'accès côté serveur, route par route**

- `src/app/api/train/route.ts` `GET` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `prisma`. Rien entre les deux.
- `src/app/api/train/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `readJson` → `assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization))` → validation du corps → `assertAuthenticGrant` → `runSelfTrain`. Vérifier qu'un `demoSessionRevision` dans le grant n'ouvre rien d'autre que cette garde : le grant est ensuite authentifié (`assertAuthenticGrant` : sujet = wallet connecté, signatures) et le runner contrôle la session de démo. Un grant forgé est refusé par `assertAuthenticGrant` avant tout appel runner, comme avant la slice.
- `src/app/api/train/[id]/key/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session)` → rate limiter → … Aucune exception démo.
- `src/app/api/admin/me/route.ts` : `requireAuth` → `adminAllowed(session.address)`. Vérifier que la réponse n'est pas mise en cache (`no-store`) et qu'elle ne révèle pas la liste.
- `src/lib/sirius/self-training-access.ts` : `adminAllowed(session.address)` d'abord ; l'exemption ne s'applique que si `demoAccess && phalaDemoInstance()`. `phalaDemoInstance` lit `process.env` à chaque appel (pas de cache) et exige exactement `"true"` et `"testnet"`.
- Aucun autre fichier de `src/` n'importe le module `self-train` (import statique, réexport, `import()` ou `require`, alias ou chemin relatif) ; `selfTrainModelKeyInRunner` n'apparaît que dans `src/lib/tee/runner-client.ts` (définition) et `src/app/api/train/[id]/key/route.ts` (appel) ; `runSelfTrainingInRunner` que dans `src/lib/tee/runner-client.ts` et `src/lib/sirius/self-train.ts` ; `assertSelfTrainingAccess` n'est appelée que par les routes : vérifié par le test d'inspection sur l'arbre syntaxique, à revérifier à la main avec `grep -rn "sirius/self-train" src`, `grep -rn selfTrainModelKeyInRunner src` et `grep -rn runSelfTrainingInRunner src`.
- Aucun contournement par appel direct : les trois routes sont les seuls points d'entrée HTTP vers le self training. `scripts/test/postgres-worker.ts` appelle `runSelfTrain` en code, dans les tests Postgres seulement. `scripts/operations/verify-model-delivery.ts` passe lui par HTTP (`GET /api/train`, `POST /api/train/[id]/key`) avec l'adresse de `ROBINHOOD_DEPLOYER_KEY` : il est soumis à la garde comme n'importe quel client, et doit donc être exécuté avec une adresse admin (2.13).
- Le runner (`src/runner/**`, non touché) n'a pas de notion d'admin : il n'est joignable que par Next (`RUNNER_TRANSPORT_SECRET`) et par le contrôleur. La garde ne protège donc que l'entrée HTTP de Next ; c'est le périmètre demandé.

**Variable `SIRIUS_ADMIN_ADDRESSES`**

- Vide, absente, espaces seuls → `[]` → personne.
- `a,b` valides → les deux ; casse indifférente ; doublons fusionnés ; espaces autour des virgules tolérés.
- Une entrée invalide, l'adresse nulle, `a,` (virgule finale), `,a`, `a,,b`, séparateur `;` ou espace, plus de dix entrées → `[]` → personne, avertissement console `[admin] SIRIUS_ADMIN_ADDRESSES mal formée : aucune adresse n'est administratrice` une fois par valeur.
- Préfixe `0X` accepté dans la variable comme dans l'adresse comparée (mis en minuscules avant validation).
- La variable n'est lue qu'au moment de l'appel (pas de cache de la liste) : un changement d'environnement prend effet au redéploiement, comme toute variable Vercel.

**Fuites**

- Message 403 identique pour : non admin, liste vide, liste mal formée, instance de démo sans grant de démo. Aucun indice sur la raison.
- Les codes 400/415 du corps ne sont jamais atteints par un non-admin hors démo (corps non lu).
- Journaux : seul l'avertissement de variable mal formée, sans valeur ni adresse. Les refus ne sont pas journalisés.
- `/api/admin/me` : un booléen, rien d'autre.

**Argent, escrow, contrats, moteur Phala**

- Aucune transaction, aucun appel contrat. Le refus intervient avant `assertAuthenticGrant` et avant tout appel runner : aucun budget runner consommé, aucun échec compté dans le coupe-circuit du runner.
- Le self training n'a jamais eu d'escrow (propriétaire = emprunteur) : pas d'impact financier.

**Base de données** : aucune lecture avant le refus (vérifié dans le bac à sable : `findMany`/`findUnique` jamais appelés pour un non-admin). Aucune migration.

**Interface** : hors périmètre ; voir la slice de masquage. Point de coordination : l'interface pourra appeler `GET /api/admin/me` (401 = pas admin) ; `GET /api/train` renvoie 403 aux non-admins, ce que `src/app/(app)/train/page.tsx` et `PhalaDemo.tsx` tolèrent déjà sans erreur affichée.

**Textes** : « Bientôt disponible » ne promet rien ; la doc 10 décrit exactement le code.

### 4. Cas limites à essayer à la main sur staging

Préparer deux wallets : A (dans `SIRIUS_ADMIN_ADDRESSES` de staging) et B (absent). Se connecter et signer avec chacun. Rappel : staging est l'instance de démo Phala (`SIRIUS_PHALA_DEMO=true`, testnet), donc les lignes « démo » s'y appliquent ; pour tester le comportement « production », utiliser un déploiement de prévisualisation sans `SIRIUS_PHALA_DEMO`.

1. **B, non authentifié**, `curl -i https://STAGING/api/train` → 401 `{"error":"Authentification requise"}`.
2. **B, authentifié** (cookie de session du navigateur), `GET /api/train` → sur l'instance de démo : 200 `[]` (ou ses jobs de démo) ; hors démo : 403 `{"error":"Bientôt disponible"}`.
3. **B**, `POST /api/train` avec `Content-Type: text/plain` et corps `x`, en-tête `Origin` de staging → hors démo : 403 « Bientôt disponible » (pas 415) ; instance de démo : 415 « Content-Type application/json requis » (le corps est lu pour chercher un grant de démo).
4. **B**, `POST /api/train` JSON `{"datasetId":"x","jobId":"y","datasetReceipt":"z","authorization":{"payload":{"subject":"<B>"}}}` → 403 « Bientôt disponible » partout.
5. **B** sur la démo, même corps avec `"authorization":{"payload":{"subject":"<B>","demoSessionRevision":1}}` → passe la garde, puis 401 « Autorisation runner invalide » (délégation absente) ; avec un `subject` différent de B, 403 « Le grant runner ne correspond pas au wallet connecté ». Dans les deux cas aucun appel runner (vérifier le rapport de budget du runner : aucune opération, aucun échec compté).
6. **B**, `POST /api/train/<id>/key` avec n'importe quel corps → 403 « Bientôt disponible » partout, y compris sur la démo ; vérifier que le rate limiter n'a pas compté : 25 appels de suite dans la minute restent en 403, jamais 429 (le limiteur de la route autorise 20 appels par minute et par wallet : un admin qui en enchaîne 21 reçoit 429 au 21e).
7. **B**, `GET /api/admin/me` → 200 `{"admin":false}`, en-tête `cache-control: no-store`.
8. **A**, `GET /api/admin/me` → `{"admin":true}`. `GET /api/train` → 200 avec ses jobs. `POST /api/train` avec un corps incomplet → 400 « Requête d’entraînement incomplète » (preuve que la garde est passée).
9. **A écrit en casse mixte** dans la variable (forme EIP-55), session en minuscules → toujours admin.
10. **Variable mal formée** sur un déploiement de prévisualisation (`<A>,` avec virgule finale, ou `<A>;<B>`) → A reçoit 403 ; journaux du serveur : une ligne `[admin] SIRIUS_ADMIN_ADDRESSES mal formée`. Puis variable vide → A reçoit 403, pas d'avertissement.
11. **Démo Phala ouverte**, wallet B, parcours complet sur `/phala` (exemple, entraîner, télécharger) → fonctionne comme avant la slice.
12. **Démo Phala fermée**, wallet B, `POST /api/train` avec grant de démo signé par le parcours → refus du runner « Démonstration Phala fermée » (comportement d'avant la slice, inchangé).
13. **Page `/train`**, wallet B → aucune erreur visible liée à `GET /api/train` (la page traite le 403 comme une liste vide) ; l'encart de self training est masqué par l'autre slice.
14. **Script de reprise** `pnpm ops:verify-model-delivery` contre une instance portant ce code, avec un fichier d'environnement dont `ROBINHOOD_DEPLOYER_KEY` dérive une adresse hors `SIRIUS_ADMIN_ADDRESSES` → exit 1, rien sur stdout, un JSON sur stderr avec `verified: false` et `phase` « historique-proprietaire » (hors démo : arrêt dès `GET /api/train`) ou « livraison-cle » (instance de démo Phala : la liste passe, arrêt sur `POST /api/train/[id]/key`) ; `report.json` porte `failurePhase` et `httpStatus: 403` (le `httpStatus` du JSON stderr peut valoir 200, écrasé par la déconnexion finale). La chaîne « Requête refusée » n'apparaît nulle part : c'est une erreur interne du script. Avec l'adresse ajoutée à la variable → parcours complet comme avant.
15. **Instance de démo mal configurée** (prévisualisation avec `SIRIUS_PHALA_DEMO=true` et `TEE_MODE=stub`) → l'instance refuse de démarrer (`runnerEndpoint`, appelé au démarrage par `assertApplicationRunnerConfiguration` : dès que la démo est active, `RUNNER_URL` est obligatoire et `TEE_MODE=phala` sans simulateur exigé) ; si elle démarrait, `phalaDemoInstance` renverrait faux et B recevrait 403 partout.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

`src/lib/auth/admin.test.ts` (8 tests) : liste valide, casse (variable et adresse, préfixe `0X` compris), espaces et doublons, liste vide/absente, douze formes invalides (chacune refuse toute la liste, un avertissement par valeur, sans la valeur dans le message), plafond de dix, adresses comparées invalides, lecture par défaut de `process.env`.

`src/lib/auth/self-training-routes.test.ts` (14 tests) :
- inspection de l'arbre syntaxique TypeScript (un commentaire ou une chaîne ne satisfait pas le contrôle) : la liste des routes sous `src/app/api/train` est exactement les deux attendues ; chaque handler exporté, qu'il soit déclaré `export async function`, `export function` ou `export const X = …` (une réexportation fait échouer le test), appelle la garde après `requireAuth`, sans expression `await` entre les deux, et avant tout appel à `prisma.*`, `readJson`, `assertAuthenticGrant`, `runSelfTrain`, `selfTrainModelKeyInRunner`, `enforceRateLimit`, `assertCurrentRunner`, `assertOwner` et toute lecture de `params` ; `GET`/`POST` passent `true` puis `isDemoTrainingGrant(authorization)` entre le corps et le grant, la route de clé passe `session` seul ; aucun autre fichier de `src/` n'importe le module `self-train` (statique, réexport, `import()`, `require`, alias ou relatif), n'utilise `selfTrainModelKeyInRunner` (liste exacte : `runner-client.ts`, route de clé) ni `runSelfTrainingInRunner` (liste exacte : `runner-client.ts`, `self-train.ts`), ni n'appelle `assertSelfTrainingAccess` hors des routes (importer le message `SELF_TRAINING_UNAVAILABLE` ailleurs reste permis, pour une future page « bientôt ») ; `src/runner/handler` (chemin runner en processus) n'est importé que par `src/lib/tee/runner-client.ts` ; la résolution des spécificateurs (alias `@/`, relatif, frère `./self-train`, extension) est elle-même testée sur une source synthétique ; les fichiers `route.(ts|tsx|js|mjs|cjs)` sont tous énumérés ; les handlers exportés par chaque module transpilé sont exactement ceux que l'inspection a vus ; `/api/admin/me` sans base ni corps ; message traduit et sans mot révélateur ; `phalaDemoInstance` et `isDemoTrainingGrant` sur leurs cas limites ;
- bac à sable VM (routes réelles transpilées, dépendances coûteuses remplacées par des enregistreurs, garde et liste réelles) : non admin hors démo refusé sur chaque route avec `[]` appels et `request.bodyUsed === false` ; admin accepté (variable et session en toute casse, `0X` compris) avec l'ordre `assertAuthenticGrant` puis `runSelfTrain` ; liste vide ou mal formée refuse même l'adresse attendue ; instance de démo : `GET` ouvert, `POST` ouvert seulement avec `demoSessionRevision` entier strictement positif (0, négatif, décimal, chaîne refusés, corps lu), clé fermée ; aucune exemption hors testnet, hors `TEE_MODE=phala`, avec simulateur ou avec un drapeau approximatif.

**Angles morts**

- Aucun test n'exécute les vraies routes Next avec une vraie session, un vrai `readSession` ni la vraie base : le bac à sable remplace `requireAuth`. La chaîne cookie → session → adresse n'est pas re-testée ici (couverte ailleurs).
- Les e2e Playwright n'atteignent pas les routes réelles ; la déclaration du wallet e2e dans `playwright.config.ts` n'est donc exercée par aucun test aujourd'hui.
- Le runner n'est pas exécuté : la vérification de `demoSessionRevision` contre la session ouverte reste couverte par `src/lib/phala-demo/runner-session.test.ts`, inchangé.
- La page `/train` et `PhalaDemo.tsx` ne sont pas testées face à un 403 (interface hors périmètre).
- Les tests par inspection reposent sur les noms `requireAuth`, `assertSelfTrainingAccess`, `readJson`, etc. : une réécriture qui renomme la garde ou lit le corps autrement doit mettre ces tests à jour. Un handler défini dans un autre fichier puis réexporté, ou exporté par déstructuration, fait échouer le test au lieu d'être inspecté.
- L'inspection syntaxique prouve la présence et l'ordre des appels, pas leur exécution : une garde placée dans une fermeture jamais appelée, ou une lecture du corps par `req.clone()` avant la garde, lui échapperaient. C'est le bac à sable qui porte la preuve d'exécution, et il n'exerce que les handlers existants : tout nouveau handler doit y être ajouté (le test « handlers inspectés = handlers exportés » signale au moins son apparition).
- `runSelfTrain` est aussi le nom de la fonction navigateur de `src/lib/train/client.ts` : le test épingle la liste exacte des fichiers qui l'utilisent, à mettre à jour sciemment.
- `scripts/operations/verify-model-delivery.ts` n'est pas exécuté contre les routes gardées (il cible une instance distante) ; seul son comportement attendu est documenté (4.14).

### 6. Hypothèses

- Staging déclare `SIRIUS_PHALA_DEMO=true`, `EVM_NETWORK=testnet`, `TEE_MODE=phala` sans simulateur (sinon `runnerEndpoint` refuse de démarrer l'instance) (d'après `docs/PHALA-DEMO-IMPLEMENTATION.md` et `PHALA-DEMO-RESTE-A-FAIRE.md`) ; non vérifié dans Vercel depuis cette session.
- La production mainnet ne déclare pas `SIRIUS_PHALA_DEMO=true` ; si elle le faisait, `requiresPhalaRunner` refuserait de démarrer (« La démonstration Phala exige le testnet ») et `phalaDemoInstance` renverrait de toute façon faux hors testnet.
- `session.address` est une adresse normalisée en minuscules à la connexion (`verifyLoginSignature` → `normalizeAddress`, puis `setSession`) et relue telle quelle par `readSession` ; la garde tolère de toute façon toute casse.
- Le grant de démo porte bien `payload.demoSessionRevision` (lu dans `src/lib/runner/authorization-contract.ts` et `training-client.ts` : `...await demoScope()` ajoute `demoSessionRevision` aux paramètres du grant) ; vérifié par lecture, pas par exécution du parcours.
- Les deux adresses de l'équipe seront renseignées dans Vercel (staging et production) avant la fusion : sans elles, personne n'accède au self training, ce qui est le comportement voulu par défaut.
- Les tests Postgres (`pnpm test:postgres`) et billing n'ont pas été lancés ici (pas de base ni de compilation Hardhat dans l'environnement) ; ils n'importent pas les routes modifiées.

### 7. Risques résiduels et limites connues

- **Sur staging, le self training reste techniquement accessible aux non-admins par un `POST` direct portant un grant de démo** (voir 2.1). Risque borné au testnet, à la session de démo ouverte, aux quotas de la démo ; identique à l'état antérieur.
- Une faute de frappe dans `SIRIUS_ADMIN_ADDRESSES` ferme l'accès à toute l'équipe (volontaire) ; le seul signal est un avertissement dans les journaux du serveur et `GET /api/admin/me` à `false`.
- Pas d'horodatage ni de journal des accès admin (prévu en V1.2 par [15](15-dashboard-admin.md)).
- Le masquage côté interface relève d'une autre slice ; tant qu'elle n'est pas fusionnée, un non-admin voit l'encart de self training et reçoit « Bientôt disponible » / « Coming soon » en cliquant.
- Le script de reprise `ops:verify-model-delivery` exige désormais une adresse admin sur l'instance interrogée ; un opérateur qui l'ignore ne voit qu'un diagnostic JSON générique (`verified: false`, `phase`) sans indication de cause ; seul `report.json` porte `httpStatus: 403`.
- L'exception démo repose sur quatre variables d'environnement ; une instance testnet qui activerait la démo par erreur ouvrirait la liste des jobs et le `POST` avec grant de démo aux visiteurs (mais le runner refuserait sans session de démo ouverte et budget sponsorisé).

### 8. Reste à faire

1. (P1, avant fusion) Renseigner `SIRIUS_ADMIN_ADDRESSES` dans Vercel pour staging et production, avec les deux adresses de l'équipe, en minuscules, séparées par une virgule, sans virgule finale.
2. (P1) Slice de masquage : utiliser `GET /api/admin/me` (401 et `{ admin:false }` = masquer) et tolérer 403 sur `GET /api/train`.
3. (P2) Décider si staging doit fermer le self training hors démo : retirer les `demoAccess=true` ou séparer la démo sur sa propre route.
4. (P2) Journaliser les accès admin (qui, quoi, quand) quand le dashboard admin arrivera ([15](15-dashboard-admin.md)).
5. (P3) Un e2e qui atteint la vraie route `/api/train` avec le wallet de test, pour exercer la déclaration de `playwright.config.ts`.
6. (P3) Faire dire explicitement à `verify-model-delivery.ts` qu'un 403 vient de `SIRIUS_ADMIN_ADDRESSES`, au lieu du diagnostic JSON générique actuel (et ne plus laisser la déconnexion finale écraser le `httpStatus` affiché).

### 9. Résultats des vérifications

Environnement : conteneur Linux, Node v22.22.0, pnpm 11.18.0, `DATABASE_URL="postgresql://x:y@localhost:5432/z"` (factice : `prisma generate` du postinstall exige la variable, aucune base n'est jointe). Série finale lancée sur l'état du code de `61087ca` (dernier commit de la branche), après chaque passe de revue les mêmes commandes avaient été relancées.

| Commande | Résultat exact |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 ; « Already up to date », `prisma generate` OK. Au tout premier appel sans `DATABASE_URL`, le postinstall échouait (« PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL ») : contrainte d'environnement, pas de la slice. |
| `pnpm exec tsc --noEmit` | exit 0, aucune sortie. |
| `pnpm lint` | exit 0 (`eslint`, aucune sortie). |
| `pnpm test` | exit 0 ; 451 tests, 451 réussis, 0 échec (449 avant la slice + les deux nouveaux fichiers ; le compte net varie avec les sous-tests ajoutés) ; durée environ 18 s. |
| `pnpm audit:deps` | exit 0 ; « 2 vulnerabilities found, Severity: 1 low, 1 high (1 ignored) » : identique à `staging` avant la slice (lockfile inchangé). |
| `pnpm test:e2e` | exit 0 ; 71 tests, 71 réussis (1,8 min). Nécessite dans ce conteneur `PLAYWRIGHT_BROWSERS_PATH` pointant vers une copie du Chromium headless 1194 préinstallé renommée `chromium_headless_shell-1228` (Playwright 1.61 attend cette version et le téléchargement est bloqué par le proxy) ; sans cela les 71 tests échouent au lancement du navigateur (« Executable doesn't exist »), ce qui n'a rien à voir avec la slice. Le serveur `next dev` des e2e a démarré avec `SIRIUS_ADMIN_ADDRESSES` et l'import `viem/accounts` de `playwright.config.ts`. |
| Tests ciblés `admin.test.ts` + `self-training-routes.test.ts` | 22 tests (8 + 14), 22 réussis, à chaque relance. |
| `git diff --name-only staging...HEAD` | 13 fichiers, tous autorisés (liste en 1) ; aucun fichier sous `src/app/(app)/`, `src/components/`, `src/runner/`, `src/lib/runner/`. |
| `git log staging..HEAD --format=%B` | 6 commits en français ; aucune signature d'assistant, aucun `[skip ci]` (vérifié par grep `co-authored\|claude\|anthropic\|generated\|skip ci` : aucune occurrence). |
| `git diff staging...HEAD -- docs/passage-mainnet/audit.md` | un seul bloc modifié, la section N5. |

Non lancés ici : `pnpm test:postgres` (pas de base), `pnpm test:billing` et `pnpm contracts:test` (compilation Hardhat), `pnpm build` (lancé une fois par un agent de revue de la passe 1 : exit 0, routes `/api/admin/me`, `/api/train`, `/api/train/[id]/key` compilées). Effet de bord d'environnement : `next dev` recrée `CLAUDE.md` et `AGENTS.md` à la racine ; ils ont été supprimés avant chaque commit et ne sont pas versionnés.

### 10. Revue interne de la session

Trois passes de revue adversariale par agents indépendants, en lecture seule sur le dépôt. Chaque passe : des relecteurs sous des angles distincts (contournement du contrôle d'accès, exactitude et non-régression, tests et cas limites, conformité au cahier des charges et aux conventions), puis trois réfutateurs par constat (reproduction, spécification, sévérité) ; un constat n'est retenu que si au moins deux réfutateurs ne parviennent pas à le réfuter.

**Passe 1** (sur le premier commit, 4 relecteurs, 22 constats bruts ; 13 d'entre eux n'ont pas pu être vérifiés par les réfutateurs, les crédits d'usage étant épuisés en cours de passe : ils ont été jugés à la main, chaque décision est notée ici).

Corrigé :
- Le script de reprise `scripts/operations/verify-model-delivery.ts` appelle `GET /api/train` et `POST /api/train/[id]/key` en HTTP avec l'adresse de `ROBINHOOD_DEPLOYER_KEY` : soumis à la garde, non documenté, et la première version de cette section affirmait à tort qu'il ne passait pas par HTTP → documentation dans `.env.example`, `10-self-training.md`, `BACKUP-RECOVERY.md`, et correction de la section 3.
- Tests d'inspection par recherche de texte : ne reconnaissaient que `export async function`, la chaîne exacte `from "@/lib/sirius/self-train"`, et ignoraient `runSelfTrainingInRunner` ; un commentaire ou une chaîne pouvait satisfaire le contrôle ; « corps non lu » n'était pas prouvé → réécriture sur l'arbre syntaxique TypeScript (toutes les formes d'export, réexport refusé, imports statiques/dynamiques/`require`), symboles runner ajoutés, `request.bodyUsed` vérifié dans le bac à sable.
- Documentation plus stricte que le code : « corps non lu » sans condition alors que l'instance de démo lit le corps ; `/api/admin/me` présentée comme « réservée » ; plafond « dix entrées » sans dire que les doublons comptent → textes corrigés.
- `.env.example` et `10-self-training.md` disaient que `SIRIUS_DEMO_OPERATORS` « ne concerne que le contrôleur » alors qu'elle est aussi lue côté Next (`requireDemoOperator`) → corrigé.
- Préfixe `0X` : fermait toute la liste alors que la doc promettait « toute casse » → mis en minuscules avant validation, testé.
- `isDemoTrainingGrant` acceptait 0 et les entiers négatifs → entier strictement positif exigé (la première ouverture de session porte la révision 1).
- `phalaDemoInstance` plus permissive que `demoEnabled` (ne regardait ni `TEE_MODE` ni le simulateur) → alignée sur les mêmes conditions, sans lever.
- Traduction en double : « Bientôt disponible » existait déjà dans `english.ts` → doublon retiré de `errors-en.ts`.
- En-tête « Fichiers » de `10-self-training.md` sans les nouveaux modules → complété.
- Test « la garde n'est importée que par les routes » trop large (une future page « bientôt » importerait le message) → seuls les appels à `assertSelfTrainingAccess` sont restreints.

Écarté, avec la raison :
- « Exemption démo décidée sur un champ forgeable » et « le second refus repose sur une valeur non authentifiée » : exact, mais c'est le comportement de la démo publique elle-même, borné à l'instance de démo testnet ; le grant est ensuite authentifié et le runner vérifie la session. Assumé en 2.1 et 7.
- « Le critère Terminé quand de la doc 10 reste contredit sur staging » : même point ; staging est l'instance de démo. Décision à prendre par l'équipe (8.3).
- « Pré-requis de déploiement non porté par le pipeline » : exact, mais le pipeline n'injecte aucune variable métier ; noté en 8.1.
- « `warnedFor` et `console.warn` non isolés » : chaque fichier de test tourne dans son propre processus ; l'avertissement a tout de même été neutralisé dans les tests qui le déclenchent.
- « Aucun e2e n'exerce la garde » : exact, angle mort noté en 5 et 8.5.
- « Les 403 de la route de clé ne sont plus comptés par le rate limiter » : choix ; la garde est sans entrée-sortie, comme le 401 de `requireAuth` qui la précède déjà.
- « `phalaDemoInstance` devrait réutiliser `demoEnabled` » : `demoEnabled` lève des 503 explicites qui révéleraient l'instance ; mêmes conditions reprises à l'identique, décision 2.14.
- « Placement des tests sous `src/lib/auth` » : conforme aux voisins (`lifetimes.test.ts`).

**Passe 2** (après corrections, 4 relecteurs, 15 constats bruts, 11 retenus, tous de sévérité basse ou moyenne, aucun défaut de contrôle d'accès).

Corrigé :
- `.env.example` annonçait un 403 inconditionnel, sans l'exception démo (relevé trois fois, par trois angles) → une phrase ajoutée avec renvoi vers la doc 10.
- Résolution des imports par suffixe : `./self-train` depuis `src/lib/sirius/`, ou `@/lib/sirius/self-train.ts` avec extension, échappaient au test ; `runSelfTrain` non épinglé → résolution réelle des spécificateurs (alias, relatif, frère, extension), testée sur une source synthétique ; liste exacte des fichiers utilisant `runSelfTrain` (dont la fonction navigateur homonyme).
- `export const { PUT } = …` ignoré en silence → refusé explicitement ; test « handlers exportés par le module transpilé = handlers inspectés ».
- Énumération limitée à `route.ts` et aux sources `.ts/.tsx` → `route.(ts|tsx|js|mjs|cjs)` et sources `.js/.mjs/.cjs` incluses ; `src/runner/handler` (chemin runner en processus) épinglé à `src/lib/tee/runner-client.ts`.
- Plafond « doublons compris » non épinglé par un test → ajouté.
- Cas limite 4.5 : statut attendu faux (c'est un 401 « Autorisation runner invalide » quand la délégation manque, le 403 n'apparaît que si le sujet diffère) → corrigé.
- Cas limite 4.6 : « 20 appels » ne discriminait rien (le limiteur en autorise 20) → 25 appels, et 429 au 21e pour un admin.
- Cas limite 4.14 et `BACKUP-RECOVERY.md` : sur l'instance de démo, le script passe la liste et s'arrête sur la clé → les deux cas décrits.
- Cas limite 4.15 : le refus de démarrage vient de `runnerEndpoint`, pas de `requiresPhalaRunner` → corrigé.

Écarté, avec la raison :
- `/api/phala-demo/results/[id]` et `/api/models/[cid]` sans garde admin : antérieurs à la slice, hors du périmètre (ils ne mènent pas à `self-train.ts`) ; livraison de la démo au propriétaire du job. Réfuté 3/3.
- « L'arbre syntaxique ne prouve pas l'exécution » (garde dans une fermeture morte) et « `req.clone().json()` avant la garde invisible » : exacts comme limites de méthode, mais aucun code de ce genre n'existe et le bac à sable couvre les handlers existants ; notés en 5 comme angles morts.
- Avertissement `[admin] … mal formée` dans la sortie d'un test vert : neutralisé malgré tout (correctif trivial).

**Passe 3** (après la passe 2, 2 relecteurs : code et tests, exactitude de la documentation ; 6 constats bruts, 1 retenu ; 5 réfutations n'ont pas pu être rendues, la limite de session étant atteinte : jugés à la main, décision notée). Aucun défaut de code ni de contrôle d'accès ; les corrections de la passe 2 ont été confirmées une à une par les deux relecteurs.

Corrigé :
- « Requête refusée » présenté dans quatre documents comme le message vu par l'opérateur du script de reprise : c'est une erreur interne avalée par le `catch` final ; la sortie réelle est un diagnostic JSON sur stderr (`phase`, `verified: false`) et `failurePhase` + `httpStatus: 403` dans `report.json` ; seuls les modèles d'entraînement passent par les routes gardées → `BACKUP-RECOVERY.md`, `10-self-training.md`, sections 2.13, 4.14, 7 et 8.6 réécrites.
- Épinglage des symboles runner limité à « hors `src/lib/tee/` » : un réexport sous alias dans ce dossier aurait échappé au test → listes exactes de fichiers, `runner-client.ts` compris ; sections 3 et 5 reformulées (la route de clé appelle bien `selfTrainModelKeyInRunner`).
- Tableau de `10-self-training.md` : la ligne `GET` n'avait pas la réserve « hors instance de démo » de la ligne `POST` → ajoutée.
- Section 5 affirmait que le bac à sable refusait une révision négative alors que seul le test unitaire l'essayait → `-1` ajouté au bac à sable.
- Section 6 attribuait la mise en minuscules de `session.address` à `readSession` → corrigé (`verifyLoginSignature` → `normalizeAddress` → `setSession`).

Écarté : rien ; les six constats, tous documentaires ou de robustesse des tests, ont été appliqués. La passe n'ayant trouvé aucun défaut de code et seulement des imprécisions de texte, la revue s'arrête ici.

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

