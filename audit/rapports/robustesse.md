# Audit de robustesse du runner — fichiers et requêtes hostiles

- **Base auditée : `origin/staging` = `f31a917bf48a51d8d8505b8a50cde9ed0a353853`** (« Merge pull request #124 », 20 oct. 2026 16:27 +0200).
- Branche de travail : `audit/robustesse` (créée depuis ce SHA). Aucun code de production modifié : tout est sous `audit/`.
- Date : 23 octobre 2026. Machine : Intel Core Ultra 7 155H (22 threads, 31 Gio), Windows 11, Node v22.16.0, dépendances `npx -y pnpm@11.18.0 install`.
- Données : uniquement `public/examples/classification/credit-risk*.csv` (public) et des fichiers synthétiques à graine fixe. Aucun réseau réel, aucun wallet existant (un wallet est généré à la volée pour le test de rafale), aucune session CVM.
- OpenML 42477 et 46929 n'ont pas été utilisés : ils ne sont pas dans le dépôt et les télécharger n'était pas nécessaire aux constats (NON VÉRIFIÉ sur ces jeux).

## En bref

1. **Aucun crash.** 20 000 entrées aléatoires contre `parseCsv`, 600 fichiers hostiles × 2 modèles, et 32 mutations × 3 modèles de bout en bout (chiffrement navigateur → `sealDatasetEnvelope`) : chaque refus est un 400 (`CsvValidationError` / `DatasetValidationError`), jamais un 500 ni un 503 ; aucun fichier accepté n'échoue ensuite à l'entraînement sur ces jeux.
2. **Mais plusieurs fichiers ambigus sont acceptés et donnent un modèle silencieusement faux** : cellules faites d'espaces lues comme 0 (ROB-01), `\r` isolé qui fusionne deux lignes (ROB-03), lignes plus longues ou plus courtes que l'en-tête qui décalent ou changent la cible (ROB-04). Le critère « tout fichier invalide donne un 400 propre » **n'est pas atteint**.
3. **Les opérations gratuites ne sont pas sans calcul** : chaque appel fait de la cryptographie EC et des écritures SQLite synchronisées, sans limite de débit dans le runner (ROB-08). Le critère « aucune opération gratuite ne déclenche de calcul » **n'est pas atteint**, même si les limites côté Next bornent l'exposition.
4. **503 du 20 octobre : hypothèse reproduite en local.** Une connexion keep-alive réutilisée au moment où le runner la ferme donne `ECONNRESET`, que Next transforme exactement en « Runner confidentiel indisponible » (19 échecs sur 27 essais entre 5,8 et 6,05 s d'inactivité, 0 sur 66 en dehors). Non prouvé sur la CVM.

| Sévérité | Nombre | Constats |
|---|---|---|
| Critique | 0 | — |
| Haute | 3 | ROB-01, ROB-03, ROB-04 |
| Moyenne | 8 | ROB-02, ROB-05, ROB-06, ROB-07, ROB-08, ROB-09, ROB-10, ROB-11 |
| Basse | 2 | ROB-12, ROB-13 |

## Constats

### ROB-01 | Haute | `src/lib/tee/train.ts:29-32` (`isNum`), `src/lib/datasets/csv-check.ts:79-82` (`isNumericCell`)

**Ce qui se passe.** `Number(" ")`, `Number("\t")` et `Number("  ")` valent `0`. Une cellule faite seulement d'espaces (valeur manquante courante dans un export Excel) passe donc le test « numérique » et entre dans le modèle comme un vrai 0. Une cellule vraiment vide (`""`) fait au contraire écarter toute la colonne. Même donnée manquante, deux traitements opposés, sans aucun message. L'évaluation côté acheteur refuse pourtant ces mêmes cellules (`src/lib/train/evaluation-client.ts:46`, `value.trim() === ""`).

Mesure sur `credit-risk.csv` (13 000 lignes), 10 % des `income_k_eur` remplacés par `" "` : fichier accepté (HTTP 200 au scellement), logistique F1 0,0658 → 0,0579, arbres AUC held-out 0,7169 → 0,7121, linéaire R² 0,0527 → 0,0506 ; `income_k_eur` reste une variable. Avec `""` à la place, la colonne disparaît (5 variables).

**Reproduire.**
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-01
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/hostile-matrix.test.ts   # ligne « spaces-only »
```

**Correction proposée.** Remplacer `isNum` et `isNumericCell` par une seule fonction stricte, partagée par l'enclave et le navigateur : écriture décimale uniquement, sans espaces (`/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/`, puis `Number.isFinite` et `|x| <= 1e12`). Proposition testée : `audit/robustesse/strict-csv.ts` (`isStrictNumericCell`). Avec elle, `" "` est traité comme `""` (colonne écartée et signalée par le rapport de qualité). Changer la règle change le profil : nouvelle `modelVersion` à prévoir.

### ROB-02 | Moyenne | `src/lib/tee/train.ts:29-32`, `src/lib/datasets/csv-check.ts:79-82`

**Ce qui se passe.** `Number()` accepte aussi l'hexadécimal (`0x1A` = 26, `0X1a`), le binaire (`0b101` = 5), l'octal (`0o17` = 15), l'espace insécable (`" 7"` = 7) et un BOM (`"﻿5"` = 5). Une colonne d'identifiants `0x3fa2c1…` devient une variable explicative : sur `credit-risk.csv` avec une colonne `client_ref` hexadécimale en tête, le modèle livré a 7 variables au lieu de 6 (`client_ref` inclus ; AUC arbres 0,7169 → 0,7166, linéaire R² 0,0527 → 0,0528). Quand l'hexadécimal code la même valeur (`0x2` pour 2), le modèle est identique : l'effet est seulement d'accepter une écriture qui n'est pas un nombre de tableur.

**Reproduire.**
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-02
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/strict-csv.test.ts   # « effet sur le modèle »
```

**Correction proposée.** La même fonction stricte que ROB-01. Test `strict-csv.test.ts` : avec la règle stricte, `client_ref` est écartée et le modèle retrouve exactement les 6 variables du fichier propre.

### ROB-03 | Haute | `src/lib/sirius/metrics.ts:53-55` (`parseCsv`)

**Ce qui se passe.** Hors guillemets, `\r` est traité comme un séparateur muet : il est supprimé, sans fin de ligne. Un `\r` isolé (fin de ligne Mac classique, ou fichier réparé à la main) colle donc la dernière cellule d'une ligne à la première de la suivante, et la ligne suivante disparaît dans la précédente. `parseCsv("a,b,y\n1,2,0\r3,4,1\n")` rend `[["a","b","y"],["1","2","03","4","1"]]` ; `"1\r0"` devient `"10"`.

Mesures sur `credit-risk.csv` avec un seul `\r` à la place d'un `\n` (ligne 9) :
- linéaire : accepté, `n` 13 000 → 12 999, R² 0,0527 → 0,0342 (la cible 0/1 reçoit la valeur 46) ;
- logistique et arbres : 400, mais avec un message faux (« la cible … doit contenir les classes 0 et 1 ») ;
- si une colonne texte suit la cible : logistique et arbres acceptent aussi, `n` = 12 999, AUC arbres 0,7169 → 0,7068.
- Fichier entièrement en `\r` : 400 « trop de colonnes CSV (max 64) », message trompeur.

**Reproduire.**
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-03
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/hostile-matrix.test.ts   # lignes « lone-cr », « lone-cr-note », « cr-only »
```

**Correction proposée.** Hors guillemets, n'accepter `\r` que suivi de `\n` ; sinon `CsvValidationError("retour chariot isolé")` (400). Implémenté et testé dans `audit/robustesse/strict-csv.ts` : mêmes tableaux que `parseCsv` sur les trois fichiers publics et les fichiers synthétiques, refus explicite des dix fichiers ambigus de `strict-csv.test.ts`.

### ROB-04 | Haute | `src/lib/tee/train.ts:35` (`row[column] ?? ""`), `src/lib/datasets/csv-check.ts:119`, `src/lib/sirius/metrics.ts:66-69`

**Ce qui se passe.** L'enclave ne vérifie jamais que chaque ligne a autant de cellules que l'en-tête. Les cellules en trop sont ignorées, les cellules manquantes deviennent `""`. Conséquences mesurées sur `credit-risk.csv` :
- **une** virgule décimale non citée (`62,15`) sur une ligne : la ligne est décalée d'une colonne ; linéaire accepté, R² 0,0527 → 0,0867 (+65 %) ;
- une ligne tronquée (dernière cellule absente) : la colonne cible n'est plus « numérique sur toutes les lignes », l'enclave prend la colonne précédente comme cible **sans prévenir** ; linéaire accepté avec la cible `loan_to_income_pct` au lieu de `defaulted` (R² 0,0002) ;
- virgule finale sur chaque ligne (8 cellules pour 7 colonnes) : accepté par les trois profils ;
- guillemet ouvert jamais fermé sur la dernière cellule : linéaire accepté (`"0\n"` lu 0).

Pour la logistique et les arbres, ces fichiers sont refusés **par chance** : seulement parce que la cible décalée n'est plus 0/1, avec le message « la cible … doit contenir les classes 0 et 1 ». La démo `/phala` contrôle bien la longueur des lignes (`src/lib/phala-demo/csv.ts:48`), mais dans le navigateur seulement ; l'enclave, qui fait foi, ne le fait pas. Le parseur accepte aussi un guillemet au milieu d'un champ non cité (`1"2,3"4` → `12,34`).

**Reproduire.**
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-04
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/hostile-matrix.test.ts   # « decimal-comma », « short-row », « trailing-comma », « unclosed-end »
```

**Correction proposée.** Dans `trainingColumns` (et `inspectCsvTable`) : `DatasetValidationError("ligne N : X cellules pour Y colonnes")` dès qu'une ligne n'a pas la longueur de l'en-tête. Dans le parseur : refuser un guillemet au milieu d'un champ, un caractère après un guillemet fermant et un guillemet jamais fermé (RFC 4180). Les deux sont dans `audit/robustesse/strict-csv.ts`. Le message reste visible seulement à l'ingestion (le fournisseur lit sa propre donnée), comme aujourd'hui.

### ROB-05 | Moyenne | `src/lib/sirius/metrics.ts:17` (`parseCsv`)

**Ce qui se passe.** Un BOM UTF-8 (ajouté par Excel « CSV UTF-8 ») reste collé au nom de la première colonne : `"﻿age_years"` (longueur +1). Le modèle livré porte ce nom invisible ; l'évaluation acheteur exige les mêmes noms (`src/lib/train/evaluation-client.ts:93-95`) et refuse un CSV de test sans BOM (« Le CSV de test doit contenir la cible et les mêmes features »). Sur `credit-risk.csv`, le modèle avec BOM diffère du propre seulement par ce nom.

**Reproduire.** `TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-05`

**Correction proposée.** Retirer un BOM initial avant l'analyse (`text.charCodeAt(0) === 0xfeff ? text.slice(1) : text`), dans le parseur partagé. Testé dans `strict-csv.test.ts`.

### ROB-06 | Moyenne | `src/lib/sirius/metrics.ts:58-61` (`parseCsv`), `src/lib/tee/train.ts:35`

**Ce qui se passe.** Une ligne vide produit une ligne `[""]`. Une seule ligne vide en fin de fichier (`…\n\n`, fréquent après une édition manuelle) rend donc **toutes** les colonnes non numériques : fichier légitime refusé avec « au moins 2 colonnes numériques requises » (enclave) et « Au moins deux colonnes entièrement numériques sont requises (0 détectée(s)) » (navigateur). Le refus est propre (400) mais faux.

**Reproduire.** `TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-06`

**Correction proposée.** Ignorer les lignes vides en fin de fichier ; refuser explicitement une ligne vide au milieu (`CsvValidationError("ligne vide au milieu du fichier")`). Dans `strict-csv.ts`.

### ROB-07 | Moyenne | `src/lib/tee/train.ts:11-13`, `src/lib/models/gbdt.ts:30`, `src/lib/tee/core.ts:210`, `src/lib/tee/bounded-training.ts:20-41`

**Ce qui se passe.** L'ingestion accepte un fichier si son « budget d'opérations » tient (`MAX_TRAINING_OPERATIONS` = 200 M, `GBDT_MAX_OPERATIONS` = 300 M), mais ce budget ne borne pas le temps réel. Le délai, lui, est fixe : 15 s (`RUNNER_TRAINING_TIMEOUT_MS`), démarrage du worker compris côté `trainInWorker` (≈ 1 s mesurée). Des fichiers acceptés à l'ingestion peuvent donc dépasser le délai à l'entraînement : le self-train rend une 422 « Calcul trop long ou trop lourd » après consommation du quota ; un emprunt v7 rend une 422 après retenue des frais consommés (`handler.ts:327-331`) ; le délai interne (`assertWithinDeadline`) lève une `Error` simple que le worker transforme en « Dataset inexploitable » (message qui accuse la donnée). Mesures (§ « Mémoire et temps ») : sur cœurs performants, le pire fichier valide trouvé (arbres, 30 000 × 31 variables, au plafond d'opérations) prend 6,0 s dans le worker, soit 1,2 à 1,4 fois le fichier mesuré avec succès sur la CVM le 20 octobre (4,4–5,0 s ici). Mais sur la même machine chargée (autres processus, cœurs efficaces), ce fichier, la logistique 50 000 × 20 et le fichier CVM lui-même (14,5 s d'entraînement seul) ont dépassé les 15 s (`TrainingLimitExceeded`). La marge dépend donc entièrement du processeur ; elle n'est pas mesurée sur la CVM (NON VÉRIFIÉ). Classé Moyenne : aucun fichier n'a dépassé le délai sur un processeur non chargé.

**Reproduire.**
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server --expose-gc" node --import tsx audit/robustesse/memory-bench.ts
```

**Correction proposée.** (1) Calibrer le budget d'opérations sur la CVM (procédure ci-dessous) avec une marge pour le démarrage du worker, et le vérifier à l'ingestion avec la même marge ; (2) lever `TrainingLimitExceeded` (et non une `Error` simple) quand le délai interne expire, pour que le message soit « Calcul trop long » et non « Dataset inexploitable » ; (3) ne démarrer le délai qu'après le chargement du worker (message « prêt » du worker), comme c'est déjà fait pour le téléchargement IPFS.

### ROB-08 | Moyenne | `src/runner/handler.ts:176-189`, `src/lib/tee/ingress.ts:18-25`, `src/lib/runner/replay.ts:117-152`, `src/runner/server.ts:39,141-147`

**Ce qui se passe.** Le commentaire de la PR #123 dit « aucun calcul ni stockage ». C'est faux :
- `dataset-ingress-key` : dérivation HKDF de la master key, réduction modulo et multiplication scalaire P-256 **à chaque appel** (rien n'est mis en cache), plus la consommation de la capability dans l'anti-rejeu persistant (une écriture SQLite en `synchronous = FULL` + fsync du dossier) ;
- `self-train-key` : vérification HMAC du reçu, récupération ECDSA secp256k1 de la délégation, vérification ECDSA P-256 du grant, **deux** écritures SQLite (capability + grant), dérivation de clé et chiffrement ECDH de la livraison.

Mesures :
- Windows (anti-rejeu en mémoire, sans registre) : `dataset-ingress-key` 0,5 à 1,3 ms CPU par appel selon la charge (200 appels, tous 200) ; `self-train-key` 5,3 à 7,4 ms CPU par appel (100 appels, tous 200).
- Linux (conteneur `node:22.16.0-bookworm-slim` sous WSL2, registres SQLite réels) : `dataset-ingress-key` **1,0 écriture SQLite par appel**, 3,5 ms CPU, **40,7 ms de temps mur par appel** ; `self-train-key` **2,0 écritures par appel**, 9,1 ms CPU, **97,9 ms par appel** ; budget alloué +0 µUSD dans les deux cas. `node:sqlite` est synchrone : pendant ce temps (surtout les fsync), la boucle d'événements du runner est bloquée pour toutes les autres requêtes, payantes comprises. Coût du fsync sur le disque de la CVM non mesuré (NON VÉRIFIÉ). Le runner n'a **aucune limite de débit** : seule la limite de concurrence (`RUNNER_MAX_CONCURRENT_REQUESTS` = 8) répond, en 503 « Runner saturé », et elle est partagée avec les opérations payantes : 64 appels simultanés gratuits → 8 × 200 et 56 × 503.

Exposition réelle bornée en amont (lu dans le code, NON VÉRIFIÉ en production) : la capability n'est émise que par Next ; `dataset-ingress-key` n'est appelé que par `POST /api/datasets` (authentification, KYB, quotas en base : 5 brouillons ouverts, 10 dépôts/heure/fournisseur, 200/heure au total — `src/lib/sirius/pipeline.ts:13-17`) ; `self-train-key` par `POST /api/train/[id]/key` (équipe seulement, 20/min par wallet et 200/min au total, **en mémoire par instance Next**, donc multiplié par le nombre d'instances Vercel).

**Reproduire.** `TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/free-ops-burst.test.ts` (sous Linux pour les écritures disque : `audit/robustesse/run-linux.sh`).

**Correction proposée.** (1) Corriger le commentaire ; (2) mettre en cache la clé publique d'ingestion au démarrage (elle ne change pas) ; (3) ajouter dans le runner une limite de débit propre aux opérations gratuites (seau à jetons, par exemple 5/s), qui ne consomme pas la concurrence des opérations payantes ; (4) éventuellement réserver un créneau de concurrence aux jobs payants.

### ROB-09 | Moyenne | `src/lib/runner/budget.ts:85-107`, `src/lib/runner/budget-ledger.ts:409-410`, `src/lib/runner/budget-ledger.ts:92` (`validateBudgetPolicy`)

**Ce qui se passe.** Quand `policy.maxActive` réservations sont déjà ouvertes, `reserve()` lève une `AppError` 503 « Réservations runner en attente de réconciliation ». Pour un job imbriqué (scellement, entraînement), cette erreur traverse l'enveloppe « request » qui la **compte comme panne** (`countsAsRunnerFailure` : toute AppError ≥ 500). Trois comptages ferment le runner à tous (coupe-circuit). Rien ne vérifie que `maxActive` couvre `RUNNER_MAX_CONCURRENT_REQUESTS` (8, jusqu'à 32) plus les sous-opérations : `validateBudgetPolicy` accepte 1 à 1 000. La documentation le demande (`docs/RUNNER-BUDGETS.md:52`) ; la valeur installée sur staging et prod n'est pas lisible ici (NON VÉRIFIÉ). Test Linux : avec `maxActive` = 8 et 7 requêtes en vol, un scellement légitime reçoit « Réservations runner en attente de réconciliation » et `failures` passe de 0 à **1 sur 3**.

**Reproduire.** Sous Linux : `TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/ledger-saturation.test.ts` (ou `audit/robustesse/run-linux.sh`).

**Correction proposée.** Lever `RunnerRetryLater` (non compté, réservation rendue) pour un refus de capacité ; refuser au démarrage une politique dont `maxActive` < 2 × `RUNNER_MAX_CONCURRENT_REQUESTS`.

### ROB-10 | Moyenne | `src/lib/tee/ra-tls-client.ts:170-184` (agent keep-alive), `src/runner/server.ts:221-225`, `src/lib/tee/runner-client.ts:58-63`

**Ce qui se passe.** Next garde des connexions keep-alive vers le runner (`Agent({ keepAlive: true, maxSockets: 8 })`) sans délai d'inactivité côté client ; le runner ferme une connexion inactive (`keepAliveTimeout` = 5 s). Si Next envoie une requête sur une connexion au moment où le runner la ferme, la requête échoue en `ECONNRESET`. Node ne rejoue pas un POST, `attestedRunnerFetch` détruit l'agent et relance l'erreur, et `callRunner` la transforme en `AppError("Runner confidentiel indisponible", 503)`. L'essai suivant ré-atteste et réussit. C'est exactement le symptôme du 20 octobre. Mesure locale (relais TCP à 80 ms par sens, mêmes réglages serveur) : 0 échec sur 42 essais entre 4,0 et 5,6 s d'inactivité, **19 échecs sur 27** entre 5,8 et 6,05 s (6 sur 6 à 5,9 s), 0 sur 24 entre 6,1 et 6,8 s. Détails au § 503.

**Reproduire.**
```
AUDIT_IDLES=5400,5600,5800,5900,6000,6050,6100,6200,6400,6800 AUDIT_REPS=6 NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/keepalive-503.test.ts
```

**Correction proposée.** Délai d'inactivité client plus court que celui du serveur (par exemple `Agent({ keepAlive: true, timeout: 4_000 })`, ou fermer les sockets libres après 4 s), et un seul nouvel essai quand l'erreur survient sur un socket réutilisé (`req.reusedSocket`) avant tout octet de réponse — cas où le runner n'a rien traité (la capability neuve et le grant non consommé le permettent).

### ROB-11 | Moyenne | `src/lib/tee/ra-tls-client.ts:15,145-166`, `src/lib/tee/quote.ts:136-147`, `node_modules/@phala/dcap-qvl/src/collateral.js:75,103,228,239,257`

**Ce qui se passe.** Chaque instance Next ré-atteste le runner toutes les 5 minutes, et après toute erreur de transport. La vérification matérielle télécharge les collatéraux auprès de `pccs.phala.network` par `fetch` **sans délai ni nouvel essai**. Un échec réseau transitoire est avalé (`hardwareVerified: false`) et devient « Identité matérielle … non authentifié », donc une 503 « Runner confidentiel indisponible » pour l'utilisateur. Un PCCS qui ne répond pas bloque la requête jusqu'à l'arrêt de la fonction Vercel. NON VÉRIFIÉ en conditions réelles (aucun appel au PCCS pendant l'audit).

**Reproduire.** Lecture de code (les lignes citées). Pas de test local sans quote TDX réelle.

**Correction proposée.** `AbortSignal.timeout` et un nouvel essai sur les appels collatéraux (enveloppe autour de `getCollateralAndVerify`, ou cache des collatéraux tant qu'ils sont valides), et journaliser la cause exacte côté Next (sans secret) pour distinguer attestation et réseau.

### ROB-12 | Basse | `src/lib/tee/train.ts:249-254` (`trainLogisticRegression`)

**Ce qui se passe.** Pour des valeurs très petites (|x| < environ 1e-154), le carré de l'écart à la moyenne sous-déborde à 0 ; l'échelle retombe à 1 (`|| 1`) et la variable devient invisible. Une variable **parfaitement** prédictive valant 0 ou 1e-300 donne une précision de 0,505 au lieu de 1. Valeurs pathologiques, mais accepté sans message.

**Reproduire.** `TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/numeric-edges.test.ts` (sous-test TODO ROB-12).

**Correction proposée.** Calculer l'échelle en deux passes avec mise à l'échelle par le maximum absolu de la colonne, ou refuser à l'ingestion les colonnes dont toutes les valeurs non nulles sont sous 1e-100.

### ROB-13 | Basse | `src/lib/sirius/metrics.ts:45-51`

**Ce qui se passe.** Un champ cité fait de `""` répétés construit une chaîne par concaténation à chaque guillemet échappé. Fichier de 2,8 Mo (140 lignes, cellules de 10 000 guillemets) : accepté ; +45 Mo de tas dans le processus runner pendant la validation, et le worker exige 64 Mo d'old-gen pour 140 lignes (16 Mo pour un fichier normal de 100 lignes). Reste sous les plafonds ; à surveiller si les plafonds de taille montent.

**Reproduire.** `BENCH_ONLY=bombe TEE_MODE=stub NODE_OPTIONS="--conditions=react-server --expose-gc" node --import tsx audit/robustesse/memory-bench.ts`

**Correction proposée.** Accumuler les morceaux d'une cellule citée dans un tableau et les joindre une fois (`parts.join("")`), ou aplatir la chaîne à la fin de chaque cellule.

## Tests et scripts ajoutés (tous sous `audit/robustesse/`)

| Fichier | Rôle |
|---|---|
| `csv-fuzz.test.ts` | Fuzz maison à graine fixe : 20 000 entrées contre `parseCsv` ; 600 fichiers hostiles (moitié très hostiles, moitié presque valides) × logistique et linéaire : ingestion, entraînement, cohérence navigateur / enclave. |
| `hostile-matrix.test.ts` | 32 mutations de `credit-risk.csv` (liste de la mission) × logistique, arbres, linéaire, de bout en bout : chiffrement navigateur → `sealDatasetEnvelope` (IPFS simulé) → statut HTTP, puis entraînement et comparaison au modèle propre. Les attentes idéales non tenues sont des sous-tests `todo`. |
| `strict-csv.ts`, `strict-csv.test.ts` | Proposition de parseur et de détection numérique stricts (non branchée), avec ses tests : équivalence sur fichiers valides, refus des fichiers ambigus, fuzz, effet sur le modèle, coût. |
| `numeric-edges.test.ts` | Valeurs extrêmes (±1e12, constantes, doublons, 1e-300, sous-normaux, -0) : acceptées puis entraînées, sortie admise par l'output-gate. |
| `free-ops-burst.test.ts` | Rafales `dataset-ingress-key` et `self-train-key` à travers `handleRunnerRequest` : CPU, écritures SQLite, budget, statuts. |
| `ledger-saturation.test.ts` | ROB-09 (Linux). |
| `keepalive-503.test.ts` | Hypothèses H1 (keep-alive), H1b (`maxRequestsPerSocket`), H7 (`requestTimeout`) du 503. |
| `memory-bench.ts` | Mémoire minimale du worker et temps, 10k / 30k / 50k lignes et pires cas. |
| `make-cvm-files.ts` | Écrit les fichiers de la procédure CVM, avec leur SHA-256. |
| `repro.ts` | Reproductions minimales ROB-01 à ROB-06. |
| `run-linux.sh` | Rejoue les tests qui exigent des fichiers en 0600 dans un conteneur `node:22.16.0-bookworm-slim`. |
| `datasets.ts`, `hostile.ts` | Générateurs et classement des issues (même conversion que `sealDatasetEnvelope`). |

Lancer l'ensemble (Git Bash, racine du dépôt) :
```
TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/*.test.ts
```

## Résultats chiffrés

| Mesure | Résultat |
|---|---|
| Fuzz `parseCsv` (20 000 entrées : `,` `"` `\n` `\r` `\r\n` espaces, BOM, blocs de 4 000 car., 70 virgules) | 11 733 refus `CsvValidationError`, **0 autre exception**, aucun résultat hors plafonds (64 colonnes, 10 000 car., 50 000 lignes) |
| Fuzz ingestion + entraînement (600 fichiers × logistique et linéaire, graine 20261023) | 312 acceptés, 888 refus 400, **0 crash**, **0 échec d'entraînement après acceptation**, 0 métrique non finie, 0 `n` faux, 0 désaccord navigateur / enclave |
| Matrice (32 mutations × 3 modèles, bout en bout chiffré) | tous les refus sont des 400 ; **aucun 500 ni 503** ; 0 échec d'entraînement après acceptation ; 26 attentes idéales non tenues (sous-tests `todo`) |
| Acceptés avec un modèle différent de l'idéal | espaces seuls (3 modèles), identifiants hexadécimaux (3), BOM (3), `\r` isolé (linéaire ; logistique et arbres si une colonne suit la cible), virgule décimale non citée (linéaire), ligne tronquée (linéaire, cible changée), virgule finale (3), guillemet non fermé en fin (linéaire) |
| Fichier légitime refusé à tort | ligne vide finale (3 modèles, message faux) |
| Parseur strict proposé | même tableau que `parseCsv` sur les 3 fichiers publics et 4 synthétiques ; refuse les 10 fichiers ambigus ; fuzz 20 000 entrées → seulement `CsvValidationError` ; 2,95 Mo analysés en 219 ms contre 95 ms (médianes de 5, ×2,3) |
| Valeurs extrêmes (±1e12, constantes, doublons, 1e-300, sous-normaux, -0) | toutes acceptées et entraînées, métriques finies, sortie admise par l'output-gate ; seul défaut : ROB-12 |
| Opérations gratuites (Linux) | 1 et 2 écritures SQLite par appel, 40,7 et 97,9 ms de temps mur, 0 µUSD ; aucune limite de débit ; 64 appels simultanés → 8 × 200 et 56 × 503 « Runner saturé » |
| Saturation du registre (Linux) | refus de capacité compté comme panne : `failures` 0 → 1 (sur 3) |
| Keep-alive (H1, deux séries, 93 essais) | 19 `ECONNRESET` sur 27 entre 5,8 et 6,05 s d'inactivité ; 0 sur 42 de 4,0 à 5,6 s ; 0 sur 24 de 6,1 à 6,8 s |

Suite complète sous Windows : 51 tests, 16 réussis, 0 échec, 1 ignoré (ROB-09, Linux seulement), 34 `todo` (26 attentes idéales non tenues, 8 tenues). Sous Linux (`run-linux.sh`) : 4 tests sur 4 réussis (`free-ops-burst`, `ledger-saturation`).

## Mémoire et temps (10k, 30k, 50k lignes, worker limité à 128 Mo)

Mesure locale (`audit/robustesse/memory-bench.ts`), processus fixé sur les threads 0 à 11 (cœurs performants, d'après l'énumération Windows habituelle) en priorité « au-dessus de la normale ». `Old-gen minimale` = plus petite limite (young gen 16 Mo, même worker que `trainInWorker`) qui laisse l'entraînement aboutir ; la production impose 128 Mo. `Worker` = `trainInWorker` réel, délai 15 s, démarrage du worker compris. Les fichiers « 50k » ont 49 999 lignes de données : `MAX_CSV_ROWS` = 50 000 compte l'en-tête.

| Cas | Octets | Validation (ms / tas Mo) | Entraînement seul min / médiane (ms) | Worker min / médiane (ms) | Old-gen minimale |
|---|---|---|---|---|---|
| Démarrage du worker seul (100 lignes) | 3 147 | 1 / 0 | 1 / 1 | 940 / 1 040 | 16 Mo |
| Logistique 10k × 7 (credit-risk) | 305 430 | 9 / 5 | 144 / 240 | 1 382 / 1 507 | 24 Mo |
| Logistique 30k × 7 | 916 097 | 25 / 14 | 416 / 451 | 1 717 / 1 718 | 32 Mo |
| Logistique 50k × 7 | 1 526 744 | 125 / 19 | 728 / 805 | 1 984 / 2 025 | 48 Mo |
| Arbres 10k × 7 | 305 430 | 29 / 4 | 647 / 848 | 2 659 / 2 686 | 24 Mo |
| Arbres 30k × 7 | 916 097 | 110 / 14 | 2 267 / 2 424 | 3 822 / 4 021 | 32 Mo |
| Arbres 50k × 7 | 1 526 744 | 101 / 19 | 3 439 / 3 644 | 4 769 / 5 021 | 48 Mo |
| Logistique 50k × 20, cellules de 2 car. (pire cas budget) | 2 950 009 | 163 / 44 | 1 688 / 2 277 | 3 881 / 4 367 | **96 Mo** |
| Logistique 16k × 64 (32 num. + 32 texte) | 3 056 234 | 112 / 37 | 1 029 / 1 080 | 2 614 / 2 641 | 64 Mo |
| Arbres 30k × 32 (31 variables, plafond d'opérations) | 2 850 116 | 121 / 38 | 6 390 / 6 452 | **5 977 / 6 033** | 48 Mo |
| Arbres 32k × 24, décimales | 3 011 770 | 157 / 26 | 3 443 / 3 466 | 4 737 / 5 640 | 48 Mo |
| Bombe de guillemets 140 × 10 000 car. | 2 800 706 | 156 / 45 | 77 / 238 | 1 328 / 1 433 | 64 Mo |
| Arbres 30k × 23, fichier mesuré sur la CVM le 20/10 (`gbdt-benchmark-csv.mjs`) | 2 060 908 | 112 / 30 | 3 504 / 3 590 | 4 384 / 4 983 | 48 Mo |

Lecture :
- **Mémoire** : tous les fichiers valides tiennent sous 128 Mo. Le plus gourmand est la logistique à 50k lignes × 20 colonnes de cellules courtes (96 Mo, 75 % de la limite) : le tableau de chaînes de `parseCsv` domine. Marge réelle mais faible.
- **Temps** : sur cœurs performants, tout finit en moins de 6,1 s. Les mêmes fichiers lancés pendant que la machine était chargée (premières séries, non fixées) ont dépassé 15 s : logistique 50k × 20, logistique 16k × 64, arbres 30k × 32, arbres 32k × 24, et le fichier CVM (14,5 s d'entraînement seul). Voir ROB-07.
- Le délai de 15 s inclut environ 1 s de démarrage du worker (chargement de tsx).

### Procédure pour mesurer la même chose sur la CVM staging (préparée, **non lancée**)

À faire seulement avec l'accord de Noé et Ali : une session coûte (≈ 0,03–0,06 USD par heure de CVM d'après la session du 20 octobre, plus le budget sponsorisé consommé).

Option A — parcours réel `/phala` (mesure le temps, pas la mémoire) :
1. Générer les fichiers et noter leurs empreintes : `node --import tsx audit/robustesse/make-cvm-files.ts /tmp/sirius-cvm-bench` (6 fichiers : credit-risk 10k / 30k / 49 999 lignes, pire cas logistique 49 999 × 20, pire cas arbres 30 000 × 32, bombe de guillemets).
2. Préparer deux wallets de test **neufs** (quota de 4 opérations par wallet), avec 0,0005 ETH testnet chacun pour le titre (comme le 20 octobre).
3. Ouvrir la session depuis `/operator` (Noé) ; vérifier `/phala/attestation` (« Attestation verified »).
4. Pour chaque fichier : importer sur `/phala`, profil arbres pour `credit-risk-*`, `dense-30000x32`, profil logistique pour `dense-49999x20` et `quote-bomb-140` ; entraîner. Relever dans l'onglet Réseau : statut et durée de `POST /api/datasets`, du dépôt, de `POST /api/train` jusqu'au résultat ; en cas d'échec, le message exact (« Calcul trop long ou trop lourd pour ce fichier » = délai **ou** mémoire du worker dépassés, non distingués).
5. Comparer `n` et les métriques aux valeurs locales (même fichier ⇒ mêmes métriques, modèles déterministes).
6. Fermer la session depuis `/operator`, vérifier CVM `stopped`, noter le solde.

Option B — image de mesure dédiée (temps **et** mémoire, même type de CPU TDX, sans toucher au runner de staging ni à ses registres) :
1. Construire une image `FROM` l'image runner en service (`sirius-runner@sha256:5a63e9dd…1c06` d'après le 20 octobre ; à relire dans le Compose actif) qui ajoute `audit/robustesse/` et `scripts/operations/gbdt-benchmark-csv.mjs`, avec `ENV TEE_MODE=stub` et `CMD ["node", "--expose-gc", "--import", "tsx", "audit/robustesse/memory-bench.ts"]`. Aucun secret : le script n'utilise ni master key, ni RPC, ni IPFS.
2. La déployer sur une **CVM séparée** du même type d'instance que staging, Compose réduit à ce seul service, sans volume.
3. Lire le tableau dans les journaux du conteneur, puis arrêter et supprimer la CVM ; noter durée et coût.
4. Critère : médiane `Worker` < 10 s (marge × 1,5 sous 15 s) et old-gen minimale ≤ 96 Mo pour chaque cas ; sinon abaisser `MAX_TRAINING_OPERATIONS` / `GBDT_MAX_OPERATIONS`.

Les commandes Phala exactes et le Compose actif sont dans les fichiers opérateur hors dépôt : non recopiés ici (NON VÉRIFIÉ).

## Le 503 du 20 octobre

Fait : pendant la recette arbres du 20 octobre, une tentative a échoué en 503 « Confidential runner unavailable » ; la suivante a réussi ; aucun échec compté par le runner (docs/PHALA-DEMO-IMPLEMENTATION.md, session staging arbres).

Ce message ne vient que d'un endroit : `src/lib/tee/runner-client.ts:62`, quand l'appel au runner lève une exception qui **n'est pas** une `AppError` — erreur réseau, TLS, délai de 60 s, ou échec d'attestation RA-TLS. Toute réponse HTTP du runner (même 503 « Runner saturé » ou « Exécution confidentielle interrompue ») aurait gardé son propre message. Cela écarte déjà plusieurs pistes.

| # | Hypothèse | Testable en local ? | Résultat |
|---|---|---|---|
| H1 | Connexion keep-alive réutilisée au moment où le runner la ferme (`keepAliveTimeout` 5 s, agent client sans délai d'inactivité) → `ECONNRESET` → 503 | Oui : `keepalive-503.test.ts` (relais TCP 80 ms/sens, réglages identiques à `server.ts`) | **Reproduite** : 19/27 échecs entre 5,8 et 6,05 s d'inactivité, 6/6 à 5,9 s, 0/66 ailleurs. Compatible avec « échec puis succès » (l'agent est détruit, la tentative suivante repart d'une connexion neuve). Non prouvée sur la CVM. → ROB-10 |
| H1b | `maxRequestsPerSocket = 20` : Node répond 503 au-delà | Oui | **Écartée** : 25 appels de suite sur un agent, 25 × 200 (le serveur annonce `Keep-Alive: timeout=5, max=20`, le client rouvre une connexion) ; et une 503 HTTP n'aurait pas eu ce message |
| H2 | Ré-attestation (toutes les 5 min ou après une erreur) : collatéraux PCCS indisponibles ou lents, `fetch` sans délai ni nouvel essai | Non (ni quote TDX réelle, ni appel PCCS pendant l'audit) | Plausible par le code → ROB-11 ; NON VÉRIFIÉ |
| H3 | Runner saturé (plafond de concurrence 8) | Oui (`free-ops-burst.test.ts`) | **Écartée** pour ce message : la saturation rend une 503 HTTP « Runner saturé » |
| H4 | Arrêt du worker ou du runner pendant l'entraînement | Partiellement | Arrêt du worker → « Exécution confidentielle interrompue » (AppError) : **écarté**. Arrêt du processus runner pendant la requête → « socket hang up », compatible : NON VÉRIFIÉ (journaux CVM non consultés) |
| H5 | Passerelle Phala (TLS passthrough) qui coupe une connexion inactive plus tôt que le runner, ou redémarre | Non | NON VÉRIFIÉ ; même symptôme que H1, même correction |
| H6 | Délai client de 60 s dépassé | — | **Peu probable** : 32 s du clic au résultat, transaction de titre comprise |
| H7 | `requestTimeout = 30 s` coupe un calcul long | Oui | **Écartée** : réponse après 35,3 s reçue en 200 (le délai ne porte que sur la réception de la requête) |

Pour trancher sans dépense supplémentaire, à la prochaine session déjà prévue : journaliser côté Next le `code` de l'erreur réseau (`ECONNRESET`, `UND_ERR_SOCKET`, `ETIMEDOUT`, message d'attestation) et `req.reusedSocket`, sans corps ni en-têtes. Une `ECONNRESET` sur socket réutilisé confirmerait H1.

## Points NON VÉRIFIÉS

- Toutes les mesures de temps et de mémoire sur la CVM staging : procédure prête, **non lancée** (consigne : aucune dépense).
- Valeurs installées de `maxActive`, `maxExecutionMs` et `RUNNER_TRAINING_TIMEOUT_MS` sur staging et prod (fichiers d'environnement non lus, par consigne).
- Coût réel des fsync SQLite sur le disque de la CVM (mesuré seulement dans un conteneur sous WSL2).
- Cause réelle du 503 du 20 octobre : H1 reproduite en local seulement ; H2, H4 (arrêt du processus) et H5 non testées ; journaux CVM non consultés.
- Comportement du PCCS Phala en cas de panne (aucun appel réseau pendant l'audit).
- Version de Node des fonctions Vercel (le comportement keep-alive de l'agent peut en dépendre).
- Que les threads 0–11 soient bien les cœurs performants du Core Ultra 7 155H (convention Windows habituelle, non vérifiée) ; d'autres agents tournaient sur la machine pendant les mesures.
- Jeux OpenML 42477 et 46929 : non utilisés.
- Effet de ROB-05 (BOM) sur le parcours `/phala` complet dans un navigateur : vu dans le code de l'évaluation, pas rejoué.
- Exhaustivité : fuzz à graine fixe ; d'autres graines (`AUDIT_SEED`, `AUDIT_FUZZ_RUNS`) peuvent trouver d'autres cas.
