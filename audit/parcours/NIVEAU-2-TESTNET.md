# Niveau 2 : le même parcours sur le testnet Robinhood (46630) avec la CVM staging

État : **procédure seulement, rien n'a été exécuté.** Aucun wallet créé, aucune transaction, aucune session Phala.
Le niveau 1 (`audit/parcours/gbdt-flow.test.ts`) prouve la logique sur une chaîne locale avec une enclave simulée.
Le niveau 2 ajoute ce que le local ne peut pas prouver : l'exécution dans l'enclave Intel TDX, la quote
`UpToDate`, le certificat vérifié, la finalité réelle du testnet et les vrais délais.

Qui fait quoi : **Ali ou Noé** créent les wallets, signent, ouvrent et ferment la session Phala.
Un agent peut préparer les fichiers et lire la chaîne, jamais signer ni toucher à la CVM.

## 0. Bloquants à lever avant de commencer

| # | Bloquant | Où c'est décrit | Contrôle |
|---|---|---|---|
| P1 | L'escrow staging actuel `0x5f9d…5f6c` est lié au registre **v4**, qui n'accepte pas le profil arbres. Il faut le registre **v5** et un nouvel escrow v7 (même signataire Phala `0x3b31…c8d`), avec `addTrainingProfile(gradient_boosted_trees)`. | `docs/GBDT-PHASE2.md` §3, étapes B2 à B4 | `isSupportedTrainingProfile(0xebbb…0a5c)` vrai ; `datasets.escrow() == escrow` ; `accounting() = (0,0,0,…)` |
| P2 | La CVM doit tourner en **mode facturé v7 staging** (devis, lock, règlement). La CVM de démonstration refuse les prêts : la session B de `GBDT-PHASE2.md` ne teste que le self-train. | `docs/PHALA-V7-STAGING.md`, `docs/GBDT-PHASE2.md` §8 | `/operations/budget` : `check.canQuote` vrai, `tariff.profiles` contient `gradient_boosted_trees` |
| P3 | Image runner avec le code arbres, Compose rendu avec `--opt-in-models=gradient_boosted_trees` (en clair, donc couvert par le hash attesté). | `docs/GBDT-PHASE2.md` B7 | hash `tcb_info.app_compose` **relu** dans l'attestation, pas supposé |
| P4 | Politique de budget `trial` : les **trois nouveaux wallets** doivent être dans `trial.wallets`, sinon le runner refuse leurs devis et leurs calculs (`assertTrialSubject`). Ajout par `add-trial-wallets` en maintenance. | `docs/PHALA-TRIAL-CREDITS.md`, « Liste des wallets » | rapport `/operations/budget` après redémarrage |
| P5 | Budget runner encore ouvert. Le relevé du 19 octobre donnait le **dernier devis possible le 2026-10-23 à 14:07 UTC** et la fin du budget le 2026-10-26 à 14:12 UTC. Sans prolongation (session A), aucun devis. | `docs/GBDT-PHASE2.md` §2 | `quotesUntilMs` dans le futur |
| P6 | Marge du budget : chaque devis réserve 2 × `maxTransactionWei` (convertis en USD au plafond `ethUsdMicrosUpperBound`) jusqu'à son expiration. En local, une enveloppe de 1 000 USD avec 0,01 ETH × 5 000 USD par transaction s'est épuisée après une dizaine de devis (« Budget runner insuffisant »). L'enveloppe d'essai staging était de 5 USD dont 4,02 de réserve fixe. | `src/lib/runner/budget-ledger.ts` (`workflowAllocation`) | `remainingUsd` et `remainingWei` ≥ 7 réservations (nombre de devis du §3) |
| P7 | RPC **archive** testnet dans Next, reaper et runner (sinon `matchesScope` au bloc finalisé échoue). | `docs/PHALA-V7-STAGING.md` | `pnpm phala:check-v7` → `chainChecksPassed: true` |
| P8 | Vercel staging reconstruit avec les nouvelles adresses, `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS=gradient_boosted_trees`, `SIRIUS_BILLING_POLICY_JSON` avec le profil arbres ; reaper basculé dans la même fenêtre. | `docs/GBDT-PHASE2.md` §7 | page publication : le profil « arbres boostés » est proposé |

Ordre imposé par le code (constat PAR-06 du rapport) : **profil on-chain, puis tarif, puis interrupteur.**
Interrupteur allumé avant le profil : toute publication et tout prêt sont refusés (503), linéaire et logistique compris.

Limite propre au testnet : le KYB staging est le **registre ouvert** (`SiriusOpenKybRegistry`, tout le monde est valide).
Les contrôles KYB du niveau 1 (« lock sans KYB », « mint sans KYB ») ne sont donc pas rejouables ici.

## 1. Les trois wallets de test neufs

Ali ou Noé les créent, sur leur poste, dans un profil de navigateur dédié ou avec `cast wallet new`.
Les clés restent chez eux : jamais dans le chat, Git, Vercel ni un fichier du dépôt. Seules les adresses circulent.

