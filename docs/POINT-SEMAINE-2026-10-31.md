# Point de la semaine du 25 au 31 octobre 2026

Résumé pour Ali et Noé : ce qui a été fait, testé et découvert sur l'enclave, et ce qu'il reste à faire.

## 1. Ce qui a été fait

| Date | PR | Quoi |
|---|---|---|
| 25 oct. | #125 | Corrections de l'audit interne des modèles et du runner (détail en section 2) |
| 27 oct. | #128 | Version attestée du runner `95bf2bf` déclarée |
| 27 et 30 oct. | #127, #131 | Passages staging → production |
| 28 oct. | #130 | Le règlement rapide se confirme sans recharger la page ; textes avec les arbres boostés ; `qs` 6.16.1 |
| 28 oct. | — | **Mainnet passé aux arbres boostés** : registre v5 `0x9f405491d3d428f2f1f5a373a47e413ef6fab57f`, escrow v7 `0xc43a70c3d799fdc06698938f2b1c9a6325eb81f7` (admin = Safe), compose hash `167100e2…3a21`, tarif `mainnet-trees-2026-10-28`. Les 3 datasets du registre v4 sont suspendus |
| 30 oct. | #132 | Prisma 7.10.1 (retire `@hono/node-server`, GHSA-rmxm-3fg6-px4f) |

**À relire par Noé** : #125, #131 et #132 ont été fusionnées sans sa relecture. Priorités dans #125 : dédoublonnage
par empreinte, calcul des seuils, refus sous 1 000 lignes distinctes, banc de canaris.

## 2. Arbres boostés : ce qui a été corrigé (#125)

### La fuite d'appartenance

Avec les arbres 1.0.0, un attaquant qui détient le modèle pouvait deviner si une personne donnée faisait partie du
fichier d'entraînement : le modèle réagissait différemment à une ligne déjà vue, et les seuils des arbres étaient des
valeurs exactes du fichier.

| | AUC de l'attaque (0,5 = hasard) |
|---|---|
| Avant (1.0.0) | 0,72 à 0,81 |
| Après (1.1.0), 20 essais | 0,48 à 0,52 |

Correctifs, profil **1.1.0** (empreinte `0x4f19db62…0f07`) :
- lignes répétées comptées une seule fois ;
- seuils jamais égaux à une valeur du fichier (milieu entre deux valeurs voisines) ;
- métriques arrondies, `aucGap` publié à la place de `trainAuc` ;
- refus sous 1 000 lignes distinctes ;
- en-têtes limités à `[A-Za-z0-9_]{1,64}` ;
- banc de canaris en CI.

La qualité held-out est inchangée ou meilleure. Logistique et linéaire ne changent pas. Les modèles arbres 1.0.0 de la
démo ne sont plus acceptés.

### Le reste de l'audit

- **Lecteur CSV strict**, le même dans le navigateur, à l'ingestion et dans l'enclave : refus avec numéro de ligne (BOM,
  `\r` isolé, guillemets, nombre de cellules, hexadécimal, cible presque numérique). Vérifié sur 27 fichiers × 3
  profils : un fichier valide donne exactement le même modèle.
- Écart train / held-out anormal signalé dans les deux sens ; délai interne mesuré en temps CPU.
- Un prêt arbres déjà payé s'exécute même si l'option est coupée ensuite.
- Débit et coupe-circuit sur les opérations gratuites ; cause de chaque 503 journalisée.
- Build reproductible (base épinglée par digest) : trois builds sans cache donnent le même digest.
- Tests : `test:operations` 91/91 ; `pnpm test` 1177/1190, les 13 échecs étant identiques sur `staging`
  (environnement).

### Conséquences

- Un dataset déjà publié avec un défaut de format échoue à l'entraînement (remboursement `Failed`).
- **À vérifier** : empreinte 1.1.0 ajoutée au registre v5 **testnet**.

## 3. Test du KMS on-chain sur Base (30–31 oct.)

### Pourquoi

Avec le KMS hébergé par Phala (`--kms phala`, notre mode actuel), toute personne qui a accès au compte Phala peut
déployer un nouveau code qui reçoit les mêmes clés, donc lire les datasets. Avec le **KMS on-chain**, un contrat
`DstackApp` sur Base liste les versions du code autorisées ; seul son propriétaire (un wallet ou un Safe) peut en
ajouter.

