# Upload jusqu'à 1 Go, contrats sans perte de datasets, KMS on-chain (conception)

Document de travail de la branche `feat/upload-1go`, 2 novembre 2026. Rien de ce qui suit n'est en production.
Les choix marqués **Décidé** viennent d'Ali ; le reste est **proposé** et attend la relecture de Noé.

## 1. Objectif et décisions

Cible : samedi 7 novembre, sur le mainnet.

| Sujet | Décision |
|---|---|
| Taille visée | **Décidé** : 1 Go par dataset |
| Stockage des morceaux chiffrés | **Décidé** : Cloudflare R2 |
| Outil d'envoi | **Décidé** : le site (glisser-déposer, voie principale pour tous) **et** une CLI (équipes techniques, automatisation), tous deux pour le 7, sur le même code de découpage et de chiffrement |
| Répartition | **Décidé** : Ali porte l'upload, les contrats et la migration ; Noé porte l'API de prédiction (D-28), ses tests et l'expiration de la location |
| Branches | **Décidé** : tout l'upload se fait dans `feat/upload-1go`, testé dans la branche, fusionné dans `staging` seulement quand personne ne l'utilise ; pas de PR pour l'instant |
| Migration | Proposé : une seule migration mainnet le 7, conçue pour être la dernière qui fait perdre des datasets |

## 2. Point de départ (code de `staging`, 727f54b)

