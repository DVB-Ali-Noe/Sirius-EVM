# Essais Phala : crédits, wallets et supervision

Décision de Noé du 25 septembre 2026 : les crédits Phala financent les essais internes sur staging. Les entraînements de clients ne doivent pas utiliser cette enveloppe. Ce document décrit le code préparé ; son installation distante et le parcours navigateur restent à vérifier dans [le lot B](PHALA-V7-STAGING.md).

## Séparation des financements

Une politique de budget peut déclarer `trial`, uniquement sur le testnet `46630`, avec le nouvel escrow staging et une liste de 1 à 10 wallets. Le runner exige l’origine exacte `https://sirius-evm-staging.vercel.app`, la facturation v7 et cet escrow. Il vérifie le wallet signataire des autorisations avant de déchiffrer ou entraîner ; un devis exige aussi un provider et un borrower autorisés.

`earnedMarginUsdMicros` et `cashUsdMicros` restent à `"0"`. Le champ `trial.ceilingUsdMicros` fournit l’enveloppe maximale, bornée par `trial.creditsUsdMicros` observé chez Phala. Le relevé est daté ; la politique expire au plus tard 31 jours après ce relevé. Le registre conserve dépenses réservées, gas, échecs et engagements après redémarrage. Ni un ajout de wallet ni une nouvelle session ne recréent de budget.

Sans `trial`, le financement strict par marge acquise et liquidités disponibles reste inchangé. Ce mode d’essai est refusé sur mainnet et sur le domaine de production.

Le 25 septembre, `/auth/me` de Phala a retourné **14,695217 USD de crédits accordés**, un solde acheté nul et `is_post_paid: false`. C’est un relevé ponctuel, pas une garantie de solde futur ni un plafond imposé au fournisseur. Le budget logiciel bloque les admissions ; le watchdog borne la durée de la session. Le disque continue à être facturé à l’arrêt. Un hébergement client permanent nécessitera une facturation Phala séparée des crédits d’essai, à vérifier avec le fournisseur avant ouverture aux clients.

## Liste des wallets

La liste locale de préparation est `.ops/phala-v7-preparation/trial-wallets.json`, hors Git :

```json
[
  "0xe07abf7ef148d0ecf04906239deb2b1b54e9aa55",
  "0x75773bf175273eb37cd89016324176e257d114ce"
]
```

La première adresse est prévue pour le provider, la seconde pour le borrower. Ces rôles ne sont pas figés dans la liste. Les deux adresses sont différentes du signataire Phala et de la trésorerie.

Avant la première installation, recopier la liste dans `trial.wallets` de `RUNNER_INITIAL_BUDGET_POLICY`. Une fois initialisé, **le registre SQLite fait autorité** : modifier le JSON local ou `budget-policy.json` ne change pas les wallets actifs.

Pour ajouter des wallets après activation :

1. Ajouter leurs adresses publiques en minuscules au fichier local, puis préparer `RUNNER_ADDITIONAL_TRIAL_WALLETS` comme tableau JSON dans un fichier d’environnement privé.
2. Attendre la fin des calculs et règlements en cours. Pendant une maintenance, rendre `pnpm phala:compose-v7 wallets <image@sha256:digest-validé> <nouveau-compose.json>` puis appliquer ce Compose à la même CVM avec l’environnement staging. Le runner est en amorçage ; le conteneur ponctuel n’a ni réseau ni clé d’enclave.
3. Vérifier la sortie réussie de `add-trial-wallets`. Il ajoute uniquement des adresses, valide le réseau/signataire/escrow et conserve plafonds, historique et compteurs. Un échec ne justifie jamais de réinitialiser le registre.
4. Retirer la variable `RUNNER_ADDITIONAL_TRIAL_WALLETS`, remettre le Compose actif avec le même digest et revérifier son attestation. Le redémarrage recharge la politique mise à jour.

La commande interne du conteneur est `node --import tsx scripts/add-runner-trial-wallets.ts /var/lib/sirius-runner/budget/ledger.sqlite`, avec `RUNNER_VOLUME_ACTION=add-trial-wallets`, le signataire et l’escrow attendus. Elle se lance hors service, jamais comme une opération HTTP du client. Aucun retrait de wallet n’est proposé pendant les essais pour éviter de bloquer les prêts déjà engagés.

## Canal de supervision

`GET /operations/budget` expose un diagnostic limité, protégé par `RUNNER_MONITOR_SECRET`, un secret de 32 octets en base64 distinct du secret de transport métier. Le rapport contient réseau, adresse de règlement, date réelle, source de financement et diagnostics du registre. Il reste disponible lorsque le budget est épuisé ou expiré. Il n’expose ni politique complète, ni DEK, ni résultat de modèle, ni transaction signée brute.

Le collecteur extérieur vérifie la RA-TLS et les mesures épinglées avec le même client que Next, puis l’identité et la fraîcheur du rapport. Il écrit atomiquement un fichier `0600` dans un répertoire `0700`. Un échec conserve l’ancien rapport et sa date ; le superviseur détecte sa péremption.

```bash
node --env-file=/etc/sirius/operations/runner-monitor.env \
  --conditions=react-server --import tsx scripts/operations/runner-monitor.ts \
  /var/lib/sirius-ops/budget-check.json
pnpm ops:supervise /etc/sirius/operations/session.json \
  /var/lib/sirius-ops/cvm.json /var/lib/sirius-ops/budget-check.json
```

Le fichier privé du collecteur contient `RUNNER_URL`, `RUNNER_MONITOR_SECRET`, réseau/contrats/RPC de staging, finalité et mesures actives épinglées (`SIRIUS_EXPECTED_MRTD`, `SIRIUS_EXPECTED_RTMR3`, `SIRIUS_EXPECTED_COMPOSE_HASH`, `SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256`, `NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256`). Aucun `DATABASE_URL`, secret de transport métier, JWT Pinata ou clé de signature n’est nécessaire.

Les unités `deploy/operations/sirius-runner-monitor.service` et `.timer` collectent chaque minute sur un hôte extérieur doté de Node 22 et des dépendances. Adapter `/opt/sirius` à l’installation des outils de supervision ; ne pas remplacer la pile de production. Installer avec l’utilisateur dédié `sirius-ops`, répertoire de rapports privé, fichier d’environnement privé et mesures actives vérifiées. Le watchdog Phala existant reste séparé : il demande l’arrêt à l’échéance inscrite dans `session.json`, même si le runner ne répond plus.

La présence de ces fichiers ne prouve pas que les timers sont installés : vérifier leur exécution et un rapport frais avant de déclarer la supervision opérationnelle.
