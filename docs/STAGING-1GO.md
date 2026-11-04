# Checklist staging : upload 1 Go (étape 8)

À dérouler **avec Noé**, staging réservé pendant le test. Rien ici ne touche la production.
Contexte : `docs/UPLOAD-1GO.md`. Branche : `feat/upload-1go`.

Légende : 👤 Ali · 🧑‍💻 Noé · 🤖 Claude · ✅ critère de réussite.

## 0. Avant de commencer

- [ ] 👤🧑‍💻 Staging libre, Noé d'accord pour la fusion.
- [ ] 👤 Crédits Phala rechargés, CVM de staging rallumée.
- [ ] 👤 Gas testnet sur la clé de déploiement (≈ 0,01 ETH suffit pour 2 contrats + liaison + réglages).
- [ ] 🧑‍💻 Aucun prêt en cours sur l'escrow de staging (les nouveaux contrats remplacent l'escrow : un prêt
  verrouillé sur l'ancien doit être réglé ou remboursé avant).

## 1. R2 (Cloudflare)

- [ ] 👤 Bucket `sirius-staging` → Settings → CORS policy :

```json
[
  {
    "AllowedOrigins": ["https://sirius-evm-staging.vercel.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

  Remplacer l'origine si staging a un autre domaine. Sans cette règle, le navigateur ne peut pas envoyer les morceaux.
- [ ] 👤 Jetons : site (lecture-écriture, déjà créé) et runner (**lecture seule**, déjà créé), tous deux limités à `sirius-staging`.

## 2. Contrats testnet (registre v6 + escrow v7 redéployé)

- [ ] 🤖 Exécution à blanc, puis déploiement (testnet, KYB ouvert existant réutilisé) :

```bash
SIRIUS_DEPLOY_NETWORK=testnet SIRIUS_BILLING_VERSION=7 SIRIUS_KYB_MODE=open \
SIRIUS_KYB_EXISTING_ADDRESS=<KYB staging> \
SIRIUS_PREVIOUS_DATASET_REGISTRY=<registre v5 de staging> \
SIRIUS_USDC_ADDRESS=<USDC testnet> SIRIUS_USDC_CODE_HASH=<code hash> \
SIRIUS_LOCK_AUTHORIZER=<lock authorizer de staging> \
SIRIUS_DATASET_TRAINING_PROFILES=gradient_boosted_trees \
ROBINHOOD_DEPLOYER_KEY=… pnpm contracts:deploy:testnet
```

  ✅ `VERSION` = `sirius-dataset-v6`, `previousRegistry` = l'ancien registre, escrow lié, profils acceptés.
- [ ] 🤖 Taille maximale à 1 Gio (lot signé par l'admin du registre) :
  `SIRIUS_DATASET_MAX_SIZE_BYTES=1073741824 pnpm contracts:dataset-admin prepare-max-size`
- [ ] 🤖🧑‍💻 Import des titres existants : identifiants on-chain des datasets publiés de staging
  (`SELECT "evmDatasetId" FROM "Dataset" WHERE "evmDatasetId" IS NOT NULL AND "evmDestroyTxHash" IS NULL`),
  puis `SIRIUS_DATASET_IMPORT_IDS=0x…,0x… pnpm contracts:dataset-admin prepare-import` → signer le lot.
  ✅ Relancer `prepare-import` : chaque titre « existe déjà dans ce registre ».
- [ ] 🧑‍💻 Ancien escrow ajouté à `SIRIUS_LEGACY_ESCROW_ADDRESSES` partout où il est lu (site, runner, reaper).

## 3. Fusion dans `staging`

- [ ] 👤🧑‍💻 Fusionner `feat/upload-1go` dans `staging` (le pipeline applique la migration
  `20261104000000_add_dataset_uploads` : table `DatasetUpload`, additive).
  ✅ Pipeline vert, table présente.

## 4. Vercel (projet staging, environnement Preview/Staging)

- [ ] 👤 `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (jeton **site**), `R2_BUCKET=sirius-staging`.
- [ ] 👤 `SIRIUS_CHUNKED_MAX_BYTES=1073741824` (seulement après le réglage du registre à l'étape 2).
- [ ] 👤 Nouvelles adresses : `SIRIUS_DATASET_ADDRESS`, `SIRIUS_ESCROW_ADDRESS` (et leurs équivalents `NEXT_PUBLIC_…` s'il y en a).
- [ ] 👤 Redéployer staging.

## 5. Runner (CVM de staging)

- [ ] 🧑‍💻 Image du runner reconstruite depuis le commit de `staging` (procédure habituelle, digest figé).
- [ ] 🧑‍💻 Compose rendu par `scripts/render-phala-v7.mjs` (le Compose contient désormais `R2_*`, facultatives).
- [ ] 👤🧑‍💻 Variables chiffrées Phala : `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (jeton **runner, lecture seule**),
  `R2_BUCKET=sirius-staging`, plus les nouvelles adresses de contrats.
- [ ] 🧑‍💻 Déployer, puis mettre à jour ce qui épingle le runner (mesures et empreinte de compose, comme à chaque mise à jour).
  ✅ `/health` = ok ; le site lit la clé d'ingestion.

## 6. Scénario de test

| # | Action | ✅ Attendu |
|---|---|---|
| 1 | Publier un petit CSV (< 3 Mo) par le site | Parcours inchangé, titre minté sur le v6 |
| 2 | Dataset publié **avant** la bascule (titre importé) : l'ouvrir, l'emprunter | Visible, empruntable, entraînement et prédictions OK |
| 3 | Glisser un CSV de ~1 Go dans le formulaire | Lecture par tranches avec %, refus éventuels identiques à un petit fichier |
| 4 | Publier ce fichier | Envoi en %, scellement, mint d'un titre de ~1 Go ; morceaux visibles dans R2 (chiffré seulement) |
| 5 | Fermer l'onglet en plein envoi, puis réessayer | Le navigateur avertit ; l'envoi abandonné est nettoyé, le nouvel essai repart de zéro et aboutit |
| 6 | CSV invalide de plus de 3 Mo (cible incomplète) | Refus clair avant l'envoi ; et, forcé par la CLI, refus de l'enclave avec le même message, morceaux supprimés |
| 7 | CLI : `pnpm upload:cli fichier.csv --name … --category Finance --price 10` (`SIRIUS_URL` = staging, `SIRIUS_INGRESS_KEY_SHA256` = empreinte de staging) | Scellé ; brouillon publiable depuis le site |
| 8 | Emprunter le dataset de ~1 Go (autre wallet), lancer l'entraînement | Prêt réglé, modèle entraîné sur l'échantillon (`n` ≤ 49 999 dans les métriques), fiche marketplace qui l'annonce |
| 9 | Prédictions sur ce modèle | Réponses signées |
| 10 | Self-train du fournisseur sur son gros dataset | Modèle scellé, prédictions OK |
| 11 | Redémarrer le runner pendant un scellement | Le site rouvre l'envoi (« Scellement interrompu ») ; relance sans renvoyer les morceaux |

Mesures à noter : durée d'envoi de 1 Go, durée du scellement, mémoire de la CVM pendant le scellement
(limite actuelle 768 Mo), durée de l'entraînement sur échantillon.

## 7. Go / no-go mainnet (vendredi soir)

- **Go** si 1 à 9 passent et que le scellement de 1 Go tient dans la CVM.
- **No-go** sinon : plan B, lundi seule l'API de Noé est annoncée ; le 1 Go suit la semaine d'après.
- Dans les deux cas : remettre staging à Noé, noter les mesures dans `docs/UPLOAD-1GO.md`.
