# Lot B — Phala/v7 sur staging

Cible choisie par Noé le **24 septembre 2026** : `https://sirius-evm-staging.vercel.app`, Robinhood **testnet 46630**, KYB ouvert. La production `sirius-data.tech` conserve sa configuration. Noé pilote contrats, image, CVM et mutations distantes ; Ali prépare les politiques comptables, la restauration, les migrations et les scénarios navigateur.

## État vérifié et conditions manquantes

- Les PR #4, #5 et #6 sont intégrées. La [pipeline staging de `332afae`](https://github.com/DVB-Ali-Noe/Sirius-EVM/actions/runs/36035263971) a réussi : vérifications, migrations, Vercel, images, reaper et smokes. Ces migrations sont celles de staging ; cela ne prouve aucune migration de production.
- L'API Phala confirme le 24 septembre à 18:09:56 UTC : CVM arrêtée, aucune opération en cours, app ID `8e14a57b42bfeff1e3cb806a5a042c313874c79c`. La machine existante est `tdx.small`, disque 20 Go. Son nom `sirius-phala-production` n'est pas une autorisation d'utiliser la base ou les secrets de production.
- Le dernier runner publié par cette pipeline est `ghcr.io/dvb-ali-noe/sirius-runner@sha256:f1c9cda9975fdb5051c95df54c37eef59ff984ef553423ffbd27234b4e398f33`. Il contient A1, **pas le nouvel outil d'initialisation du présent lot B**. Publier une image contenant ce lot avant d'utiliser le mode `init` ; relever son nouveau digest dans sa pipeline.
- Le compte déployeur/trésorerie `0xb6acf8a998bb8efa34a954cd6334ccc15da7f919` disposait de `7914660088247486` wei, soit `0,007914660088247486 ETH` testnet. Le compte Phala `0x3b31923ee7cb2a15fc85abbeeae1fc32afc08c8d` disposait de **0 wei**. Recontrôler avant signature ; financer le gas Phala avant ses règlements.
- Le code USDC testnet `0x1d6c58bb2f60b5a18ee4a72096f7743f01db0213` a l'empreinte attendue `0x4f86dc6f206ef3e02a21709f2e8330bf1439c450abe88b6a6cb1af071e6f9965` et expose 18 décimales lors de la lecture à `latest`.
- Le RPC public fournit un bloc `finalized` canonique, mais refuse des `eth_call` sur son état avec `historical state … is not available`. Le premier relevé avait 8 873 blocs d'écart avec `latest`. **Un tag finalisé disponible ne suffit pas : l'état historique doit aussi être lisible.** Un RPC archive est nécessaire au double contrôle `matchesScope` dans `assertLoanScope`, avant le calcul v7. La [documentation Robinhood](https://docs.robinhood.com/chain/connecting/) recommande un endpoint archive pour ces lectures ; [Alchemy](https://www.alchemy.com/rpc/robinhood-testnet) annonce cet accès avec un compte gratuit. Aucun nouveau compte ni abonnement RPC n'a été créé.
- Aucun budget ou tarif réel n'est configuré dans le fichier Phala existant. Les crédits d'essai et apports ne doivent pas être renseignés comme marge acquise pour contourner le mode strict. Ali doit fournir les politiques et leurs justificatifs ; les valeurs des tests restent synthétiques.

Le lot B n'est terminé qu'après les preuves de la dernière section. Cette préparation ne vaut ni activation de la CVM, ni attestation active, ni validation navigateur.

## Préflight de chaîne sans signature

La commande `pnpm phala:check-v7` n'importe aucune clé, ne charge aucun `.env` implicitement et n'envoie aucune transaction. Injecter uniquement la configuration explicite :

```dotenv
EVM_NETWORK=testnet
SIRIUS_BILLING_VERSION=7
SIRIUS_KYB_MODE=open
SIRIUS_EVM_FINALITY=finalized
SIRIUS_EVM_CONFIRMATIONS=1
EVM_RPC_URL=<endpoint-archive-testnet>
SIRIUS_USDC_ADDRESS=0x1d6c58bb2f60b5a18ee4a72096f7743f01db0213
SIRIUS_USDC_CODE_HASH=0x4f86dc6f206ef3e02a21709f2e8330bf1439c450abe88b6a6cb1af071e6f9965
SIRIUS_DEPLOYER_ADDRESS=0xb6acf8a998bb8efa34a954cd6334ccc15da7f919
SIRIUS_COMPUTE_RECIPIENT=0xb6acf8a998bb8efa34a954cd6334ccc15da7f919
SIRIUS_LOCK_AUTHORIZER=0x3b31923ee7cb2a15fc85abbeeae1fc32afc08c8d
```

La profondeur `1` est celle du diagnostic initial, avec `finalized` obligatoire ; elle n'est pas une validation du délai de règlement réel. Harmoniser ensuite la politique validée entre Next, reaper, runner et budget.

```bash
node --env-file=.ops/phala-v7-preparation/preflight.env \
  --conditions=react-server --import tsx scripts/check-phala-v7.ts
```

Après déploiement, ajouter les **trois nouvelles** adresses `SIRIUS_ESCROW_ADDRESS`, `SIRIUS_DATASET_ADDRESS`, `SIRIUS_KYB_ADDRESS`. Avant cela, le rapport signale `contracts.not_configured` et retourne un code d'échec. Une configuration partielle est refusée. Après cela, il vérifie les versions v7/v4, les liaisons réciproques, le signataire Phala, le token et le KYB ouvert au même bloc finalisé. Un solde natif positif n'est pas une estimation suffisante du gas. Même lorsque les contrôles de chaîne passent, `activationReady` reste `false` : les autres preuves ne sont pas déduites de ce script.

## Préparation des configurations de staging

Préparer des fichiers privés distincts pour le runner, Next et le reaper staging. La configuration `.env.phala` existante contient l'origine et des accès de production : **ne pas la charger telle quelle pour cette bascule**. Reprendre uniquement les accès d'infrastructure nécessaires à la même CVM et au registre d'images ; les accès applicatifs, base et stockage sont ceux de staging. Ne pas exporter la clé de l'enclave.

Un squelette local `.env.phala-staging` a été créé en `0600`, hors Git, avec un nouveau secret de transport propre à staging. Le RPC archive, l'accès Pinata staging, les nouvelles adresses de contrats et les historiques restent à compléter. Ce fichier n'est pas prêt à être envoyé à Phala ; aucun secret de production n'y a été copié.

- Runner : origine staging, RPC archive testnet, nouvelles adresses et signataire attendu, transport partagé avec les deux services staging, accès Pinata staging, `SIRIUS_BILLING_VERSION=7`, politique de finalité commune. Aucune `DATABASE_URL`, master key injectée, clé de déploiement ou clé d'émetteur KYB.
- Next et reaper : mêmes contrats et RPC archive, `TEE_MODE=phala`, `SIRIUS_REQUIRE_PHALA=true`, URL RA-TLS de la CVM existante, mesures **actives** recapturées et secret de transport staging. Base staging commune à Next/reaper ; aucune clé de runner ou de déploiement.
- Frontend : réseau testnet, nouvelles adresses publiques, origine staging et empreinte de clé d'ingestion. Reconstruire après modification : ces variables publiques sont figées au build.
- Historique : conserver les escrows effectivement utilisés par les prêts de **staging**, relevés dans sa base et sa configuration. Ne pas remplacer les anciens déploiements d'un prêt par les nouvelles adresses.

Ali et Noé valident ensuite `pnpm ops:check-release <next.env> <reaper.env> <runner.env>`. Le résultat ne remplace pas la quote matérielle, les politiques économiques ni les tests réels.

## Image mesurée et volumes

Publier le code du lot B, obtenir une CI verte et relever le digest immuable du runner. Le rendu ci-dessous fixe ce digest dans le Compose, conserve les `${VARIABLES}` pour leur transmission chiffrée par Phala, fixe l'origine staging et supprime les noms de projet/volumes calculés sur le poste local. Docker Compose est requis, mais aucun conteneur n'est démarré par cette commande.

```bash
pnpm phala:compose-v7 bootstrap <image@sha256:digest-validé> .ops/phala-v7-preparation/bootstrap.compose.json
pnpm phala:compose-v7 init <image@sha256:digest-validé> .ops/phala-v7-preparation/init.compose.json
pnpm phala:compose-v7 active <image@sha256:digest-validé> .ops/phala-v7-preparation/active.compose.json
```

Les trois fichiers sont des documents Compose JSON, acceptés comme YAML. Chaque sortie est créée exclusivement en `0600` ; un fichier existant n'est pas écrasé. **Ne pas déployer un rendu `docker compose config` avec secrets interpolés** : le Compose entre dans la mesure attestée. Ne pas déployer directement `compose.v7.yaml` avec l'image laissée en variable.

| Mode | Service runner | Initialisation |
|---|---|---|
| `bootstrap` | Nouvelle image, amorçage uniquement, volumes `runner_replay` et `runner_budget` montés | Aucune |
| `init` | Amorçage uniquement | Conteneur ponctuel `initialize-v7`, sans réseau ni socket dstack, `restart: no` |
| `active` | v7, politiques et registres existants obligatoires | Aucun service ni paramètre d'initialisation |

Pour la **première installation uniquement**, après validation par Ali des deux politiques :

1. Préparer `RUNNER_INITIAL_BUDGET_POLICY` et `RUNNER_INITIAL_BILLING_POLICY` dans le fichier d'environnement privé dédié à l'initialisation. Ce sont les JSON complets validés, pas des montants de fixtures.
2. Contrôler qu'il n'existe pas d'ancien registre SQLite à restaurer. Les fichiers historiques `grant`/`capability` peuvent être conservés lors de leur migration volontaire. Vérifier la sauvegarde et les noms réels des volumes de la même CVM.
3. Pendant le créneau Phala autorisé, déployer le Compose `init` sur **la CVM existante**. L'outil vérifie les politiques avant création ; refuse un volume budget non vide, un registre replay existant, une incohérence de réseau/compte/financement ; crée en `0600` `budget-policy.json`, `billing-policy.json`, `ledger.sqlite` et `replay.sqlite`.
4. Contrôler la fin réussie du conteneur d'initialisation. Un échec ou un état partiel demande une analyse opérateur, **jamais une suppression pour réessayer**. Un registre perdu impose une restauration cohérente.
5. Retirer le Compose `init` et les deux variables `RUNNER_INITIAL_*` avant d'activer le runner. Contrôler puis sauvegarder les registres selon les procédures A1/A2. Une restauration doit inclure les journaux SQLite cohérents ; ne pas copier seulement un fichier DB pendant une écriture.

La CVM existante n'a pas d'accès SSH configuré : cette étape d'initialisation explicite évite d'en inventer un. Le service n'est jamais inclus dans le Compose actif ; l'image n'initialise rien dans son démarrage normal. Il n'est pas un outil de restauration et ne garantit pas l'authenticité des justificatifs comptables fournis par l'opérateur.

## Exécution après levée des prérequis

1. **Ali/Noé :** politiques et dépenses d'essai validées, endpoint archive vérifié, snapshot staging récent et restauration répétée, prêts/entraînements en cours traités, scénarios et deux wallets distincts de la trésorerie prêts. Vérifier les accès et le superviseur avant toute dépense.
2. **Noé :** contrôler le bytecode compilé, le réseau et le compte de déploiement ; estimer et borner le gas avant signature. Déployer avec `SIRIUS_DEPLOY_NETWORK=testnet`, `SIRIUS_BILLING_VERSION=7`, `SIRIUS_KYB_MODE=open` et le signataire Phala ci-dessus. Le script existant crée KYB, DatasetRegistry et EscrowV7, puis lie le registre. Aucun v6 intermédiaire. La clé de déploiement n'entre ni dans le runner ni dans Next/reaper.
3. **Noé :** contrôler les reçus et les liaisons ; attendre leur disponibilité dans l'état finalisé ; compléter puis relancer `phala:check-v7`. Conserver les hashes de toutes les transactions, y compris en cas de timeout. Ne pas relancer aveuglément un déploiement dont la réponse manque.
4. **Noé/Ali :** alimenter le compte Phala en ETH testnet dans la limite retenue, vérifier les soldes, installer et tester le superviseur d'arrêt de la session ; aucune remise à zéro du budget à chaque session.
5. **Noé :** après accord sur le créneau/coût, reprendre la même CVM `e8a8b8cb-1552-4b9a-b801-54e3ae0f6e1e`, app ID inchangé. Utiliser les rendus `bootstrap`/`init` nécessaires puis `active`, avec l'environnement **staging** explicite. Une mise à jour Phala peut démarrer la machine : ce n'est pas un simple enregistrement de configuration.
6. **Noé :** recapturer RA-TLS, quote Intel `UpToDate`, événement RTMR3, hash du Compose brut, chaîne de clé et empreinte d'ingestion ; vérifier l'image attendue, l'adresse de règlement et l'origine staging. Répéter après redémarrage. Ne jamais épingler les mesures `bootstrap` ou `init` comme mesures actives.
7. **Ali/Noé :** vérifier les migrations staging déjà appliquées et les lignes historiques, préparer le réimport des datasets pour ce runner, synchroniser Next/reaper, contrôler `ops:check-release`, reconstruire puis déployer staging. Exécuter `runner:check-migration` avec cette cible explicite.
8. **Ensemble :** exécuter et documenter les scénarios ci-dessous ; conserver hashes, blocs de finalité, temps d'attente, exports et preuves de restauration dans l'espace privé, avec synthèse publiable sans secrets.

Les commandes Phala doivent viser la même CVM avec `--profile sirius --cvm-id e8a8b8cb-1552-4b9a-b801-54e3ae0f6e1e`, un fichier `-c` rendu et un fichier `-e` de staging. Elles ne sont pas lancées par les scripts de préparation.

## Preuves de fin du lot B

- [ ] Dataset synthétique publié depuis le wallet provider, reçu lié au runner actif et nouveau titre v7 compatible.
- [ ] Devis détaillé accepté par un autre wallet ; approbation exacte du total et prêt verrouillé sur le nouvel escrow.
- [ ] Calcul réel en enclave ; règlement canonique/finalisé, modèle ouvert et crédits provider/trésorerie retirés. Mesurer l'attente de finalité.
- [ ] Échec mesuré : dataset et compute non consommé remboursés, retenue bornée, crédit borrower retiré.
- [ ] Expiration sans consommation : remboursement à échéance avec le runner indisponible.
- [ ] Réponse Next/RPC perdue et runner interrompu : reprise sans recalcul indu, double règlement ni nouveau nonce incertain.
- [ ] Volume restauré : budgets et anti-rejeu conservés ; registre absent refusé ; identité Phala stable après redémarrage.
- [ ] Suppression de dataset avec prêt actif refusée ; reaper/alertes et échéance d'arrêt vérifiés.
- [ ] Anciens crédits et modèles staging accessibles selon leur déploiement historique ; aucune clé ou donnée brute ne transite par Next pendant le nouveau parcours Phala.

## Coût du prochain créneau

L'API confirme `0,058000 USD/h` de compute et `0,002780 USD/h` de disque, soit **0,060780 USD/h** au total. Une session de deux heures représente **0,121560 USD**, disque de la session inclus, avant coussin et autres fournisseurs. Le disque continue à coûter environ 2,0016 USD sur 30 jours même à l'arrêt. La [grille Phala](https://cloud.phala.com/about/pricing) distingue ces deux frais.

Le scénario déjà proposé de dix sessions et 30 jours de disque reste celui de [la préparation A2](OPERATIONS-PREPARATION.md) : enveloppe de 5 USD non approuvée. Aucun tarif commercial ou financement fictif n'est créé par ce lot. Le créneau ne commence qu'après résolution du RPC et des politiques, validation de la session et contrôle du superviseur ; aucune activation n'a eu lieu pendant la préparation.