| Wallet | Rôle | ETH testnet | USDC testnet (18 décimales, `0x1d6c…0213`) |
|---|---|---|---|
| W1 | fournisseur | 0,001 ETH | 0 |
| W2 | acheteur | 0,001 ETH | 3 × total d'un prêt (prix + compute du tarif) + 1 USDC de marge |
| W3 | attaquant, puis second acheteur du test simultané | 0,001 ETH | 2 × total d'un prêt + 1 USDC |

- 0,001 ETH par wallet couvre largement le gas : en local, l'acheteur a dépensé 1,92 M gas en 11 transactions (≈ 0,000019 ETH à 0,01 gwei).
- USDC et ETH testnet : faucet de l'application staging (compte faucet `0x586B…0ed8`). Quota par jour : **NON VÉRIFIÉ**.
- Compte de règlement Phala `0x3b31…c8d` : il paie le gas des `release` et `recordExecution` (≈ 150 000 gas chacun). Vérifier ≥ 0,001 ETH.
- Trésorerie compute (`SIRIUS_COMPUTE_RECIPIENT`) : lire son crédit avant et après, elle reçoit le compute et les retenues.

Montants conseillés : prix du dataset **1 USDC**. Le compute vient du tarif installé (proposition : arbres = logistique).
Lire le total exact sur le devis affiché, ne pas le supposer.

## 2. Données

Mêmes données qu'au niveau 1, sur le poste d'Ali ou de Noé :

```bash
node --import tsx audit/parcours/export-taiwan.ts ./parcours-csv
# taiwan-30000.csv 2698182 octets sha256 952104664a60b6bb1a5bfc27de44de12c13d55cd9e43ce81d8ea0616bf884be8
# taiwan-9999.csv   895598 octets sha256 48d779f6457a98e064ab0534d3f2523749f403cc867e08161974c0474b2186b6
```

Résultat attendu, **identique au niveau 1** : l'entraînement est déterministe (aucun tirage aléatoire),
donc l'enclave doit livrer exactement `heldOutAuc 0.786757`, `heldOutAccuracy 0.822167`,
`heldOutPrecision 0.70317`, `heldOutRecall 0.361749`, `heldOutF1 0.477729`, `trainAuc 0.788766`, `n 30000`, 150 arbres.
Un écart signale une image ou un code différents.

## 3. Ordre des étapes

Avant **et** après chaque étape : relevé `ops:testnet-evidence snapshot` (lecture seule) puis `diff`,
comme dans `docs/TESTNET-RUN-KIT.md`. Comptes suivis : `provider:W1,borrower:W2,attaquant:W3,recipient:<trésorerie>,runner:0x3b31…c8d`.
Escrow : la nouvelle adresse v7. Attendre le bloc stable avant le relevé « après ».

Les refus de l'attaquant se testent par **simulation `eth_call`** (gratuite, aucune transaction) :
`cast call --from <W3> <contrat> "<fonction>" <args> --rpc-url <archive>` doit renvoyer l'erreur nommée.

