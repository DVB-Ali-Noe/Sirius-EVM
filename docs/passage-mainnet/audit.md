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

