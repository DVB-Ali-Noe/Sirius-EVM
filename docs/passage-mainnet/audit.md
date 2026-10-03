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
- `src/lib/i18n/errors-en.ts` : `"Bientôt disponible": "Coming soon"`.
- `package.json` : `admin.test.ts` et `self-training-routes.test.ts` ajoutés au script `test`.
- `playwright.config.ts` : `SIRIUS_ADMIN_ADDRESSES` = adresse du wallet e2e (dérivée de la clé `0x11…11` de `e2e/helpers/wallet.ts`), dans `webServer.env` uniquement.
- `.env.example` : bloc `SIRIUS_ADMIN_ADDRESSES`.
- `docs/passage-mainnet/10-self-training.md` : section « Contrôle côté serveur (N5) ».
- `docs/passage-mainnet/audit.md` : cette section.

**Routes concernées et comportement pour un wallet authentifié hors équipe**

| Route | Hors démo (production, mainnet) | Instance de démo Phala (testnet) |
|---|---|---|
| `GET /api/train` | 403 `{ "error": "Bientôt disponible" }`, aucune lecture en base | 200, liste de ses propres jobs (inchangé) |
| `POST /api/train` | 403, **corps non lu** (un corps mal formé donne 403, pas 400/415) | corps lu ; 403 sauf si `authorization.payload.demoSessionRevision` est un entier sûr ; alors flux inchangé (grant authentifié, runner vérifie la session de démo) |
| `POST /api/train/[id]/key` | 403, corps non lu, rate limiter non touché | 403, idem (la démo livre ses clés par `/api/phala-demo/results/[id]`) |
| `GET /api/admin/me` | `{ "admin": false }` | `{ "admin": false }` |

Non authentifié : 401 « Authentification requise » par `requireAuth`, comme avant, sur toutes ces routes.

### 2. Décisions et écarts par rapport au cahier des charges

