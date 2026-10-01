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

1. Lire le rapport de budget attesté (`ops:runner-monitor`) : nombre d'échecs, opérations réservées ou en échec, solde ETH.
2. Identifier la cause dans le journal des opérations : RPC, IPFS, gas, finalité.
3. Corriger la cause (recharger l'ETH de règlement, attendre le RPC, etc.).
4. Seulement ensuite, réarmer avec la commande opérateur `reset-failures` du runner (livrée par le lot N1), et consigner la cause dans le journal.

## 3. Transaction runner bloquée

**Signes** : opération `reserved` qui ne progresse plus, nouvelles transactions runner refusées, prêts bloqués en SETTLING.

1. Lire l'opération bloquée (hash, nonce) dans le rapport du runner.
2. Comparer au nonce de l'adresse de règlement sur l'explorer (`getTransactionCount`).
3. Si la transaction est minée : laisser la réconciliation la finaliser. Sinon, re-signer au même nonce avec un nouveau fee, ou `abandon` si l'opération ne doit plus partir (commandes livrées par le lot N4).
4. Vérifier que les règlements suivants repartent.

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

**Seuil d'alerte** : 0,02 ETH sur l'adresse de règlement de l'enclave.

1. Envoyer de l'ETH depuis le Safe ou un wallet d'équipe vers l'adresse de règlement (adresse publique dans le journal).
2. Vérifier le solde sur l'explorer et dans le rapport de budget attesté.

## Surveillance quotidienne pendant la bêta

À 12h et 20h, par la personne d'astreinte :

- rapport de budget attesté : échecs à 0, aucune opération bloquée, solde ETH au-dessus du seuil ;
- reaper : dernière ligne `[reaper] passe` de moins de deux minutes ;
- exposition verrouillée totale comparée au plafond ;
- page d'état à jour.
