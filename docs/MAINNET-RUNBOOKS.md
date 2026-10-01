# Runbooks d'exploitation — bêta mainnet

Procédures à suivre pendant la bêta mainnet ouverte le 6 octobre 2026. Elles complètent le [plan de lancement](MAINNET-LAUNCH-PLAN.md) et le [journal](MAINNET-LAUNCH.md). Toute action est consignée dans le journal avec son heure et sa preuve. Aucune clé ni secret dans les messages ou les documents.

Rappels qui valent pour tous les runbooks :

- Le contrat d'escrow n'a **ni pause ni rotation** : on agit en amont (application, runner) et on laisse le contrat rembourser à l'échéance.
- **Ne jamais recréer la CVM de production** : son identité (app ID) porte la clé de règlement inscrite dans l'escrow. Redémarrer la même CVM, jamais en créer une autre pour « réparer ».
- Toute transaction mainnet est signée par un humain, après vérification de la cible.

## 1. Clé de règlement ou enclave compromise

**Signes** : release ou reçus d'exécution non initiés par le service, attestation qui ne correspond plus aux mesures épinglées, alerte du collecteur.

1. Couper les admissions : passer `SIRIUS_MAX_EXPOSURE_USDC` à une valeur inférieure à l'exposition courante sur Vercel production et redéployer. Plus aucun nouveau prêt n'est accepté.
2. Arrêter la CVM de production depuis le VPS (`sirius-phala cvms stop <cvm> --profile sirius`). Plus aucune release ni reçu ne peut être signé.
3. Publier un message sur la page d'état et sur X : admissions fermées, fonds verrouillés remboursables à l'échéance.
4. Lister les prêts verrouillés (registre d'audit, `ops:escrow-events`). À l'échéance de chacun, déclencher `refund()` (bouton Refund ou n'importe quel wallet) : les emprunteurs récupèrent leurs fonds.
5. Remplacement : nouvelle CVM, nouvel escrow lié à sa nouvelle adresse, nouveau registre datasets, republication des titres par les fournisseurs. Décision écrite à deux avant toute réouverture.

## 2. Coupe-circuit financier ouvert

**Signes** : réponses 503 « Coupe-circuit financier runner ouvert » sur publication, entraînement, prêt.

Depuis N1, seules les pannes côté runner comptent : 5xx, RPC, IPFS, exceptions techniques, revert d'une transaction signée. Une erreur d'utilisateur (4xx, grant refusé, dataset inexploitable), une attente de finalité ou un refus avant signature ne comptent plus.

1. Lire le rapport de budget attesté (`ops:runner-monitor`) : nombre d'échecs, opérations réservées ou en échec, solde ETH.
2. Identifier la cause dans le journal des opérations : RPC, IPFS, gas, revert.
3. Corriger la cause (recharger l'ETH de règlement, attendre le RPC, etc.).
4. Seulement ensuite, réarmer dans la CVM, puis consigner la cause dans le journal de lancement :

```bash
pnpm runner:budget reset-failures /var/lib/sirius-runner/budget/ledger.sqlite /var/lib/sirius-runner/budget/budget-policy.json --actor=<prénom> --reason="<cause corrigée>"
pnpm runner:budget journal /var/lib/sirius-runner/budget/ledger.sqlite /var/lib/sirius-runner/budget/budget-policy.json
```

Un règlement clos en échec (revert) peut être rouvert après vérification sur l'explorer que le prêt est toujours verrouillé. Le règlement suivant relit l'escrow avant tout envoi :

```bash
pnpm runner:budget reopen <registre> <politique> release:<chainId>:<escrow>:<loanKey> --actor=<prénom> --reason="<diagnostic>"
```

## 3. Transaction runner bloquée

**Signes** : opération `reserved` qui ne progresse plus, nouvelles transactions runner refusées, prêts bloqués en SETTLING.

Une seule transaction runner est en vol à la fois. Sur mainnet, chacune attend la finalité, soit environ 16 minutes : les autres règlements patientent sans compter d'échec. Une opération réservée de moins d'une heure n'est donc pas bloquée.

1. Lire l'opération bloquée (hash, nonce) dans le rapport du runner.
2. Comparer au nonce de l'adresse de règlement sur l'explorer (`getTransactionCount`).
3. Si la transaction est minée : laisser la réconciliation la finaliser (`pnpm runner:transactions reconcile`).
4. Si elle est introuvable : `pnpm runner:transactions rebroadcast`. Un refus du séquenceur pour frais trop bas déclenche automatiquement une re-signature au même nonce, avec des frais à jour, journalisée sous l'auteur `runner-auto`.
5. Si son nonce est déjà consommé par une autre transaction, ou si elle n'a jamais été signée, l'abandonner. La commande refuse tant que la transaction peut encore être incluse :

```bash
pnpm runner:transactions abandon <id-operation> --actor=<prénom> --reason="<diagnostic>"
```

6. Vérifier que les règlements suivants repartent.

## 4. Enclave arrêtée ou injoignable

**Signes** : attestation indisponible, erreurs de transport runner, CVM `stopped` ou `error`.

1. État de la CVM : `sirius-phala cvms get <cvm> --profile sirius`.
2. Redémarrer **la même** CVM (`cvms start`). Ne jamais en créer une nouvelle.
3. Recapturer l'attestation et vérifier : même adresse de règlement, mesures identiques aux valeurs épinglées. Si une mesure change, ne pas rouvrir : runbook 1.
4. Contrôler le rapport de budget attesté avant de considérer le service rétabli.

## 5. Reaper silencieux

**Signes** : `check-reaper.sh` en erreur, aucune ligne `[reaper] passe` depuis plusieurs minutes, prêts échus non remboursés.

1. `docker compose -p sirius --env-file .env.vps logs --tail 100 reaper` dans `/opt/sirius`.
2. Erreur de configuration au démarrage : corriger `.env.vps` (le reaper mainnet refuse une configuration incomplète).
3. Redémarrer : `docker compose -p sirius --env-file .env.vps up -d reaper`, puis relancer `check-reaper.sh`.
4. Contrôler les prêts échus restés verrouillés et déclencher les remboursements manquants.

## 6. Solde ETH de règlement bas

**Seuil d'alerte** : 0,02 ETH sur l'adresse de règlement de l'enclave. Le runner journalise aussi `[runner][alerte-eth]` avant chaque règlement quand le solde ne couvre plus cinq transactions au plafond de gas. Sous un plafond, le règlement est refusé avant signature et se relance seul une fois le solde rechargé.

1. Envoyer de l'ETH depuis le Safe ou un wallet d'équipe vers l'adresse de règlement (adresse publique dans le journal).
2. Vérifier le solde sur l'explorer et dans le rapport de budget attesté.

## Surveillance quotidienne pendant la bêta

À 12h et 20h, par la personne d'astreinte :

- rapport de budget attesté : échecs à 0, aucune opération bloquée, solde ETH au-dessus du seuil ;
- reaper : dernière ligne `[reaper] passe` de moins de deux minutes ;
- exposition verrouillée totale comparée au plafond ;
- page d'état à jour.

## Préparation de la production (N5, N6)

### Compose de la CVM de production

L'origine de l'application n'a plus de valeur par défaut hors démonstration. Pour la production :

```bash
pnpm phala:compose-v7 init ghcr.io/dvb-ali-noe/sirius-runner@sha256:<digest> /tmp/prod-init.json --origin=https://sirius-data.tech
pnpm phala:compose-v7 active ghcr.io/dvb-ali-noe/sirius-runner@sha256:<digest> /tmp/prod-active.json --origin=https://sirius-data.tech
```

Le conteneur d'initialisation reçoit `EVM_NETWORK` et n'a pas de réseau. Il vérifie la chaîne et les décimales attendues pour ce réseau : 4663 et 6 sur mainnet. Les décimales on-chain sont vérifiées avant, par `phala:preflight-v7 --network=mainnet`.

### Politiques mainnet du runner

Le code refuse une politique mainnet qui ne respecte pas ces règles :

| Champ | Règle imposée |
|---|---|
| `chainId` (budget et tarif) | 4663 |
| `usdc` | USDC natif `0x80e0…6ca8` |
| `usdcDecimals` | 6 |
| `computeRecipient` | adresse non nulle, distincte du wallet runner ; le Safe en production |
| `earnedMarginUsdMicros`, `cashUsdMicros` | strictement positifs : ni crédits d'essai ni sponsor |
| `trial`, `sponsored` | absents |

Restent à décider par Ali et Noé, avant samedi : la marge acquise, les liquidités et la réserve fixe (valeurs comptables justifiées), les coûts par requête, scellement et entraînement, et les plafonds de gas (`maxGas`, `maxFeePerGasWei`, `maxTransactionWei`, `totalWei`). Les plafonds de gas se calent sur la mesure de finalité et le prix du gas observés sur mainnet. Comme les attentes de finalité ne consomment plus de crédit, les seize requêtes par devis suffisent.

### Contrats mainnet

Toujours commencer par une exécution à blanc. Elle vérifie sur le RPC mainnet le code et les décimales de l'USDC, que l'admin KYB est bien un contrat, et n'envoie rien :

```bash
SIRIUS_DEPLOY_NETWORK=mainnet SIRIUS_ALLOW_MAINNET=true SIRIUS_BILLING_VERSION=7 SIRIUS_DEPLOY_DRY_RUN=true \
SIRIUS_USDC_ADDRESS=0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8 \
SIRIUS_USDC_CODE_HASH=0x487e3e7ba0f6ef76ccd39c373954f0edcdfe15c8817bdca4ef73f6df3963e694 \
SIRIUS_KYB_ADMIN=<Safe> SIRIUS_KYB_VERIFIER=<vérificateur 1> SIRIUS_LOCK_AUTHORIZER=<adresse attestée de la CVM> \
pnpm contracts:deploy:testnet
```

La clé de déploiement se charge sans passer par l'historique du shell, avant la commande : `read -rs ROBINHOOD_DEPLOYER_KEY && export ROBINHOOD_DEPLOYER_KEY`. Le nom du script contient « testnet » pour des raisons historiques : c'est `SIRIUS_DEPLOY_NETWORK` qui choisit le réseau.

Sur mainnet, le script refuse : la v6, le KYB ouvert, les rôles partagés, un autre USDC, un admin KYB sans code, et toute adresse commune entre déployeur, admin KYB, vérificateur et signataire de lock. Le second vérificateur s'ajoute ensuite par le Safe.