1. **Exception pour la démo Phala (écart le plus important, à relire en priorité).** Le cahier des charges demande 403 pour tout wallet non admin. Or la démo publique « Test Phala » ([12](12-test-phala.md) : « On la garde ») est elle-même un self training sur ses propres données et passe par `GET /api/train` (liste des jobs dans `src/components/phala-demo/PhalaDemo.tsx`) et `POST /api/train` (`src/lib/phala-demo/training-client.ts`). Une garde sans exception aurait fermé la démo à tous les visiteurs, et aucun test e2e ne l'aurait vu (ils simulent toute l'API). L'exception est volontairement étroite : (a) l'instance doit déclarer `SIRIUS_PHALA_DEMO=true` **et** `EVM_NETWORK=testnet`, ce qui est impossible en production mainnet (`requiresPhalaRunner` dans `src/lib/runner/config.ts` refuse déjà la démo hors testnet au démarrage, et `phalaDemoInstance` l'exige une seconde fois) ; (b) seules la liste des jobs et un `POST` porté par un grant de démo (`payload.demoSessionRevision` entier sûr) sont ouverts ; (c) la livraison de clé reste réservée à l'équipe partout. Conséquence à connaître : **sur staging, qui est l'instance de démo (`SIRIUS_PHALA_DEMO=true` d'après `docs/PHALA-DEMO-IMPLEMENTATION.md`), un wallet non admin peut toujours lancer un entraînement sur ses propres données en forgeant un grant avec `demoSessionRevision`**, exactement comme la démo le fait aujourd'hui ; le runner le refuse si la session de démo est fermée (`checkDemoOperation`, `withDemoAdmission` dans `src/lib/phala-demo/runner-session.ts`). Si l'équipe préfère fermer complètement le self training sur staging, il suffit de retirer `SIRIUS_PHALA_DEMO` de staging ou de supprimer les deux `demoAccess=true` ; la démo cesse alors de fonctionner.
2. **`GET /api/train` est gardé** bien que le cahier des charges cite surtout les routes d'action : la liste des jobs révèle l'existence de la fonction et des données d'entraînement. La page `/train` tolère déjà un `GET` en échec (`jobsRes.ok ? … : []` dans `src/app/(app)/train/page.tsx`, non modifié) : aucun message d'erreur visible pour un non-admin.
3. **Liste fermée par défaut** : une seule entrée invalide refuse toute la liste, comme `operatorAllowed`. Alternative écartée : ignorer l'entrée invalide et garder les autres, parce qu'une liste partiellement lue est plus difficile à auditer qu'un refus franc et visible dans les journaux.
4. **Plafond de dix adresses**, repris d'`operatorAllowed`. Au-delà, la liste est refusée.
5. **Casse** : toute casse acceptée dans la variable et dans la session, comparaison en minuscules, conformément à la règle du projet dans `src/lib/evm/address.ts`. La somme de contrôle EIP-55 n'est pas vérifiée (comme partout ailleurs dans le projet) : une adresse en casse mixte avec une somme fausse est acceptée si ses 40 hexadécimaux sont les bons.
6. **Message** : « Bientôt disponible » (anglais « Coming soon »), sans le mot « self training », « admin » ni « réservé ». Même message pour toutes les routes et pour une liste vide ou mal formée.
7. **Premier refus avant la lecture du corps** sur `POST /api/train` et `POST /api/train/[id]/key` : un non-admin hors démo ne reçoit jamais les messages 400/415 qui décriraient le format attendu. Sur l'instance de démo, le corps doit être lu pour reconnaître un grant de démo : un non-admin y voit donc les 400/415 habituels (comportement d'aujourd'hui).
8. **Pas de journalisation des refus** (qui, quand). Le cahier [15](15-dashboard-admin.md) demande la journalisation des actions d'admin pour V1.2, pas des refus ; non fait ici pour éviter un journal inondé par des appels directs.
9. **`/api/admin/me` répond 401 sans session**, pas `{ admin: false }` : conforme à « protégée par requireAuth ». L'interface devra traiter 401 comme « pas admin ».
10. **Emplacement** : `adminAllowed` dans `src/lib/auth/` (demandé) ; la garde spécifique au self training dans `src/lib/sirius/`, à côté de `self-train.ts`, pour que l'inspection de source puisse exiger qu'elle ne serve qu'aux routes de self training.
11. **`runSelfTrain` (la fonction de `src/lib/sirius/self-train.ts`) n'est pas gardée elle-même**, seulement ses routes. `scripts/test/postgres-worker.ts` l'appelle directement pour les tests d'intégration Postgres ; une garde dans la fonction aurait exigé la variable dans cet environnement. Le test par inspection vérifie qu'aucun autre fichier de `src/` n'importe ce module.
12. **Wallet e2e admin** via `playwright.config.ts` (`webServer.env`), pas via un fichier `.env` : la valeur ne concerne que le serveur de test local. Les e2e actuels simulent toute l'API (`page.route("**/api/**")` dans `e2e/helpers/wallet.ts`) et n'atteignent pas les routes réelles ; la déclaration sert si un e2e futur les atteint.

### 3. Ce que l'audit doit vérifier

**Contrôle d'accès côté serveur, route par route**

- `src/app/api/train/route.ts` `GET` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `prisma`. Rien entre les deux.
- `src/app/api/train/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session, true)` → `readJson` → `assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization))` → validation du corps → `assertAuthenticGrant` → `runSelfTrain`. Vérifier qu'un `demoSessionRevision` dans le grant n'ouvre rien d'autre que cette garde : le grant est ensuite authentifié (`assertAuthenticGrant` : sujet = wallet connecté, signatures) et le runner contrôle la session de démo. Un grant forgé est refusé par `assertAuthenticGrant` avant tout appel runner, comme avant la slice.
- `src/app/api/train/[id]/key/route.ts` `POST` : `requireAuth` → `assertSelfTrainingAccess(session)` → rate limiter → … Aucune exception démo.
- `src/app/api/admin/me/route.ts` : `requireAuth` → `adminAllowed(session.address)`. Vérifier que la réponse n'est pas mise en cache (`no-store`) et qu'elle ne révèle pas la liste.
- `src/lib/sirius/self-training-access.ts` : `adminAllowed(session.address)` d'abord ; l'exemption ne s'applique que si `demoAccess && phalaDemoInstance()`. `phalaDemoInstance` lit `process.env` à chaque appel (pas de cache) et exige exactement `"true"` et `"testnet"`.
- Aucun autre fichier de `src/` n'importe `@/lib/sirius/self-train` ni n'appelle `selfTrainModelKeyInRunner` (hors `src/lib/tee/`) : vérifié par le test d'inspection, à revérifier à la main avec `grep -rn "sirius/self-train\"" src` et `grep -rn selfTrainModelKeyInRunner src`.
- Aucun contournement par appel direct : les trois routes sont les seuls points d'entrée HTTP vers le self training. `scripts/test/postgres-worker.ts` et `scripts/operations/verify-model-delivery.ts` passent par le code ou le runner, pas par HTTP, et ne sont pas exposés.
- Le runner (`src/runner/**`, non touché) n'a pas de notion d'admin : il n'est joignable que par Next (`RUNNER_TRANSPORT_SECRET`) et par le contrôleur. La garde ne protège donc que l'entrée HTTP de Next ; c'est le périmètre demandé.