| Élément | État | Où |
|---|---|---|
| Envoi | Le navigateur chiffre tout le fichier (ECDH P-256 + AES-GCM vers la clé d'ingestion) et l'envoie en un seul JSON | `src/lib/tee/ingress-client.ts`, `src/app/api/datasets/[id]/upload/route.ts` (délai 30 s) |
| Scellement | L'enclave déchiffre, valide, calcule la racine Merkle du clair (feuilles de 64 Kio), tire une DEK, chiffre en AES-256-GCM, envoie sur IPFS (Pinata), enveloppe la DEK avec la clé maître | `sealDataset` / `sealDatasetEnvelope`, `src/lib/tee/core.ts` |
| Lecture pour entraîner | Tout le fichier rechargé depuis IPFS en mémoire, déchiffré, racine vérifiée | `decryptDataset`, `src/lib/tee/core.ts` |
| Taille max (application) | 3 Mio (limite des 4,5 Mo de Vercel pour le JSON en base64) | `MAX_DATASET_BYTES`, `src/lib/tee/contract.ts` |
| Taille max (contrat) | **16 Mio, constante gravée** | `MAX_SIZE_BYTES`, `contracts/src/SiriusDatasetRegistry.sol` |
| Lignes max | 50 000 | `MAX_CSV_ROWS`, `src/lib/sirius/metrics.ts` |
| Calcul | 200 M d'opérations, 15 s de temps CPU | `src/lib/tee/train.ts` |
| Modèles | Scellés dans le runner et servis par prédiction signée (D-28) | `src/lib/tee/served-models.ts`, `src/runner/handler.ts` |

### Pourquoi chaque migration fait perdre les datasets aujourd'hui

1. **Registre figé** : la limite de taille est une constante ; `mint` n'accepte que le fournisseur (`msg.sender`) ; aucune fonction d'import. Nouveau registre = datasets restés dans l'ancien.
2. **Escrow soudé** : dans `SiriusEscrowV7.sol`, `datasets` (le registre) et `lockAuthorizer` (la clé de l'enclave) sont `immutable`. Nouveau registre ou nouvelle enclave = nouvel escrow.
3. **Clés liées à l'app Phala** : la DEK de chaque dataset (et chaque modèle servi) est enveloppée par la clé maître de l'app. Nouvelle app (KMS on-chain) = l'enclave ne sait plus les lire.

## 3. Architecture visée

```text
Fournisseur (site ou CLI)        Site Sirius (Next)            Cloudflare R2           Enclave (runner Phala)
1. lit la clé d'ingestion  ────────────────────────────────────────────────────────>  publie sa clé, signée KMS
   vérifie la chaîne KMS
2. découpe + chiffre        3. ouvre l'envoi (KYB, quota)
   calcule 2 racines           donne des URL d'envoi
4. envoie les morceaux ──────────────────────────────────> stocke du chiffré
5. clôt l'envoi (manifeste) ──> enregistre, demande le scellement ─────────────────>  relit, déchiffre en flux,
                                                                                       vérifie les 2 racines,
                                                                                       range en colonnes,
                                                                                       ré-enveloppe la clé
6. le fournisseur publie le titre on-chain (2 racines, taille, profil)
7. prêt payé ──> tâche en arrière-plan sur une CVM 8 Go (même app, même clé) ──> modèle scellé (D-28)
```

## 4. Format des morceaux (proposé)

- **Clé d'envoi** : le CLI fait un ECDH P-256 éphémère avec la clé d'ingestion de l'enclave (même schéma que `DatasetIngressEnvelope` v1 : `ephemeralPublicKey`, `salt`), puis HKDF-SHA256 avec l'info `sirius-dataset-upload-v1:<datasetId>:<uploadId>` → clé AES-256 `K`.
- **Morceau `i`** : 8 Mio de clair (le dernier plus petit), chiffré AES-256-GCM avec `K`, IV aléatoire de 12 octets, et en données associées (AAD) : `sirius-chunk-v1`, `datasetId`, `uploadId`, `i`, `nombreDeMorceaux`, `tailleClaireDuMorceau`. Un morceau déplacé, retiré ou dupliqué ne se déchiffre pas.
- **Racine du clair** : la même construction qu'aujourd'hui (`buildMerkleTree`, feuilles de 64 Kio) sur tout le fichier. Elle reste le `merkleRoot` du titre ; seule l'enclave peut la recalculer.
- **Racine du chiffré** : Merkle sur le SHA-256 de chaque objet morceau tel que stocké dans R2. Tout le monde peut la vérifier en retéléchargeant les morceaux.
- **Manifeste** (JSON, stocké dans R2 à côté des morceaux) : version, `datasetId`, `uploadId`, enveloppe ECDH, taille claire totale, nombre et taille des morceaux, SHA-256 de chaque morceau, les deux racines. Son SHA-256 remplace le CID IPFS dans `cidHash`.
- **Pas de rechiffrement dans l'enclave** : après vérification, l'enclave enveloppe `K` avec sa clé maître (`wrapKey(K, datasetKeyContext(datasetId))`) ; les morceaux restent tels quels dans R2. Rien de 1 Go n'est renvoyé.

## 5. Stockage R2 (proposé)

- Un bucket privé, aucun accès public. Clé `datasets/<datasetId>/<uploadId>/manifest.json` et `.../chunks/<i>`.
- Envoi en **multipart** R2 via des URL pré-signées courtes (quelques minutes, un morceau chacune), données par le site. Reprise : le CLI demande la liste des morceaux déjà reçus.
- Le site et Cloudflare ne voient que du chiffré. Les identifiants R2 sont des secrets serveur (Vercel) ; le runner lit avec un jeton en lecture seule passé dans sa configuration chiffrée.
- Garde-fous : envoi réservé aux fournisseurs KYB, quota d'octets par fournisseur et par jour, expiration des envois non clos (nettoyage), taille annoncée vérifiée à la clôture.

## 6. Côté fournisseur : site et CLI (décidé : les deux pour le 7)

Un seul module partagé (TypeScript, Web Crypto, utilisable dans le navigateur et dans Node) fait tout le travail : vérification de la clé, découpage, chiffrement, racines, manifeste, envoi et reprise. Le site et la CLI n'en sont que deux interfaces.

Étapes communes :
1. récupérer la clé d'ingestion et **vérifier sa chaîne de signature KMS** (guest-api-v1 de dstack, « Verifying a chain ») ;
2. lire le CSV en flux, morceau par morceau, contrôler le format avec le lecteur strict partagé, calculer la racine du clair ;
3. chiffrer et envoyer chaque morceau vers R2, en parallèle limité ;
4. clore l'envoi et publier le titre.

**Site (voie principale, pour tout le monde)** :
- glisser-déposer du fichier, barre de progression, message « ne fermez pas cette page » ;
- lecture par `File.slice`, quelques morceaux en mémoire à la fois, quelle que soit la taille du fichier ;
- reprise : si la page se ferme, le fournisseur resélectionne le même fichier ; le site vérifie qu'il s'agit du même (taille et empreinte du premier morceau) et n'envoie que les morceaux manquants ;
- sous 3 Mio, le parcours actuel en une seule enveloppe reste disponible.

**CLI (équipes techniques, automatisation)** :
- `sirius upload <fichier.csv> --model <profil>`, connexion par jeton du fournisseur ;
- même reprise, sans page à garder ouverte ; utilisable depuis un serveur ou une tâche planifiée.

## 7. Côté site : routes (proposé)

| Route | Rôle |
|---|---|
| `POST /api/datasets/[id]/uploads` | ouvre un envoi : KYB, quota, taille annoncée, profil ; renvoie `uploadId` |
| `POST /api/datasets/[id]/uploads/[uploadId]/parts` | URL pré-signées pour une liste de morceaux |
| `POST /api/datasets/[id]/uploads/[uploadId]/complete` | vérifie le manifeste et la présence de tous les morceaux, demande le scellement au runner |

Aucune route ne lit de clair ni de clé. Les tables Prisma ajoutées sont additives (envois, morceaux reçus).

## 8. Côté enclave (proposé)

- Nouvelles opérations du runner, **ajoutées** dans `handler.ts` à côté de celles de Noé : `seal-chunked-dataset`, `train-job-start`, `train-job-status`.
- Lecture en flux depuis R2, déchiffrement morceau par morceau, recalcul des deux racines, validation CSV en flux.
- **Stockage en colonnes** : chaque colonne numérique en `Float32Array`, la cible en `Uint8Array` (classification) ou `Float32Array` (régression). Ordre de grandeur : 10 M lignes × 15 colonnes ≈ 600 Mo.
- Les arbres boostés travaillent déjà par histogrammes ; la logistique passe en descente par mini-lots sur les colonnes.

## 9. Entraînement en arrière-plan (proposé)

- Un prêt réglé lance une **tâche** ; l'API renvoie l'état (`queued`, `running`, `done`, `failed`), le site l'affiche.
- Les gros entraînements tournent sur une **CVM `tdx.large` (8 Go) allumée à la demande** sous la même app, donc avec la même clé (testé le 30–31 oct. sur Base KMS) ; elle s'éteint à la fin. Facturation à la minute.
- Limites par taille : 3 Mio et 15 s restent la voie rapide ; au-delà, budget d'opérations et délai relevés pour la voie lourde.
- À la fin, le modèle passe par le scellement de D-28 (`served-models.ts`) : **point de branchement avec Noé**.

## 10. Contrats qui ne perdent plus les datasets (proposé)

### Registre v6
- `maxSizeBytes` devient un réglage modifiable par l'admin (le Safe), sous un plafond gravé (par exemple 10 Gio).
- Nouveau champ `ciphertextRoot` à côté de `merkleRoot`.
- `importTitle(...)`, **réservé au Safe**, recopie un titre de l'ancien registre (même fournisseur, mêmes empreintes) ; un événement par import.

### Escrow v8
- `datasets` et `lockAuthorizer` ne sont plus `immutable` : changement **proposé par le Safe, exécutable après 48 h**, avec événements `…Proposed` et `…Changed`.
- À vérifier : qu'un prêt verrouillé garde l'autorisateur et le registre de son verrouillage (stockés dans le prêt), pour qu'un changement n'affecte pas les prêts en cours.

Ces changements touchent des contrats qui tiennent de l'argent : tests Hardhat complets, déploiement testnet, relecture de Noé avant le mainnet.

## 11. KMS on-chain sur Base et passage de clés (proposé)

- Nouvelle app Phala en KMS on-chain **Base**, propriétaire = un Safe sur Base avec les mêmes signataires que le Safe Robinhood.
- **Passage de clés** : une opération de l'ancien runner rechiffre, pour la nouvelle enclave, la DEK de chaque dataset et la clé de chaque modèle servi.
  - L'ancien runner ne répond que si la cible prouve son identité : quote TDX valide, compose hash égal à celui épinglé dans sa configuration, clé signée par le KMS on-chain de l'app attendue.
  - Les fichiers (IPFS, R2) ne bougent pas.
- Les paiements et les titres restent sur Robinhood Chain ; seul le contrôle des mises à jour de l'enclave vit sur Base.

## 12. API de prédiction (Noé)

- Déjà sur `staging` : PR #129, décision D-28.
- À ajouter pour le 7 : **expiration de la location** (fin d'accès à la date louée) et **sauvegarde chiffrée des modèles** hors du disque de la CVM.
- Point commun avec l'upload : scellement du modèle à la fin d'une tâche en arrière-plan.

## 13. Règles anti-conflit

- Ali travaille seulement dans `feat/upload-1go` ; `staging` y est fusionné chaque matin.
- `src/runner/handler.ts` est le seul fichier partagé : on **ajoute** des opérations, on ne modifie pas celles de Noé.
- Les contrats ne sont touchés que dans cette branche.
- Fusion dans `staging` quand personne ne l'utilise ; tests sur la CVM de staging (testnet).

## 14. Planning

| Jour | Ali (+ Claude) | Noé | Actions manuelles d'Ali |
|---|---|---|---|
| Lun. 2 | Ce document ; format des morceaux | Relit ce document ; expiration | Compte Cloudflare + bucket R2 ; Safe sur Base |
| Mar. 3 | Module partagé + routes du site + envoi par le site + CLI | Expiration + sauvegarde des modèles | Secrets R2 dans Vercel staging |
| Mer. 4 | Lecture en flux, vérification, colonnes | Tests API | — |
| Jeu. 5 | Tâches en arrière-plan + CVM 8 Go ; registre v6 et escrow v8 avec tests | Branchement avec l'upload | Rallumer la CVM de staging |
| Ven. 6 | Test de bout en bout sur staging avec un fichier de 1 Go ; passage de clés testé | Tests de bout en bout | **Go / no-go mainnet** |
| Sam. 7 | Migration mainnet : contrats, nouvelle app KMS, passage de clés, import | API en production | Signatures Safe, variables Vercel, annonces |

## 15. Risques et plan B

- Environ 12 à 14 jours de travail sur 6 jours : tout doit s'enchaîner.
- La migration mainnet ne se fait que si tout a marché sur staging le vendredi.
- **Plan B** : le 7, seule l'API de Noé passe en production ; l'upload et la migration suivent la semaine d'après.

## 16. Avancement (branche `feat/upload-1go`)

| Étape | État | Où |
|---|---|---|
| Format des morceaux, manifeste, racines | Fait, testé | `src/lib/upload/chunked.ts` |
| Lecteur CSV en flux, validation identique aux petits fichiers | Fait, testé | `src/lib/upload/csv-stream.ts`, `src/lib/tee/chunked-validation.ts` |
| Scellement dans l'enclave depuis R2 | Fait, testé en réel (25 Mio, 700 000 lignes, 5,2 s) | `sealChunkedDataset` (`src/lib/tee/core.ts`), `src/lib/storage/r2.ts` |
| Routes du site, table `DatasetUpload`, opérations du runner | Fait, testé | ci-dessous |
| Envoi par le site et CLI | À faire | — |
| Entraînement des gros fichiers | À faire : un dataset en morceaux se scelle et se publie, mais ne s'entraîne pas encore | — |
| Registre v6 et escrow v8 | À faire : le registre v5 refuse plus de 16 Mio au mint | — |

**Routes** (toutes authentifiées, réservées au fournisseur du brouillon) :

| Route | Rôle |
|---|---|
| `POST /api/datasets` avec `transfer: "chunked"` | brouillon d'un gros fichier (jusqu'à `SIRIUS_CHUNKED_MAX_BYTES`, 16 Mio par défaut tant que le registre v5 reste en place, 1 Gio au plus) |
| `POST /api/datasets/[id]/uploads` | ouvre ou reprend l'envoi : `uploadId`, découpage, clé d'ingestion |
| `POST …/uploads/[uploadId]/parts` | URL d'envoi de 15 min, **taille du morceau signée** (R2 refuse un autre corps : vérifié en réel) |
| `GET …/uploads/[uploadId]` | morceaux déjà reçus (reprise), puis suivi du scellement ; pose la référence, la clé et le reçu sur le brouillon |
| `POST …/uploads/[uploadId]/complete` | grant du fournisseur + manifeste ; vérifie chaque morceau, écrit le manifeste, lance le scellement (202) |
| `DELETE …/uploads/[uploadId]` | abandon, morceaux supprimés |

**Runner** (opérations ajoutées, rien de modifié dans les autres) :
- `seal-chunked-dataset` : grant `seal-chunked-dataset` dont l'intention porte l'empreinte du manifeste ; le scellement tourne **en arrière-plan** (relire 1 Gio dépasse les 65 s d'une requête du runner), un seul à la fois ; budget par tentative, un stockage injoignable rend la réservation.
- `seal-chunked-status` : lecture de l'état, gratuite (comme la clé d'ingestion).
- Le runner lit R2 avec ses propres variables `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (jeton en lecture seule) : à ajouter à la configuration de la CVM avant le test sur staging.
- L'instance de démonstration Phala refuse ces opérations.

**Restes connus** : les morceaux d'un brouillon supprimé sans abandon restent dans R2 (nettoyage à prévoir) ; un runner redémarré oublie ses scellements en cours (le fournisseur relance la clôture, sans renvoyer ses morceaux).

## 17. Questions ouvertes

1. Phala (mail à Wenfeng du 2 nov.) : migration d'une app de Cloud KMS vers Onchain KMS ; récupération du volume si le nœud tombe ; taille et délai maximum d'une requête via la passerelle.
2. Taille de morceau définitive (8 Mio proposés) selon la réponse sur la passerelle.
3. Prix de location et durée par défaut de l'expiration (Noé).
4. Faut-il garder IPFS en copie des morceaux chiffrés, en plus de R2 ?
