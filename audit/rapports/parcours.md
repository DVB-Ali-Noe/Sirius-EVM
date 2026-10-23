# Audit du parcours Sirius avec les arbres boostés (chaîne locale)

- Base auditée : `origin/staging` au commit **`f31a917bf48a51d8d8505b8a50cde9ed0a353853`** (fusion de la PR #124), branche `audit/parcours`.
- Date : 23 octobre 2026.
- Environnement d'exécution : Ubuntu sous WSL 2 (Node 22.23.2, pnpm 11.18.0), copie du dépôt dans le système de fichiers Linux.

> **Limite à lire d'abord.** Sur la chaîne locale, l'enclave Intel TDX est **SIMULÉE** : le runner tourne en mode
> local (`TEE_MODE=stub`), dans le même processus que le test. Le test prouve la logique : contrats, paiements,
> modèle, livraison chiffrée. Il ne prouve **pas** l'attestation matérielle (quote TDX, RTMR3, hash du Compose).
> Le certificat produit est donc « prêt » mais sa vérification matérielle rend `absent`. C'est le niveau 2
> (`audit/parcours/NIVEAU-2-TESTNET.md`) qui couvre cette partie.

## 1. Point de départ : `pnpm test:billing` tel quel

| Où | Résultat |
|---|---|
| Windows 11, PowerShell, Node 22.16.0 | **Échec.** `'NODE_OPTIONS' n'est pas reconnu en tant que commande interne` (le script passe par `cmd.exe`). Lancé à la main depuis Git Bash : `Répertoire privé requis pour le budget runner` (contrôle des droits POSIX). Voir PAR-05. |
| Windows, première installation | `pnpm install` finit en erreur : `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`, puis chaque `pnpm <script>` relance l'installation et échoue. Voir PAR-04. |
| Linux (WSL Ubuntu), `DATABASE_URL` factice | **Réussi** : 1 test, 1 passé, 22,2 s pour le test (29 s avec la compilation des contrats). |

## 2. Ce qui a été construit

Une seule commande, depuis la racine du dépôt, sous Linux, macOS ou WSL :

```bash
sh audit/parcours/run.sh
```

Elle compile les contrats puis lance `audit/parcours/gbdt-flow.test.ts`. Sous Windows : `sh audit/parcours/wsl-run.sh` depuis WSL
(copie dans le système de fichiers Linux, installation, puis la même commande).

Le test :

1. lance son propre nœud Hardhat (chainId 46630, comme le testnet), sur un port libre ;
2. génère des wallets **jetables** à clés aléatoires : admin, fournisseur, acheteur, attaquant, plus un second acheteur
   (test simultané) et une trésorerie (reçoit les frais de calcul). La clé du runner dérive d'une clé maîtresse
   aléatoire, jetable elle aussi. ETH local par `hardhat_setBalance`, stablecoin par `mint` ;
3. déploie le stablecoin de test (`SiriusTestUsdc`, 18 décimales), le **vrai** registre KYB (`SiriusKybRegistry`, pas le registre ouvert),
   le registre de datasets v5 et l'escrow v7, puis lie le registre à l'escrow ;
4. coupe tout réseau externe : une requête vers autre chose que le nœud local ou l'IPFS simulé lève une erreur et est comptée.
   Le compteur vaut 0 à la fin. Seul le téléchargement des données OpenML a lieu avant ce verrou ;
5. utilise les données publiques **OpenML 42477 (Taïwan)** : 30 000 lignes, 23 variables, 2 698 182 octets, MD5 vérifié.
   Repli automatique sur `public/examples/classification/credit-risk.csv` si OpenML est injoignable (testé aussi, il passe) ;
6. compare **à chaque étape** les soldes USDC et les crédits d'escrow de toutes les parties à une comptabilité attendue,
   à l'unité près, plus `accounting()` de l'escrow (verrouillé, dû, solde) ;
7. relève chaque transaction (gas, coût, rôle, fonction) et écrit les mesures dans un JSON (`SIRIUS_AUDIT_REPORT_FILE`).

Le test est passé **6 fois de suite** sur la version livrée (3 avec Taïwan, 3 avec le repli credit-risk). `tsc` et `eslint` ne signalent rien sur `audit/`.

## 3. Constats

Aucun constat critique ni haut. Les fonds ne sont jamais perdus ni détournés, l'attaquant ne gagne rien,
et le modèle ne s'ouvre qu'avec la clé de l'acheteur.

| ID | Sévérité | Fichier:ligne | Ce qui se passe | Comment le reproduire | Correction proposée |
|---|---|---|---|---|---|
| PAR-01 | Moyenne | `src/runner/handler.ts:131-134` (`trainingModel`, appelé par `run-loan-job` l. 269) | Si l'interrupteur arbres (`NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`) est coupé **après** qu'un acheteur a verrouillé ses fonds, le runner refuse le calcul avant toute mesure. Il n'y a alors aucune preuve d'échec, donc pas de remboursement immédiat : l'acheteur attend l'échéance (1 à 30 jours, 3 en staging) puis doit appeler `refund` lui-même. Le retour arrière « Interrupteur seul » de `docs/GBDT-PHASE2.md` §9 ne le signale pas. | `sh audit/parcours/run.sh`, étape « 6c. flag arbres coupé » : prêt `flag-coupe-apres` resté `Locked`, remboursé en entier seulement après `evm_increaseTime(86401)`. | Faire porter l'interrupteur sur les **nouveaux** devis et dépôts seulement (`prepare-escrow-lock`, `seal-dataset`) et laisser `run-loan-job` exécuter un prêt déjà verrouillé avec un devis signé. À défaut : ajouter au runbook « vider les prêts arbres ouverts avant de couper l'interrupteur ». |
| PAR-02 | Moyenne | `src/lib/runner/budget-ledger.ts:413`, `src/lib/sirius/settle.ts:410-420` | Deux règlements simultanés (deux acheteurs du même dataset) : le second est refusé avec `Transaction du wallet runner encore incertaine` (503). Le prêt revient en `TRAINING` ; le reaper ou l'acheteur le reprennent ensuite. Aucun fonds perdu, mais l'acheteur voit une erreur et attend. Reproduit à chaque exécution. | `sh audit/parcours/run.sh`, étape 8 : la ligne `[parcours] règlements simultanés refusés puis rejoués` s'affiche ; le second règlement passe au second essai. | Mettre les règlements en file d'attente côté runner (un seul wallet, nonces séquentiels) au lieu de les refuser, ou relancer automatiquement côté Next avec un délai court. Afficher un message « règlement en cours » plutôt qu'une erreur. |
| PAR-03 | Moyenne | `src/app/docs/page.tsx:333`, `:343`, `:383`, `:388` | La documentation publique décrit l'escrow d'avant v7 : « Locked, puis Released ou Refunded », « refund crédite uniquement le borrower », « pas de frais », « utilise SiriusEscrow v5 et SiriusDatasetRegistry v4 ». En v7, il existe un état **Failed** (4), le release verse aussi le compute à la trésorerie, un échec retient des frais de calcul, et le profil arbres exige le registre v5. | Étapes 5 et 6a du test : statut on-chain 4, événements `CreditAccrued` vers la trésorerie au release et à l'échec. Comparer avec la page `/docs`. | Mettre à jour les quatre passages (et leurs traductions l. 83, 92, 115, 119) : états Locked / Released / Refunded / Failed, part compute, retenue bornée par `maxFailureFee`, versions v7 / v5. |
| PAR-04 | Moyenne | `README.md:64-65`, `prisma.config.ts:1` et `:10` | L'installation du README échoue sur un clone neuf : `pnpm install` lance `prisma generate`, qui exige `DATABASE_URL`. Le README fait copier `.env.example` vers `.env.local` **après** l'installation, et `prisma.config.ts` ne lit que `.env` (`dotenv/config`). Ensuite, chaque `pnpm <script>` relance l'installation et échoue. | Clone neuf sans `.env` : `npx -y pnpm@11.18.0 install` → `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`, puis `npx -y pnpm@11.18.0 test:billing` → même erreur. | Dans le README : créer `.env` (ou exporter `DATABASE_URL`) avant `pnpm install`. Ou rendre l'URL facultative pour `prisma generate` (valeur de repli dans `prisma.config.ts`). |
| PAR-05 | Basse | `package.json:40` (`test:billing`), `src/lib/runner/budget-ledger.ts:134-137` | Les tests runner ne tournent pas sous Windows : les scripts `pnpm` passent par `cmd.exe`, qui ne comprend pas `NODE_OPTIONS=…`, et le budget runner exige un dossier en droits POSIX `0700`, invérifiable sur NTFS. | Windows : `npx -y pnpm@11.18.0 test:billing` ; puis, dans Git Bash, `NODE_OPTIONS=--conditions=react-server node --import tsx --test src/lib/billing/flow.test.ts`. | Documenter « Linux, macOS ou WSL » pour les tests (ce que fait `audit/parcours/wsl-run.sh`), ou passer par `cross-env` dans `package.json`. Ne pas assouplir le contrôle de droits en production. |
| PAR-06 | Basse | `src/lib/evm/deployment.ts:48-53` | Interrupteur arbres allumé avant `addTrainingProfile` : `requireCurrentEvmDeployment` refuse **tout** (503), publications et prêts linéaires ou logistiques compris. Le blocage est volontaire (il évite de sceller un fichier avant un mint refusé), mais une erreur d'ordre coupe tout le service. | Étape 3 : `requireCurrentEvmDeployment()` rejette avec « un profil d’entraînement proposé n’est pas accepté on-chain », puis passe après `addTrainingProfile`. | Écrire l'ordre dans le runbook : profil on-chain, puis tarif, puis interrupteur. Dans le message d'erreur, nommer le profil manquant. |
| PAR-07 | Basse | `src/lib/models/registry.ts:4-6`, `src/runner/handler.ts:198-236` | Le commentaire dit que, sans tarif pour le profil, « le mint échoue ». C'est faux : sans tarif arbres, le dépôt chiffré et le mint réussissent, et seuls les devis échouent (« Tarif compute absent »). Un fournisseur peut donc publier un dataset arbres que personne ne peut emprunter. | Étape 6c : dépôt `taiwan-sans-tarif` accepté, mint réussi, devis refusé. | Refuser `seal-dataset` quand le tarif ne couvre pas le profil (le runner a déjà le tarif en main), ou corriger le commentaire. |
| PAR-08 | Basse | `src/lib/sirius/borrower.ts:56-57` et `:131-141`, `src/lib/runner/budget-ledger.ts:804-822` | Plafond par prêt : Next vérifie d'abord le prix du dataset, appelle le runner, puis vérifie le total du devis. Quand prix ≤ plafond < total, le runner a déjà signé un devis et réservé 2 × `maxTransactionWei` (20 000 000 000 000 000 wei mesurés) jusqu'à l'expiration du devis. Rien n'est débité, mais la réservation pèse sur le budget du runner. | Étape 9, cas B : plafond 6 USDC, prix 5, total 7 → refus « plafond par prêt », ligne supprimée, réservation restante relevée dans le JSON (`plafonds`). | Vérifier prix + compute (Next connaît le tarif par `SIRIUS_BILLING_POLICY_JSON`) avant d'appeler le runner. |
| PAR-09 | Basse | `src/runner/handler.ts:238-266`, `src/lib/billing/runner.ts:69-112` | Le runner signe un devis sans contrôler ni les plafonds de la bêta ni le KYB : ces contrôles ne vivent que dans Next. Le contrat refuse le KYB manquant (vérifié), mais n'a aucun plafond. Si Next est contourné ou défaillant, rien ne borne le montant d'un prêt. | Étape 7 : devis signé pour l'attaquant sans KYB (le lock est ensuite refusé `KybRequired`). Le devis est signé quel que soit le montant. | Recopier le plafond par prêt dans l'environnement attesté du runner, comme `SIRIUS_FAST_FINALITY_TOTAL_USDC`, et le vérifier dans `prepareComputeQuote`. |

Décompte : **0 critique, 0 haute, 4 moyennes, 5 basses.**

## 4. Tests ajoutés

| Fichier | Rôle |
|---|---|
| `audit/parcours/gbdt-flow.test.ts` | Le parcours complet (ci-dessous) |
| `audit/parcours/datasets.ts` | Téléchargement OpenML 42477 avec contrôle MD5, cache dans le dossier temporaire, repli credit-risk |
| `audit/parcours/run.sh` | Commande unique : compilation des contrats et lancement du test |
| `audit/parcours/wsl-run.sh` | Même chose depuis Windows, dans WSL |
| `audit/parcours/export-taiwan.ts` | Écrit les CSV du niveau 2 (30 000 et 9 999 lignes) avec leur SHA-256 |
| `audit/parcours/NIVEAU-2-TESTNET.md` | Procédure testnet 46630 + CVM staging, non exécutée |

Étapes couvertes par `gbdt-flow.test.ts` :

1. **Déploiement** : USDC de test, KYB réel, registre v5, escrow v7 ; événement `EscrowBound` ; versions lues ; `lockAuthorizer` = runner.
2. **Financement et KYB** : 100 USDC aux acheteurs et à l'attaquant ; attestations KYB signées EIP-712 par l'admin vérificateur ; événements `KybAttested`.
3. **Profil arbres** : déploiement refusé tant que le profil manque ; `addTrainingProfile` refusé à l'attaquant (`NotAdmin`) ; mint arbres refusé avant ajout (`InvalidTrainingProfile`) ; ajout par l'admin, événement `TrainingProfileAdded(0xebbb…0a5c)` ; second ajout sans événement.
4. **Publication** : dépôt chiffré pour le runner (enveloppe d'ingestion), scellé, épinglé sur l'IPFS simulé ; le blob ne contient aucune ligne en clair ; mint avec le profil arbres, événement `DatasetMinted` contrôlé champ par champ ; 9 999 lignes refusées avec le message exact ; dépôt refusé interrupteur coupé ; aucun blob épinglé pour un refus.
5. **Parcours nominal** : devis (dataset 5, compute 2, retenue max 0,5, 30 s), devis idempotent, `approve` + `lock` (événement `LoanLocked`, transfert unique acheteur → escrow de 7), entraînement des arbres dans le worker borné, aucune capsule avant règlement, rejeu du grant refusé, clé refusée avant règlement, `release` par le runner (événements `LoanReleased`, `PreimageRevealed`, deux `CreditAccrued`), double règlement sans nouvelle transaction, livraison de la clé chiffrée pour l'acheteur, modèle déchiffré et validé (150 arbres, 23 variables), métriques **recalculées** par l'acheteur sur la part tenue à l'écart, certificat résolu, retraits.
6. **Échecs** : CSV invalide (cible hors 0/1, scellé hors ingestion), 9 999 lignes scellées hors ingestion, interrupteur coupé avant devis, interrupteur coupé après lock, tarif arbres absent.
7. **Attaquant** : lock sans KYB, profils non supportés, autorisations modifiées ou rejouées, calcul lancé sur le prêt d'un autre ; tout est refusé (détail au §5).
8. **Deux acheteurs simultanés** sur le même dataset : devis, locks, calculs et règlements en parallèle.
9. **Plafonds de la bêta** par `prepareLoan` (le vrai code Next) sur une base simulée en mémoire et sérialisée.
10. **Échéance** : `release` refusé après l'échéance même avec le bon préimage, autorisation expirée refusée, remboursements déclenchés par l'attaquant au profit des acheteurs, retraits finaux, escrow vide.

## 5. Résultats

### Modèle livré (Taïwan, 30 000 lignes)

| Mesure | Valeur livrée | Recalculée par l'acheteur |
|---|---|---|
| AUC held-out | 0,786757 | 0,786757 |
| Accuracy held-out | 0,822167 | 0,822167 |
| Précision / rappel / F1 held-out | 0,70317 / 0,361749 / 0,477729 | — |
| AUC d'entraînement | 0,788766 | — |
| n | 30 000 | — |

Plausible : la référence du code est une AUC de 0,787 sur Taïwan. L'accuracy dépasse la classe majoritaire (≈ 0,78).
L'écart entre entraînement et held-out est de 0,002, sans signe de mémorisation. Les deux acheteurs simultanés
reçoivent exactement le même modèle (entraînement déterministe), chiffré sous deux clés différentes ;
aucun n'ouvre le modèle de l'autre.

### Soldes (USDC, au millionième ; chaque ligne est comparée à la chaîne à l'unité près, en wei de 18 décimales)

| Étape | Acheteur | Acheteur 2 | Fournisseur | Attaquant | Trésorerie | Escrow |
|---|---|---|---|---|---|---|
| Après financement | 100 | 100 | 0 | 100 | 0 | 0 |
| Lock nominal (7) | 93 | 100 | 0 | 100 | 0 | 7 |
| Après calcul, avant règlement | 93 | 100 | 0 | 100 | 0 | 7 (verrouillé) |
| Après règlement | 93 | 100 | crédit 5 | 100 | crédit 2 | 7 (dû) |
| Après retraits | 93 | 100 | 5 | 100 | 2 | 0 |
| CSV invalide, remboursé de suite | 86 + crédit 6,99594 | 100 | 5 | 100 | 2 + crédit 0,00406 | 7 |
| 9 999 lignes, remboursé de suite | 86 + crédit 6,99594 | 93 + crédit 6,99675 | 5 | 100 | 2 + crédit 0,00731 | 14 |
| Lock puis interrupteur coupé | 79 + crédit 6,99594 | 93 + crédit 6,99675 | 5 | 100 | 2 + crédit 0,00731 | 21 |
| Après l'attaquant | inchangé | inchangé | inchangé | **100** | inchangé | 21 |
| Deux règlements simultanés | 72 | 86 | 5 + crédit 10 | 100 | 2 + crédit 4,00731 | 35 |
| Plafonds (un lock de 7) | 65 | 86 | 5 + crédit 10 | 100 | 2 + crédit 4,00731 | 42 |
| Remboursements à l'échéance | 65 + crédit 20,99594 | 86 + crédit 6,99675 | 5 + crédit 10 | **100** | 2 + crédit 4,00731 | 42 |
| **Fin** | **85,99594** | **92,99675** | **15** | **100** | **6,00731** | **0** |

Contrôles de fin : 300 USDC créés, 300 USDC répartis, aucun créé ni perdu. Le fournisseur touche 3 × 5 pour les trois
entraînements réussis et rien pour les échecs. La trésorerie touche 3 × 2 plus les deux retenues.
Les retenues (0,00406 et 0,00325 USDC) varient d'une exécution à l'autre, car elles dépendent du temps de calcul mesuré ;
le test lit la valeur on-chain puis vérifie tous les soldes à l'unité.

**Écart avec l'énoncé :** l'échec du calcul (CSV invalide) ne rembourse pas « après l'échéance » mais **immédiatement**
(statut `Failed`, 4), moins une retenue bornée par `maxFailureFee`. Seul un prêt jamais exécuté (interrupteur coupé,
runner arrêté) attend l'échéance.

### Refus vérifiés (42)

Contrats (simulation `eth_call` au dernier bloc, nom d'erreur exact) : `NotAdmin` ×2, `InvalidTrainingProfile`,
`DatasetExists`, `KybRequired` ×2, `DatasetInUse`, `UnknownDataset`, `InvalidExecutionReceipt` (reçu forgé),
`InvalidPreimage`, `ChallengePeriodActive`, `LoanNotLocked` ×2 (double release, refund d'un prêt réglé),
`NothingToWithdraw` ×2, `InvalidDataset` ×2 (profil logistique, profil inexistant), `InvalidLockAuthorization` ×3
(montant modifié, autorisation de l'acheteur rejouée par l'attaquant, autorisation signée par l'attaquant),
`LoanExists` (autorisation rejouée par l'acheteur), `ChallengePeriodElapsed`, `LockAuthorizationExpired`.

Runner et Next : 9 999 lignes, interrupteur coupé ×3, tarif absent, grant rejoué, clé avant règlement, clé demandée par
l'attaquant (« réservée au borrower »), calcul lancé par l'attaquant sur le prêt d'un autre (« hors scope »), profil inconnu,
profil logistique sur un titre arbres (« Reçu dataset hors scope »), emprunt de son propre dataset, deux échecs de calcul
remboursés, plafond par prêt ×2, exposition totale ×2. Enveloppe de l'acheteur ouverte avec la clé de l'attaquant : échec AES-GCM.

Plafonds de la bêta : (A) plafond 4 < prix 5, refus avant tout appel au runner ; (B) plafond 6 < total 7, refus après le devis
(PAR-08) ; (C) exposition 13, deux préparations simultanées de 7, **une seule acceptée** ; (D) le prêt verrouillé compte
dans l'exposition ; (E) à 14, la demande suivante passe.

### Gas (46 transactions, Hardhat local)

| Fonction | n | Gas min | Gas max |
|---|---|---|---|
| Déploiements (USDC, KYB, registre, escrow) | 4 | 388 637 | 2 655 700 |
| `Escrow.lock` | 7 | 286 945 | 355 389 |
| `Escrow.release` (runner) | 3 | 101 415 | 143 115 |
| `Escrow.recordExecution` (runner, échec) | 2 | 122 885 | 157 085 |
| `Escrow.refund` | 2 | 58 889 | 68 489 |
| `Escrow.withdrawFor` | 6 | 47 436 | 68 795 |
| `Registre.mint` | 4 | 157 517 | 174 641 |
| `Registre.addTrainingProfile` | 2 | 24 165 (sans effet) | 45 499 |
| `Registre.bindEscrow` | 1 | 47 918 | 47 918 |
| `KYB.acceptAttestation` | 4 | 102 122 | 102 139 |
| `USDC.approve` | 8 | 46 155 | 46 155 |
| `USDC.mint` | 3 | 51 233 | 68 333 |

Par rôle : admin 12 transactions / 5,47 M gas (déploiements compris), acheteur 11 / 1,92 M, fournisseur 7 / 0,87 M,
acheteur 2 6 / 0,85 M, runner 5 / 0,64 M, attaquant 5 / 0,33 M. Total 10,09 M gas, soit ≈ 0,0001 ETH au prix
du testnet Robinhood (0,01 gwei). Le premier `lock` coûte plus que les suivants : il écrit des emplacements neufs.

### Temps

| Mesure | Valeur |
|---|---|
| Parcours complet (nœud, déploiements, 46 transactions, 3 entraînements) | 40 à 46 s selon l'exécution |
| Entraînement des arbres, 30 000 lignes, worker borné à 128 Mio | 3,7 à 4,9 s |
| Deux entraînements simultanés | 4,1 s |
| Pires cas aux bornes d'ingestion (49 999 lignes × 20 variables ; 32 000 × 31), sonde hors dépôt | 5,5 à 5,7 s, sans dépassement mémoire ; tout fichier accepté à l'ingestion s'entraîne |

## 6. Points NON VÉRIFIÉS

- **Attestation matérielle** : quote TDX, RTMR3, hash du Compose, verdict « vérifié » du certificat. Enclave simulée ici (niveau 2).
- Temps de calcul et mémoire sur une CVM Phala `tdx.small` : mesurés seulement sur WSL (16 cœurs).
- Comportement de l'interface (page Train, messages) quand le calcul est refusé interrupteur coupé (PAR-01) ou quand le règlement simultané est refusé (PAR-02).
- Reprise automatique par le reaper du règlement refusé de PAR-02 : déduite du code (`settle.ts:410-420`), non exécutée.
- Plafonds bêta avec une vraie base PostgreSQL et l'isolation sérialisable réelle : la base est simulée en mémoire et sérialisée par une file.
  Le test de concurrence PostgreSQL existant (`pnpm test:postgres`) n'a pas été lancé, faute de base.
- Exposition réelle du point d'entrée du runner en production (peut-on contourner Next ? voir PAR-09).
- Quota du faucet staging pour financer les wallets du niveau 2.
- Les autres suites (`pnpm test`, tests de contrats Hardhat, scénarios navigateur) n'ont pas été relancées.