### Comment

App jetable dans le workspace Phala `sirius_data`, KMS Base, contrat `DstackApp`
`0x8309d5a054220a8831a3df8fab253fadb96b5427` (propriétaire : wallet d'Ali). Une sonde Python n'exposait qu'une
empreinte SHA-256 de la clé dérivée, jamais la clé.

### Résultats

| Essai | Résultat |
|---|---|
| Redémarrage | ✅ même clé |
| Mise à jour du code **sans** signature du propriétaire | ✅ **refusée** (ERR-01-008 « Compose hash … is not allowed »), l'ancienne version continue |
| Mise à jour après `addComposeHash` signé sur Basescan | ✅ acceptée, même clé |
| 2e instance sous la même app | ✅ même clé |
| Cette 2e instance agrandie à `tdx.large` (4 vCPU / 8 Go) | ✅ même clé |
| Coût d'une CVM éteinte | disque seul, ~0,067 $/jour pour 20 Go |

Coût total : quelques centimes. Toutes les CVM de test sont supprimées ; le contrat reste sur Base (gratuit).

**Pas encore testé** : instance sur un autre nœud (`addDevice`), transfert de propriété vers un Safe, vérification de
la `signature_chain` du KMS côté client (aujourd'hui la clé attendue vient de notre propre build).

**Bugs du CLI Phala 1.1.22** (à leur signaler) : `instances add --node-id` refusé par l'API (ERR-01-011) ;
`cvms resize` échoue quand l'app a deux instances. Contournement :
`phala api -X PATCH /cvms/<uuid> -F vcpu:=4 -F memory:=8192` (sous Git Bash, préfixer `MSYS_NO_PATHCONV=1`).

### Proposition

À la prochaine migration de contrats : nouvelle app en KMS on-chain dont le propriétaire est un **Safe sur Base**.
Nouvelle app = nouvelles clés, donc datasets à republier : à faire en une seule migration.

## 4. Plan pour un dataset de 1 Go

Limites actuelles : 3 Mio par dataset (devis), 16 Mio (registre), 50 000 lignes, 31 colonnes, 15 s de calcul, CVM
1 vCPU / 2 Go. On est environ 300 fois en dessous de 1 Go.

- **Écarté** : FHE pour entraîner, preuves ZK, MPC, envoi en une requête, transfert de fichiers par Phala (n'existe
  pas), entraînement synchrone depuis Vercel.
- **Stockage** : morceaux chiffrés sur un stockage objet (Cloudflare R2 proposé) ; deux racines Merkle au registre
  (clair, vérifiée par l'enclave ; chiffré, vérifiable par tous).
- **Envoi** : outil en ligne de commande pour le fournisseur ; vérification de la clé de l'enclave ; morceaux de 1 à
  8 Mo chiffrés en flux ; envoi direct avec liens temporaires et reprise.
- **Entraînement** : CVM plus grosse allumée à la demande sous la même app (même clé, testé ci-dessus), tâche en
  arrière-plan, lecture en colonnes compactes. Ordre de grandeur pour 10 M lignes × 15 colonnes : ~1 Go de RAM,
  quelques minutes.
- **Règles** : gros envois réservés aux fournisseurs KYB avec quotas ; confidentialité différentielle avant toute API
  publique de prédiction.
- **Ordre** : fournisseur pilote + Safe Base → envoi par morceaux → entraînement en arrière-plan → confidentialité
  différentielle → une migration mainnet unique. Environ 6 à 8 semaines calendaires.

## 5. Reste à faire

| Qui | Quoi |
|---|---|
| Noé | Relire #125, #131, #132 |
| Ali + Noé | Relire et décider de #129 (API privée de prédiction GBDT) |
| Ali + Noé | Décider : Safe sur Base, stockage, fournisseur pilote, partage du travail, suppression de la CVM de démo éteinte |
| Ali | Retirer les crédits de trésorerie du Safe des deux escrows (`withdrawFor`) |
| — | Vérifier l'empreinte arbres 1.1.0 sur le registre v5 testnet |
| — | Candidatures : Alliance avant le 18 nov., swanbase The Nest avant le 15 nov. (si disponibles du 18 au 25 nov.) |
