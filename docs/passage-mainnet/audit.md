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
13. **Script de reprise `scripts/operations/verify-model-delivery.ts`** (runbook `docs/BACKUP-RECOVERY.md`) : trouvé par la revue adversariale. Il se connecte en HTTP avec l'adresse dérivée de `ROBINHOOD_DEPLOYER_KEY` et appelle `GET /api/train` puis `POST /api/train/[id]/key`. Avec la garde, il échoue sur « Requête refusée » (403) si cette adresse n'est pas dans `SIRIUS_ADMIN_ADDRESSES` de l'instance interrogée. Choix : ne pas modifier le script (hors périmètre, couvert par ses propres tests) ; documenter la dépendance dans `.env.example`, `10-self-training.md` et `BACKUP-RECOVERY.md`. L'ancienne instance historique visée par le runbook ne porte pas ce code tant qu'elle n'est pas redéployée.
14. **`phalaDemoInstance` ne réutilise pas `demoEnabled`** (`src/lib/phala-demo/runner-session.ts`), qui lève des 503 explicites sur une configuration incomplète : ici une configuration incomplète ferme simplement l'exception, sans message qui révélerait l'instance. Les conditions sont les mêmes ; un test les fixe.
15. **Pas de traduction nouvelle** : « Bientôt disponible » existait dans `english.ts`. Le cahier des charges demandait une traduction dans `errors-en.ts` pour toute chaîne nouvelle ; la chaîne n'étant pas nouvelle, le doublon a été retiré.

### 3. Ce que l'audit doit vérifier

**Contrôle d'accès côté serveur, route par route**

