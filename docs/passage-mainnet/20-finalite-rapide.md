# Finalité rapide des petits prêts — mise en service, vérification, retour arrière

Sur Robinhood Chain mainnet, le bloc `finalized` suit la finalité L1 et traîne un quart d'heure derrière la tête (≈ 8 500 blocs, relevé du 5 octobre). Un prêt attendait donc deux fois ~15 min : avant l'entraînement (le lock doit être sous le bloc stable) et après le release (le règlement n'est « réglé » qu'une fois finalisé). La finalité rapide accepte, pour les **petits prêts seulement**, le lock et le release après **30 confirmations L2** avec contrôle du hash canonique, soit quelques secondes. Décision des fondateurs, risque accepté : une réorganisation profonde de la L2 après un règlement rapide pourrait faire disparaître un release alors que le modèle a été livré ; l'exposition à ce risque est bornée par prêt (25 USDG) et au total (100 USDG en cours).

Références : [19-mise-en-production.md](19-mise-en-production.md) (étapes 3, 8, 9, 10, 11), [MAINNET-RUNBOOKS.md](../MAINNET-RUNBOOKS.md) (runbook 1 : identité de l'enclave), code : `src/lib/evm/fast-finality.ts`, `src/lib/sirius/finality-tier.ts`, `src/lib/sirius/fast-settlement-review.ts`.

## Règles

- Aucune valeur secrète ici ni dans le chat : seulement des **noms** de variables et des constantes publiques (seuils, confirmations).
- `SIRIUS_EVM_FINALITY=finalized` reste **obligatoire** sur mainnet. La finalité rapide s'y ajoute, elle ne la remplace pas ; le mode `confirmations` nu reste refusé partout (`finalityPolicy`, `mainnet-guard`, `release-check`, préflight).
- Coupe-circuit : `SIRIUS_FAST_FINALITY` absent ou `false` sur Next et le reaper ⇒ comportement historique **partout**, même pour les prêts déjà classés rapides (ils repassent en finalité complète ; seule la revérification des releases déjà réglés continue, elle est sans effet sur l'argent).
- Chaque geste réussi est consigné dans [MAINNET-LAUNCH.md](../MAINNET-LAUNCH.md) : heure, auteur, hash du Compose avant/après.

## Ce qui change, et où

| Décision de finalité | Avant | Avec le palier rapide (prêt FAST) |
|---|---|---|
| Lock avant entraînement, Next (`src/lib/sirius/settle.ts`, `prepareLoanResult`) | `assertBlockStable` : bloc finalisé ≥ bloc de lock | `assertLockStable` : reçu du lock relu, dans le bloc persisté, hash canonique, tête ≥ lock + 29 |
| Lock lu par l'enclave (`src/lib/evm/escrow.ts`, `assertLoanScope`) | `matchesScope` au bloc finalisé | `matchesScope` à tête − 29 |
| Reçu du release, enclave (`src/lib/billing/settlement.ts`, `confirm`) | canonique sous le bloc finalisé, sinon « pending-finality » | canonique sous tête − 29 |
| Livraison de la clé, enclave (`src/runner/handler.ts`, `loan-model-key` → `publishedFinalizedPreimage`) | idem | idem |
| Réconciliation du reaper et des reprises (`reconcileLoanEscrow`) | bloc finalisé | **inchangé** : toujours le bloc finalisé |
| Revérification d'un release rapide (`src/lib/sirius/fast-settlement-review.ts`) | — | 15 min après `settledAt`, sous le bloc finalisé ; divergence ⇒ alerte et revue |
| Affichage de l'attente (`GET /api/loans/[id]/finality`, page Train) | minutes | secondes, relecture toutes les 5 à 20 s |

Le palier d'un prêt est décidé **une fois**, au moment où l'entraînement peut démarrer : Next relit le montant sur le contrat (`getLoan`), vérifie qu'il égale le montant enregistré, puis, dans une transaction sérialisable, somme les prêts rapides en cours (ESCROWED, TRAINING, SETTLING) et marque la ligne (`Loan.finalityTier = FAST`). Un palier FAST est acquis ; un palier FULL est réévalué à chaque tentative. L'enclave n'accepte le palier rapide que si **sa propre** politique (constantes du Compose attesté) l'admet pour le montant du devis qu'elle a signé ; elle refuse explicitement sinon (`Finalité rapide refusée par l’enclave pour ce prêt`) et n'applique jamais le palier rapide sans que Next le demande.

## Variables

| Variable | Next (Vercel) | Reaper (VPS) | Runner (CVM) | Défaut | Rôle |
|---|---|---|---|---|---|
| `SIRIUS_FAST_FINALITY` | `true` / `false` | identique à Next | **constante du Compose** : `"true"` | absent = `false` | coupe-circuit |
| `SIRIUS_FAST_FINALITY_MAX_USDC` | `25` | identique | **constante du Compose** : `"25"` | `25` | seuil par prêt (dataset + calcul), unités du jeton |
| `SIRIUS_FAST_FINALITY_TOTAL_USDC` | `100` | identique | — (Next seul connaît la somme) | `100` | plafond des prêts rapides en cours ; ≥ `MAX_USDC` |
| `SIRIUS_FAST_FINALITY_CONFIRMATIONS` | `30` | identique | **constante du Compose** : `"30"` | `30` | confirmations L2, entre 1 et 100 |

Toute valeur illisible (drapeau autre que `true`/`false`, montant nul ou négatif, confirmations hors 1–100, seuil > plafond) **arrête le démarrage** du rôle concerné (Next : `instrumentation-node.ts` ; reaper : `mainnet-guard.ts` ; runner : `src/runner/config.ts`) et fait échouer `release-check`. Les trois rôles doivent se lire pareil : `release-check` refuse une divergence sur le drapeau, le seuil ou les confirmations (le fichier privé du runner recopie les trois constantes du Compose ; elles n'y servent qu'à cette vérification, le Compose fait foi dans la CVM).

Le plafond global reste sur Next à dessein : l'enclave ne connaît pas la base, et une constante attestée pour une somme qui bouge n'aurait aucun sens.

## Pourquoi la CVM change

`deploy/phala/compose.v7.yaml` porte désormais les trois constantes du runner. Elles sont couvertes par le **hash du Compose**, donc par l'attestation : personne ne peut relever le seuil ou baisser les confirmations de l'enclave sans que Next et le reaper le voient (ils comparent `SIRIUS_EXPECTED_COMPOSE_HASH` à chaque capture). La contrepartie : activer le palier rapide côté enclave est une **mise à niveau de la CVM** suivie d'un **ré-épinglage**, exactement comme l'étape 8 de [19](19-mise-en-production.md). Changer les constantes plus tard (autre seuil, autres confirmations) repasse par la même procédure.

## Procédure

**Qui** : Noé (CVM), Ali (Vercel, VPS). **Aucune transaction on-chain.** Durée : une heure, dont une demi-heure d'attente des prêts en cours.

### 0. Pré-requis

- La branche contenant la finalité rapide est fusionnée sur `staging`, CI verte, image runner publiée (digest `IMG` dans `.ops/mainnet/`), test complet passé sur testnet avec `SIRIUS_FAST_FINALITY=true` (lock et release d'un prêt ≤ 25 en quelques secondes, revérification du reaper journalisée).
- Migration Prisma `20261007000000_add_loan_finality_tier` **déjà appliquée** sur la base mainnet par le job Migrations (colonnes additives avec défauts : l'ancien code continue de tourner dessus ; le nouveau code ne tourne **pas** sans elles). Vérifier : `prisma migrate status` sans migration en attente.
- Clone à jour, `pnpm install --frozen-lockfile`, profil Phala `sirius` connecté, accès VPS.

### 1. Fermer les admissions et laisser finir les prêts en cours

**Qui** : Ali.

1. Vercel Production : `SIRIUS_ADMISSIONS_CLOSED=true`, redéployer. Les prêts déjà verrouillés continuent (entraînement, règlement, livraison) ; aucun nouveau lock.
2. Attendre que la base ne contienne plus de prêt ESCROWED, TRAINING ni SETTLING (page d'état, ou `SELECT status, count(*) FROM "Loan" GROUP BY status`). Ces prêts ont été lancés contre l'ancienne enclave : les laisser se régler avec elle évite tout prêt à cheval sur deux Compose.

**Vérifier** : plus aucun prêt actif ; le reaper journalise `passe ok` avec `prêts=0`.

### 2. Rendre le Compose actif avec les constantes

**Qui** : Noé.

```bash
pnpm phala:compose-v7 active "$IMG" .ops/mainnet/active.fast.compose.json --origin=https://sirius-data.tech
```

**Vérifier** : dans le JSON rendu, `services.runner.environment` contient `SIRIUS_FAST_FINALITY: "true"`, `SIRIUS_FAST_FINALITY_MAX_USDC: "25"`, `SIRIUS_FAST_FINALITY_CONFIRMATIONS: "30"`, et **pas** `SIRIUS_FAST_FINALITY_TOTAL_USDC` ; `SIRIUS_EVM_FINALITY: finalized` toujours présent (`scripts/render-phala-v7.test.mjs` le garantit). Le fichier précédent (`active.compose.json`) est conservé pour le retour arrière.

### 3. Mettre à niveau la CVM

**Qui** : Noé. Même geste que l'étape 8 de [19](19-mise-en-production.md), même fichier d'environnement chiffré (`runner.active.env`, rien à y ajouter : les trois valeurs sont des constantes du Compose).

```bash
pnpm dlx phala@1.1.22 deploy --profile sirius --cvm-id <cvm-id> \
  -c .ops/mainnet/active.fast.compose.json -e .ops/mainnet/runner.active.env --wait
```

**Vérifier** : le runner redémarre en mode actif ; son journal (privé) ne contient pas `Politique de finalité rapide invalide`. Le volume `runner_budget` (registre et politiques) est inchangé : même CVM, même master key, même adresse de règlement.

**Si ça échoue** : repasser le Compose précédent (`active.compose.json`) sur la même CVM, puis reprendre à l'étape 2 après correction. Tant que l'adresse de règlement est la même, rien n'est gravé de travers ; si elle a changé, **arrêter** : runbook 1.

### 4. Recapturer et ré-épingler

**Qui** : Noé (capture), Ali (variables).

1. `RUNNER_URL=https://<app-id>-4100s.<gateway-domain> pnpm runner:capture-ra-tls` : noter le **nouveau** hash du Compose. Comparer au document brut de `pnpm dlx phala@1.1.22 cvms attestation <cvm-id> --profile sirius`.
2. Contrôler que **seul le hash du Compose a changé** : MRTD identique, chaîne KMS identique, clé d'ingestion identique, adresse de règlement identique (RTMR3 bouge à chaque redémarrage, ce n'est pas un signal). Tout autre changement : ne pas ré-épingler, runbook 1.
3. Vercel Production : `SIRIUS_EXPECTED_COMPOSE_HASH` = nouveau hash (`vercel env add … production --sensitive`, valeur sur l'entrée standard). Poser en même temps `SIRIUS_FAST_FINALITY=true`, `SIRIUS_FAST_FINALITY_MAX_USDC=25`, `SIRIUS_FAST_FINALITY_TOTAL_USDC=100`, `SIRIUS_FAST_FINALITY_CONFIRMATIONS=30`.
4. VPS `/opt/sirius/.env.vps` : mêmes cinq valeurs (`SIRIUS_EXPECTED_COMPOSE_HASH`, les quatre `SIRIUS_FAST_FINALITY*`), puis `docker compose -p sirius --env-file .env.vps up -d reaper` et `check-reaper.sh`.
5. Fichier privé du runner pour la vérification de sortie : y recopier `SIRIUS_FAST_FINALITY=true`, `SIRIUS_FAST_FINALITY_MAX_USDC=25`, `SIRIUS_FAST_FINALITY_CONFIRMATIONS=30`.
6. `pnpm ops:check-release --network=mainnet .ops/mainnet/next.env .ops/mainnet/reaper.env .ops/mainnet/runner.env` (étape 11 de [19](19-mise-en-production.md)) : `configurationReady: true`, aucun `divergence.SIRIUS_FAST_FINALITY*`.
7. Redéployer Next (relancer le job Vercel ou pousser sur `main` selon la procédure en vigueur).

**Vérifier** : logs Vercel au démarrage : `[sirius] finalité rapide active : prêts ≤ 25 (plafond en cours 100), 30 confirmations` ; reaper démarré sans `Reaper mainnet refusé` ; le rapport de budget attesté (`pnpm ops:runner-monitor …`) passe avec le nouveau hash.

### 5. Rouvrir et tester

**Qui** : Ali et Noé, wallets d'équipe.

1. Retirer `SIRIUS_ADMISSIONS_CLOSED` (ou `false`), redéployer.
2. Prêt de test **≤ 25 USDG** : après le lock, la page Train affiche « Confirmation du paiement : ~N s » et l'entraînement démarre seul en quelques secondes ; le règlement passe en SETTLED et le modèle se télécharge sans attendre un quart d'heure. En base : `finalityTier = 'FAST'`.
3. Prêt de test **> 25 USDG** (si le plafond de la bêta le permet) : la page affiche les minutes, comportement historique, `finalityTier = 'FULL'`.
4. Quinze à vingt minutes après le règlement rapide : le reaper journalise `[reaper] prêt EVM <id> : release rapide confirmé à finalité complète` et `finalityVerifiedAt` est renseigné.

**Vérifier** : aucune ligne `[reaper] ALERTE finalité rapide` ; `check-reaper.sh` vert.

## Retour arrière

| Niveau | Geste | Effet | Délai |
|---|---|---|---|
| Désactiver (recommandé en premier) | Vercel et `.env.vps` : `SIRIUS_FAST_FINALITY=false` ; redéployer Next, `up -d reaper` | Plus aucun prêt ne demande le palier rapide, y compris ceux déjà marqués FAST (ils attendent le bloc finalisé). L'enclave garde ses constantes : inoffensives tant que Next ne demande rien. Les releases rapides déjà réglés restent revérifiés par le reaper | minutes, aucune CVM |
| Resserrer | Baisser `SIRIUS_FAST_FINALITY_TOTAL_USDC` ou `SIRIUS_FAST_FINALITY_MAX_USDC` sur Next et le reaper | Moins de prêts admis en rapide ; `MAX_USDC` côté Next ne peut qu'être **≤** à celui du Compose pour rester cohérent (l'enclave refuserait sinon le surplus, `release-check` refuse déjà la divergence) | minutes |
| Retirer de l'enclave | Étapes 1 à 4 avec l'ancien `active.compose.json`, ré-épingler l'ancien hash | Compose sans les constantes : la CVM refuse tout palier rapide, quoi que demande Next (`Finalité rapide désactivée pour ce rôle`) | une heure |

Ne jamais retirer `SIRIUS_EXPECTED_COMPOSE_HASH` ni laisser Next et le reaper sur deux hashes différents : l'un des deux refuserait l'enclave.

## Alerte : `[reaper] ALERTE finalité rapide`

Le reaper a revérifié un release rapide sous le bloc finalisé et la chaîne le contredit. Il a posé `Loan.finalityReview` (motif) et `finalityReviewAt`, compté une erreur dans sa passe (visible dans le battement `erreurs=`), et le prêt est **gelé** : plus de livraison de clé (`POST /api/loans/[id]/key` répond 409 « Règlement en cours de revue »), plus de certificat. Le statut reste SETTLED : le modèle peut déjà avoir été livré, rien n'est annulé ni retenté automatiquement.

| Motif | Ce qui s'est passé | Décision |
|---|---|---|
| `release disparu après réorganisation : escrow encore verrouillé` | Le release a été réorganisé hors de la chaîne et n'a pas été réinclus ; le fournisseur n'a pas été payé, l'emprunteur a peut-être le modèle | Avant l'échéance : le registre du runner tient la transaction pour réussie, il ne la renverra pas seul ; rouvrir l'opération dans le registre (intervention sur le volume `runner_budget`, runbook 1) pour qu'un `settle` relance le release, ou laisser l'échéance passer et l'emprunteur se rembourser. Montant en jeu ≤ 25 USDG : perte acceptée si aucune des deux voies n'aboutit |
| `bloc du release réorganisé après le règlement rapide` | Le reçu existe mais son bloc n'est plus canonique ; vérifier sur l'explorateur si la transaction a été réincluse ailleurs | Si réincluse et escrow libéré : clore la revue (ci-dessous). Sinon, comme la ligne précédente |
| `release finalisé mais escrow non libéré on-chain (…)` | Incohérence entre le reçu et l'état du contrat : ne devrait pas arriver | Vérifier le RPC (archive, bonne chaîne) ; si confirmé, arrêter les admissions et ouvrir une analyse, runbook 1 |
| `release introuvable mais escrow libéré par une autre transaction` | Le fournisseur a été payé par un autre release (reprise, remplacement de frais) | Vérifier la transaction sur l'explorateur, puis clore la revue en corrigeant `settleTxHash` |

Clore une revue, une fois la décision prise et consignée : `UPDATE "Loan" SET "finalityReview" = NULL, "finalityVerifiedAt" = now() WHERE id = '<id>' AND "finalityReview" IS NOT NULL;` (livraison et certificat redeviennent possibles). Si la finalité rapide est suspectée, désactiver d'abord (retour arrière, niveau 1).

## Risques résiduels, assumés

- Réorganisation de plus de 30 blocs L2 après un règlement rapide : le modèle est livré, le release peut disparaître ; borné à 25 USDG par prêt et 100 USDG en cours ; détecté par le reaper, jamais réparé seul.
- Le lock lu par l'enclave à tête − 29 n'a pas de reçu à comparer (seul Next relit le reçu du lock) : une réorganisation du lock pendant l'entraînement produirait un modèle pour un escrow disparu ; l'enclave ne livre la clé qu'après un release confirmé, donc rien ne sort sans paiement.
- La somme des prêts rapides en cours est celle de la base : un prêt rapide dont la ligne serait perdue ne compterait plus. La transaction sérialisable couvre la concurrence, pas l'incohérence base/chaîne, déjà couverte par le reaper.
- Le palier est annoncé à l'affichage (`GET …/finality`) avant d'être décidé au lancement : si le plafond se remplit entre les deux, la page repasse en minutes à la lecture suivante.