| # | Qui | Action | Vérification (attendu) |
|---|---|---|---|
| 1 | lecture | Relevé initial | escrow `accounting()` = 0 ; profil arbres supporté ; événement `TrainingProfileAdded(0xebbb…0a5c)` présent |
| 2 | W3 | simulation `addTrainingProfile(0x…)` sur le registre | `NotAdmin` |
| 3 | W1 | Publier `taiwan-9999.csv`, profil arbres | refus dans le navigateur : « Les arbres boostés demandent au moins 10 000 lignes ; utilise la régression logistique pour ce fichier. » ; aucun mint |
| 4 | W1 | Publier `taiwan-30000.csv`, profil arbres, prix 1 USDC | runner : `rowCount 30000` ; mint : événement `DatasetMinted` avec `trainingProfile = 0xebbb…0a5c` |
| — | Noé | **Ouvrir la session Phala** (attestation, pins, `/operations/budget`) | quote `UpToDate`, hash Compose relu, `canQuote` vrai |
| 5 | W2 | Emprunter : devis, `approve` du total exact, `lock` | diff : W2 −total ; escrow `locked` +total ; `LoanLocked` ; prêt `Locked` (1) |
| 6 | W3 | simulations sur le prêt de W2 : `refund` (avant échéance), `release` avec un faux préimage, `lock` avec les termes et l'autorisation de W2 copiés depuis la transaction de lock (visibles sur l'explorateur) | `ChallengePeriodActive`, `InvalidPreimage`, `InvalidLockAuthorization` |
| 7 | runner | Calcul dans l'enclave, puis `release` | `LoanReleased` ; crédit W1 +prix ; crédit trésorerie +compute ; prêt `Released` (2) ; mesurer durée du calcul et attente de finalité |
| 8 | W2 | Télécharger le modèle | métriques identiques au §2 ; l'AUC recalculée par la page d'évaluation sur le jeu de test correspond |
| 9 | W3 | simulations : `release` du prêt réglé avec le préimage public ; `refund` du prêt réglé ; `withdraw` | `LoanNotLocked`, `LoanNotLocked`, `NothingToWithdraw` |
| 10 | public | Page `/certificate/<loanId>` | verdict « vérifié » : quote TDX valide, `report_data` = SHA-256 du payload, RTMR3 rejoué, Compose attendu. **C'est la preuve que le niveau 1 ne peut pas apporter.** |
| 11 | W1, trésorerie | Retraits | W1 USDC +prix ; crédit 0 |
| 12 | W2 et W3 | Le même dataset emprunté **en même temps** (deux navigateurs, clic simultané) | deux prêts réglés. Constat PAR-02 : le second règlement peut échouer une fois (« Transaction du wallet runner encore incertaine ») puis être repris par le reaper ou l'acheteur. Noter le délai |
| 13 | W2 | Prêt « échéance » : `lock`, puis **fermer la session Phala avant le calcul** | prêt `Locked` ; aucune lecture du dataset |
| — | Noé | **Fermer la session Phala** (drainage, arrêt confirmé par l'API) | coût relevé |
| 14 | W3 | Après l'échéance (3 jours en staging, `ESCROW_CHALLENGE_DAYS`) : `refund` du prêt de W2 (vraie transaction, permissionless) | `LoanRefunded(refundAmount = total, retainedFee = 0)` ; crédit **W2** +total ; W3 ne gagne rien |
| 15 | W3 | `withdrawFor(W2)` | les USDC partent vers W2, jamais vers W3 |
| 16 | lecture | Relevé final et `ops:reconcile` | escrow : `locked = 0`, `owed = 0`, solde USDC 0 ; aucun écart comptable |

Hors périmètre du niveau 2, testés seulement au niveau 1 :

- **Échec du calcul (CSV invalide)** : impossible depuis l'interface, l'ingestion refuse un tel fichier.
  Au niveau 1, le remboursement est **immédiat** (statut `Failed`, 4), moins une retenue bornée par `maxFailureFee`.
- **Interrupteur coupé après un lock** : il faudrait un nouveau Compose, donc une nouvelle attestation.
  Au niveau 1, les fonds restent verrouillés jusqu'à l'échéance (constat PAR-01).
- **Plafonds de la bêta** : facultatifs sur testnet. Pour les tester, poser `SIRIUS_MAX_LOAN_USDC` et `SIRIUS_MAX_EXPOSURE_USDC` sur Vercel staging (rebuild).
  Attendu : refus « plafond par prêt » ou « Plafond d’exposition totale », aucun débit.

## 4. Coût estimé

| Poste | Estimation | Source |
|---|---|---|
| Phala, session de calcul | 0,060780 USD/h (compute 0,058 + disque 0,00278). Session de 45 min : **≈ 0,046 USD**. Avec une seconde ouverture pour le test simultané : ≈ 0,09 USD | relevé API du 25 septembre (`docs/PHALA-V7-STAGING.md`), **à relever de nouveau** |
| Phala, disque à l'arrêt | ≈ 2,00 USD par 30 jours, payé même sans session | idem |
| Calcul arbres dans l'enclave | 3,7 à 4,6 s pour 30 000 lignes sur WSL (16 cœurs) ; en `tdx.small` **NON VÉRIFIÉ**. Doit rester sous `maxExecutionMs` du tarif (≤ 30 s) | niveau 1 |
| Gas testnet, déploiement registre v5 + escrow v7 | ≈ 3,73 M gas, soit 0,0000373 ETH à 0,01 gwei | `docs/GBDT-PHASE2.md` §3 |
| Gas testnet, parcours | lock 286 945 à 355 389 gas, release 101 415 à 143 115, recordExecution 122 885 à 157 085, refund 58 889 à 68 489, withdraw 47 436 à 68 795. Les 46 transactions du niveau 1 (déploiements compris) font 10,09 M gas, soit ≈ 0,0001 ETH à 0,01 gwei | niveau 1 |
| Crédits Phala disponibles | 14,695217 USD accordés au 25 septembre | `docs/PHALA-TRIAL-CREDITS.md`, **à relever** |

## 5. Arrêt immédiat si

- l'attestation, le hash Compose ou le tarif ne correspondent pas à ce qui a été relu ;
- les métriques du §2 diffèrent : image ou code différents ;
- un relevé montre un mouvement non attendu sur un compte suivi ;
- la session dépasse 45 minutes.

Fermer alors la session normalement, puis analyser hors session.
Ne jamais réinitialiser un volume ni un registre pour réessayer.

## 6. Ce que ce niveau ne prouvera toujours pas

- Le comportement sous charge réelle : deux acheteurs, ce n'est pas un pic de trafic.
- La mémoire du worker dans la CVM : `public_sysinfo` est désactivé. Seul indice : aucun arrêt du worker ni du conteneur.
- La sécurité du mainnet : autre KYB (réel), plafonds obligatoires, multisig de gouvernance comme admin du registre.