**Variable `SIRIUS_ADMIN_ADDRESSES`**

- Vide, absente, espaces seuls → `[]` → personne.
- `a,b` valides → les deux ; casse indifférente ; doublons fusionnés ; espaces autour des virgules tolérés.
- Une entrée invalide, l'adresse nulle, `a,` (virgule finale), `,a`, `a,,b`, séparateur `;` ou espace, plus de dix entrées → `[]` → personne, avertissement console `[admin] SIRIUS_ADMIN_ADDRESSES mal formée : aucune adresse n'est administratrice` une fois par valeur.
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
3. **B**, `POST /api/train` avec `Content-Type: text/plain` et corps `x`, en-tête `Origin` de staging → hors démo : 403 « Bientôt disponible » (pas 415) ; démo : 415 « Content-Type application/json requis ».
4. **B**, `POST /api/train` JSON `{"datasetId":"x","jobId":"y","datasetReceipt":"z","authorization":{"payload":{"subject":"<B>"}}}` → 403 « Bientôt disponible » partout.
5. **B** sur la démo, même corps avec `"authorization":{"payload":{"subject":"<B>","demoSessionRevision":1}}` → passe la garde, puis 403 « Le grant runner ne correspond pas au wallet connecté » ou erreur de signature : aucun appel runner (vérifier le rapport de budget du runner : aucune opération, aucun échec compté).
6. **B**, `POST /api/train/<id>/key` avec n'importe quel corps → 403 « Bientôt disponible » partout, y compris sur la démo ; vérifier que le rate limiter n'a pas compté (20 appels de suite restent en 403, jamais 429).
7. **B**, `GET /api/admin/me` → 200 `{"admin":false}`, en-tête `cache-control: no-store`.
8. **A**, `GET /api/admin/me` → `{"admin":true}`. `GET /api/train` → 200 avec ses jobs. `POST /api/train` avec un corps incomplet → 400 « Requête d’entraînement incomplète » (preuve que la garde est passée).
9. **A écrit en casse mixte** dans la variable (forme EIP-55), session en minuscules → toujours admin.
10. **Variable mal formée** sur un déploiement de prévisualisation (`<A>,` avec virgule finale, ou `<A>;<B>`) → A reçoit 403 ; journaux du serveur : une ligne `[admin] SIRIUS_ADMIN_ADDRESSES mal formée`. Puis variable vide → A reçoit 403, pas d'avertissement.
11. **Démo Phala ouverte**, wallet B, parcours complet sur `/phala` (exemple, entraîner, télécharger) → fonctionne comme avant la slice.
12. **Démo Phala fermée**, wallet B, `POST /api/train` avec grant de démo signé par le parcours → refus du runner « Démonstration Phala fermée » (comportement d'avant la slice, inchangé).
13. **Page `/train`**, wallet B → aucune erreur visible liée à `GET /api/train` (la page traite le 403 comme une liste vide) ; l'encart de self training est masqué par l'autre slice.

### 5. Tests ajoutés et ce qu'ils ne couvrent pas

`src/lib/auth/admin.test.ts` (8 tests) : liste valide, casse (variable et adresse), espaces et doublons, liste vide/absente, douze formes invalides (chacune refuse toute la liste, un avertissement par valeur, sans la valeur dans le message), plafond de dix, adresses comparées invalides, lecture par défaut de `process.env`.

`src/lib/auth/self-training-routes.test.ts` (12 tests) :
- inspection : la liste des routes sous `src/app/api/train` est exactement les deux attendues ; chaque handler exporté appelle la garde après `requireAuth`, sans `await` entre les deux, et avant `prisma.`, `readJson`, `assertAuthenticGrant(`, `runSelfTrain(`, `selfTrainModelKeyInRunner(`, `enforceRateLimit(`, `await params`, `assertCurrentRunner(`, `assertOwner(` ; `GET`/`POST` passent `true` puis `isDemoTrainingGrant(authorization)`, la route de clé passe `session` seul ; aucun autre fichier de `src/` n'importe `self-train` ni n'appelle `selfTrainModelKeyInRunner` ; la garde n'est importée que par ces routes ; `/api/admin/me` sans base ni corps ; message traduit et sans mot révélateur ; `phalaDemoInstance` et `isDemoTrainingGrant` sur leurs cas limites ;
- bac à sable VM (routes réelles transpilées, dépendances coûteuses remplacées par des enregistreurs, garde et liste réelles) : non admin hors démo refusé sur chaque route avec `[]` appels ; admin accepté avec l'ordre `assertAuthenticGrant` puis `runSelfTrain` ; liste vide ou mal formée refuse même l'adresse attendue ; instance de démo : `GET` ouvert, `POST` ouvert seulement avec `demoSessionRevision` entier, clé fermée ; aucune exemption hors testnet ou avec un drapeau approximatif.

**Angles morts**

- Aucun test n'exécute les vraies routes Next avec une vraie session, un vrai `readSession` ni la vraie base : le bac à sable remplace `requireAuth`. La chaîne cookie → session → adresse n'est pas re-testée ici (couverte ailleurs).
- Les e2e Playwright n'atteignent pas les routes réelles ; la déclaration du wallet e2e dans `playwright.config.ts` n'est donc exercée par aucun test aujourd'hui.
- Le runner n'est pas exécuté : la vérification de `demoSessionRevision` contre la session ouverte reste couverte par `src/lib/phala-demo/runner-session.test.ts`, inchangé.
- La page `/train` et `PhalaDemo.tsx` ne sont pas testées face à un 403 (interface hors périmètre).
- Les tests par inspection reposent sur des chaînes littérales (`assertSelfTrainingAccess(`, `readJson`) : une réécriture qui renomme la garde ou lit le corps autrement doit mettre ces tests à jour.

### 6. Hypothèses

- Staging déclare `SIRIUS_PHALA_DEMO=true` et `EVM_NETWORK=testnet` (d'après `docs/PHALA-DEMO-IMPLEMENTATION.md` et `PHALA-DEMO-RESTE-A-FAIRE.md`) ; non vérifié dans Vercel depuis cette session.
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
- L'exception démo repose sur deux variables d'environnement ; une instance testnet qui activerait la démo par erreur ouvrirait la liste des jobs et le `POST` avec grant de démo aux visiteurs (mais le runner refuserait sans session de démo ouverte et budget sponsorisé).

### 8. Reste à faire

1. (P1, avant fusion) Renseigner `SIRIUS_ADMIN_ADDRESSES` dans Vercel pour staging et production, avec les deux adresses de l'équipe, en minuscules, séparées par une virgule, sans virgule finale.
2. (P1) Slice de masquage : utiliser `GET /api/admin/me` (401 et `{ admin:false }` = masquer) et tolérer 403 sur `GET /api/train`.
3. (P2) Décider si staging doit fermer le self training hors démo : retirer les `demoAccess=true` ou séparer la démo sur sa propre route.
4. (P2) Journaliser les accès admin (qui, quoi, quand) quand le dashboard admin arrivera ([15](15-dashboard-admin.md)).
5. (P3) Un e2e qui atteint la vraie route `/api/train` avec le wallet de test, pour exercer la déclaration de `playwright.config.ts`.

### 9. Résultats des vérifications

_À compléter en fin de session._

### 10. Revue interne de la session

_À compléter en fin de session._

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