- `src/app/api/train/route.ts` `GET` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `prisma`. Rien entre les deux.
- `src/app/api/train/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `readJson` → `assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization))` → validation du corps → `assertAuthenticGrant` → `runSelfTrain`. Vérifier qu'un `demoSessionRevision` dans le grant n'ouvre rien d'autre que cette garde : le grant est ensuite authentifié (`assertAuthenticGrant` : sujet = wallet connecté, signatures) et le runner contrôle la session de démo. Un grant forgé est refusé par `assertAuthenticGrant` avant tout appel runner, comme avant la slice.
- `src/app/api/train/[id]/key/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session)` → rate limiter → … Aucune exception démo.
- `src/app/api/admin/me/route.ts` : `requireAuth` → `adminAllowed(session.address)`. Vérifier que la réponse n'est pas mise en cache (`no-store`) et qu'elle ne révèle pas la liste.
- `src/lib/sirius/self-training-access.ts` : `adminAllowed(session.address)` d'abord ; l'exemption ne s'applique que si `demoAccess && phalaDemoInstance()`. `phalaDemoInstance` lit `process.env` à chaque appel (pas de cache) et exige exactement `"true"` et `"testnet"`.
- Aucun autre fichier de `src/` n'importe le module `self-train` (import statique, réexport, `import()` ou `require`, alias ou chemin relatif), n'appelle `selfTrainModelKeyInRunner` ni `runSelfTrainingInRunner` (hors `src/lib/tee/` et `self-train.ts`), ni n'appelle `assertSelfTrainingAccess` hors des routes : vérifié par le test d'inspection sur l'arbre syntaxique, à revérifier à la main avec `grep -rn "sirius/self-train" src`, `grep -rn selfTrainModelKeyInRunner src` et `grep -rn runSelfTrainingInRunner src`.
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
14. **Script de reprise** `pnpm ops:verify-model-delivery` contre une instance portant ce code, avec un fichier d'environnement dont `ROBINHOOD_DEPLOYER_KEY` dérive une adresse hors `SIRIUS_ADMIN_ADDRESSES` → « Requête refusée », `httpStatus: 403` dans le rapport ; hors démo l'arrêt survient dès `GET /api/train` (phase « historique-proprietaire »), sur l'instance de démo Phala la liste passe et l'arrêt survient sur `POST /api/train/[id]/key` (phase « livraison-cle »). Avec l'adresse ajoutée à la variable → parcours complet comme avant.
15. **Instance de démo mal configurée** (prévisualisation avec `SIRIUS_PHALA_DEMO=true` et `TEE_MODE=stub`) → l'instance refuse de démarrer (`runnerEndpoint`, appelé au démarrage par `assertApplicationRunnerConfiguration` : dès que la démo est active, `RUNNER_URL` est obligatoire et `TEE_MODE=phala` sans simulateur exigé) ; si elle démarrait, `phalaDemoInstance` renverrait faux et B recevrait 403 partout.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

`src/lib/auth/admin.test.ts` (8 tests) : liste valide, casse (variable et adresse, préfixe `0X` compris), espaces et doublons, liste vide/absente, douze formes invalides (chacune refuse toute la liste, un avertissement par valeur, sans la valeur dans le message), plafond de dix, adresses comparées invalides, lecture par défaut de `process.env`.

`src/lib/auth/self-training-routes.test.ts` (14 tests) :
- inspection de l'arbre syntaxique TypeScript (un commentaire ou une chaîne ne satisfait pas le contrôle) : la liste des routes sous `src/app/api/train` est exactement les deux attendues ; chaque handler exporté, qu'il soit déclaré `export async function`, `export function` ou `export const X = …` (une réexportation fait échouer le test), appelle la garde après `requireAuth`, sans expression `await` entre les deux, et avant tout appel à `prisma.*`, `readJson`, `assertAuthenticGrant`, `runSelfTrain`, `selfTrainModelKeyInRunner`, `enforceRateLimit`, `assertCurrentRunner`, `assertOwner` et toute lecture de `params` ; `GET`/`POST` passent `true` puis `isDemoTrainingGrant(authorization)` entre le corps et le grant, la route de clé passe `session` seul ; aucun autre fichier de `src/` n'importe le module `self-train` (statique, réexport, `import()`, `require`, alias ou relatif), n'utilise `selfTrainModelKeyInRunner` ou `runSelfTrainingInRunner` hors `src/lib/tee/` et `self-train.ts`, ni n'appelle `assertSelfTrainingAccess` hors des routes (importer le message `SELF_TRAINING_UNAVAILABLE` ailleurs reste permis, pour une future page « bientôt ») ; `src/runner/handler` (chemin runner en processus) n'est importé que par `src/lib/tee/runner-client.ts` ; la résolution des spécificateurs (alias `@/`, relatif, frère `./self-train`, extension) est elle-même testée sur une source synthétique ; les fichiers `route.(ts|tsx|js|mjs|cjs)` sont tous énumérés ; les handlers exportés par chaque module transpilé sont exactement ceux que l'inspection a vus ; `/api/admin/me` sans base ni corps ; message traduit et sans mot révélateur ; `phalaDemoInstance` et `isDemoTrainingGrant` sur leurs cas limites ;
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
- `session.address` est une adresse normalisée en minuscules par `readSession` ; la garde tolère de toute façon toute casse.
- Le grant de démo porte bien `payload.demoSessionRevision` (lu dans `src/lib/runner/authorization-contract.ts` et `training-client.ts` : `...await demoScope()` ajoute `demoSessionRevision` aux paramètres du grant) ; vérifié par lecture, pas par exécution du parcours.
- Les deux adresses de l'équipe seront renseignées dans Vercel (staging et production) avant la fusion : sans elles, personne n'accède au self training, ce qui est le comportement voulu par défaut.
- Les tests Postgres (`pnpm test:postgres`) et billing n'ont pas été lancés ici (pas de base ni de compilation Hardhat dans l'environnement) ; ils n'importent pas les routes modifiées.

### 7. Risques résiduels et limites connues

- **Sur staging, le self training reste techniquement accessible aux non-admins par un `POST` direct portant un grant de démo** (voir 2.1). Risque borné au testnet, à la session de démo ouverte, aux quotas de la démo ; identique à l'état antérieur.
- Une faute de frappe dans `SIRIUS_ADMIN_ADDRESSES` ferme l'accès à toute l'équipe (volontaire) ; le seul signal est un avertissement dans les journaux du serveur et `GET /api/admin/me` à `false`.
- Pas d'horodatage ni de journal des accès admin (prévu en V1.2 par [15](15-dashboard-admin.md)).
- Le masquage côté interface relève d'une autre slice ; tant qu'elle n'est pas fusionnée, un non-admin voit l'encart de self training et reçoit « Bientôt disponible » / « Coming soon » en cliquant.
- Le script de reprise `ops:verify-model-delivery` exige désormais une adresse admin sur l'instance interrogée ; un opérateur qui l'ignore voit « Requête refusée » sans indication de cause dans la sortie (le rapport note `httpStatus: 403`).
- L'exception démo repose sur quatre variables d'environnement ; une instance testnet qui activerait la démo par erreur ouvrirait la liste des jobs et le `POST` avec grant de démo aux visiteurs (mais le runner refuserait sans session de démo ouverte et budget sponsorisé).

### 8. Reste à faire

1. (P1, avant fusion) Renseigner `SIRIUS_ADMIN_ADDRESSES` dans Vercel pour staging et production, avec les deux adresses de l'équipe, en minuscules, séparées par une virgule, sans virgule finale.
2. (P1) Slice de masquage : utiliser `GET /api/admin/me` (401 et `{ admin:false }` = masquer) et tolérer 403 sur `GET /api/train`.
3. (P2) Décider si staging doit fermer le self training hors démo : retirer les `demoAccess=true` ou séparer la démo sur sa propre route.
4. (P2) Journaliser les accès admin (qui, quoi, quand) quand le dashboard admin arrivera ([15](15-dashboard-admin.md)).
5. (P3) Un e2e qui atteint la vraie route `/api/train` avec le wallet de test, pour exercer la déclaration de `playwright.config.ts`.
6. (P3) Faire dire explicitement à `verify-model-delivery.ts` qu'un 403 vient de `SIRIUS_ADMIN_ADDRESSES`, au lieu d'un « Requête refusée » générique.

### 9. Résultats des vérifications

_À compléter en fin de session._

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

**Passe 3** : voir ci-dessous.

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

