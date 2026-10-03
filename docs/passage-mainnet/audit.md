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

