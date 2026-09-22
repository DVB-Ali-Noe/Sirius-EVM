# Phala : runner unique de production

Le runner Phala détient les clés, déchiffre les datasets, entraîne et règle les prêts. Next ne reçoit ni donnée brute, ni DEK, ni master key, ni préimage avant règlement. Le VPS conserve uniquement le reaper.

`main` impose `SIRIUS_REQUIRE_PHALA=true`, même sur testnet. Staging et le développement peuvent conserver `TEE_MODE=stub` sans `RUNNER_URL` pour les données synthétiques ou non sensibles. Il n’y a ni sélecteur utilisateur, ni repli automatique vers ce mode en cas de panne Phala. La présence d’un runner distant en production impose HTTPS et l’attestation, même en mode démonstration.

## Reprendre ici — 20 septembre 2026

**Prochaine action : attendre que Noé renseigne les deux accès de production dans `.env.phala-production-secrets`, puis vérifier leur cible sans afficher leurs valeurs.** Noé n’a pas de sauvegarde `.env` faisant foi, mais peut retrouver les accès chez leurs fournisseurs. Le fichier a été créé à la racine du dépôt, en permissions `0600`, exclu de Git et Docker. Au contrôle local du 20 septembre, `DATABASE_URL` et `PINATA_JWT` sont encore vides. Ne pas lui redemander les secrets dans le chat.

- `DATABASE_URL` sert aux contrôles de migration et à l’application ; **ne pas l’envoyer à Phala**.
- `PINATA_JWT` permet au runner de stocker les fichiers chiffrés. Une fois sa cible vérifiée, le reporter dans `.env.phala` pour l’envoi chiffré à la CVM.
- Ce fichier de collecte contient seulement deux variables : ce n’est pas une configuration complète de déploiement.

La connexion CLI Phala (profil `sirius`, workspace `sirius_data`) et l’accès GitHub/GHCR privé ont déjà été configurés. Ne pas recommencer ces autorisations sauf si un contrôle constate leur expiration. L’image a été publiée et la CVM vérifiée le **19 septembre** ; aucun nouveau contrôle distant n’a été exécuté le 20 septembre. La CVM n’a pas été arrêtée à la fin de la session : vérifier son état et les crédits à la reprise. Le tarif observé figure ci-dessous.

**Restent non effectués :** contrôle de la base de production, nouveaux contrats liés à Phala, financement du compte de règlement, activation métier de la CVM, migration Prisma, configuration/déploiement Next et reaper, parcours navigateur complet. Aucun commit, push ou autre commande Git n’a été exécuté pour cette intégration ; une demande explicite de Noé reste nécessaire pour toute commande Git.

### Fichiers locaux à conserver

| Fichier | Rôle et limites |
|---|---|
| `.env.phala-production-secrets` | Collecte des deux accès que Noé récupère à la source ; encore vide au dernier contrôle. |
| `.env.phala` | Configuration privée de la CVM existante : secret de transport et accès GHCR déjà présents ; JWT Pinata et nouvelles adresses de contrats à compléter. Ne pas écraser ce fichier ni régénérer ses secrets à la reprise. Aucune master key injectée. |
| `.env.phala-production-current` | Export Vercel de production du 19 septembre, incomplet : six valeurs masquées par `[SENSITIVE]` (`DATABASE_URL`, `PINATA_JWT`, `SIRIUS_FAUCET_KEY`, `SIRIUS_KYB_VERIFIER_KEY`, `SIRIUS_MASTER_KEY`, `SIRIUS_SESSION_SECRET`). Ne pas l’utiliser tel quel pour un déploiement. |
| `.env.production.local` et `.env` | Configurations anciennes ou de développement ; leur nom ne prouve pas leur cible. Ne pas en déduire les secrets de production ou le bon signataire de déploiement. |
| `.env.phala-next` | Fichier prévu par le runbook pour la future configuration applicative complète ; sa préparation reste à faire. |

### Ordre de reprise

1. Contrôler les accès récupérés et lire l’état de la base avant toute mutation : prêts ouverts, entraînements en cours, datasets publiés, modèles historiques et escrows référencés. La lecture on-chain déjà réalisée ne remplace pas cette vérification. Préserver l’accès historique aux modèles et aux crédits.
2. Confirmer le mode KYB actuel et le signataire de déploiement autorisé. Le mode ouvert est une hypothèse non validée ; ne pas changer implicitement de politique KYB. La cible reste **Robinhood testnet `46630`**, pas mainnet.
3. Préparer la maintenance, déployer une fois les nouveaux contrats avec l’adresse publique attestée de Phala et financer cette adresse en ETH testnet. Ne jamais récupérer ni importer sa clé privée.
4. Compléter `.env.phala`, passer le booléen d’amorçage à `"false"` dans le Compose, puis mettre à jour **la même CVM**. Recapturer les mesures actives, vérifier le Compose brut et la stabilité de l’identité avant de configurer Next.
5. Préparer l’environnement applicatif complet, sauvegarder puis migrer la base en maintenance, suspendre/réimporter les anciens datasets et conserver les escrows legacy. Synchroniser Next et le reaper, reconstruire le frontend, exécuter les préflights puis le parcours réel à deux wallets avant réouverture.

Les commandes détaillées et les conditions de chaque étape suivent dans ce document. Ne pas utiliser les mesures d’amorçage pour ouvrir la production.

## Amorçage vérifié le 19 septembre 2026

La CVM `sirius-phala-production` est démarrée en **amorçage uniquement** dans le workspace `sirius_data`. La production Vercel et ses contrats n’ont pas basculé.

- CVM : `e8a8b8cb-1552-4b9a-b801-54e3ae0f6e1e` ; app ID : `8e14a57b42bfeff1e3cb806a5a042c313874c79c`.
- URL RA-TLS : `https://8e14a57b42bfeff1e3cb806a5a042c313874c79c-4100s.dstack-pha-prod9.phala.network`.
- Compte de règlement attesté : `0x3b31923ee7cb2a15fc85abbeeae1fc32afc08c8d` ; solde constaté : 0 ETH testnet.
- Identité runner : `phala:c02c6054e2a8021cfcb066e5de092fc199ceabfd49e7a569ed01f0eb36fde3bc`.
- Ressources : `tdx.small`, 1 vCPU, 2 Go RAM, disque 20 Go, `US-WEST-1`, dstack `0.5.9` sans accès SSH. Tarif observé : 0,060780 USD/h, stockage inclus.
- Logs et informations système publics désactivés. L’image privée est épinglée directement dans le Compose.
- Image déployée : `ghcr.io/dvb-ali-noe/sirius-runner@sha256:fbc137a97f16213f331ce54916a5053f17c97a06d3f614c8b127365b526c5e19` (`phala-ratls-20260919`, `linux/amd64`).

Cible applicative confirmée : projet Vercel `prj_gmEKctb6EJcsErIQqamKiZNaK5vZ`, scope `byezzaali-gmailcoms-projects`, domaine `https://sirius-data.tech`, reaper VPS `/opt/sirius`. Utiliser cette cible explicite, pas le lien `.vercel` local ni une branche supposée.

La vérification Intel accepte la quote (`UpToDate`), le lien au certificat TLS et le rejeu RTMR3. Le document Compose brut fourni avec l’attestation a été rehaché et comparé à la quote ; son contenu Docker correspond exactement à `deploy/phala/compose.yaml`. La clé d’ingestion, la chaîne KMS et l’adresse de règlement restent identiques après mise à jour et redémarrage de la même CVM. Les appels via le transport RA-TLS épinglé confirment `/health` en mode `bootstrap` et le refus des POST avec 503.

Mesures de cet amorçage — à recapturer après activation, avant configuration de Next :

```dotenv
SIRIUS_EXPECTED_MRTD=f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077
SIRIUS_EXPECTED_RTMR3=347cd18da5cbac549320f53c0c82a61cbdbae8b088583308cdc89d98f532cb1322ff87f089c1016da8d02f5671b158e1
SIRIUS_EXPECTED_COMPOSE_HASH=73b99cb4f02620e2cbdf87f7762e5bbaaabb93a825ac7d02d8209b105ac1fbe8
SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256=199159501916dfc4f26c379cda97faff4e5b646b5b37789c324642cd579ba98e
NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256=c02c6054e2a8021cfcb066e5de092fc199ceabfd49e7a569ed01f0eb36fde3bc
```

Deux corrections révélées par la CVM réelle sont couvertes par les tests : décodage du certificat DER qui embarque des certificats PEM Intel, et recalcul des digests runtime omis par dstack 0.5.9. Le payload des événements est lié au digest recalculé, et ne peut pas être remplacé en conservant la mesure signée. Validation locale : 245 tests applicatifs, 46 tests contrats, lint, typage et build réussis.

L’export Vercel de production a confirmé l’escrow courant `0x805a2c2deaa3a8926e85fed6b341dacb54cacba0`. La lecture on-chain confirme v6 et l’ancien autorisateur `0x86d8220bca82633bc4c8b4d88b1c44b72015826d` ; aucun USDC n’est verrouillé, mais `20000000000000000000` unités restent dues en crédits pull. Cet escrow doit rester déclaré en legacy pour les retraits. Cela ne remplace pas le contrôle des prêts et entraînements en base.

Les valeurs sensibles de production ne sont pas exportables : notamment `DATABASE_URL` pour le préflight et `PINATA_JWT` pour l’activation. `.env.phala-production-current` est un relevé privé incomplet contenant des marqueurs `[SENSITIVE]`, pas un environnement prêt au déploiement. Ne pas réutiliser les anciennes valeurs locales sans confirmation de leur cible.

## Préparation locale

La CLI vérifiée pour ce runbook est `phala@1.1.22`. Elle peut être utilisée sans installation globale :

```bash
pnpm dlx phala@1.1.22 login --profile sirius
pnpm dlx phala@1.1.22 deploy --help
```

La connexion utilise une validation navigateur ; ne pas passer de clé API en argument ni la publier dans le chat. Le profil Phala ne remplace pas le choix de l’environnement Sirius.

1. Préparer la cible de production `sirius-phala-production`. Staging et le développement restent en processus ; une deuxième CVM n’est pas nécessaire. `main` ne signifie pas mainnet : la première bascule reste sur Robinhood testnet.
2. Construire et publier `Dockerfile.runner` pour `linux/amd64`. La pipeline produit déjà cette image ; récupérer le digest d’un build réussi contenant ce code. Ne pas utiliser une ancienne image qui ignore le mode d’amorçage.
3. Inscrire le digest `ghcr.io/…/sirius-runner@sha256:…` directement dans `deploy/phala/compose.yaml`. Une interpolation de l’image depuis les variables chiffrées ne lie pas ce digest au Compose mesuré. Préparer ensuite le fichier privé `.env.phala` à partir de `deploy/phala/.env.example`, sans écraser un fichier existant, avec un nouveau secret de transport de 32 octets en base64 et l’origine canonique de production.
4. Garder `RUNNER_BOOTSTRAP_ONLY: "true"` directement dans le Compose. Le passage en mode actif modifiera ainsi la mesure attestée. Les adresses de contrats et `SIRIUS_LOCK_AUTHORIZER` restent vides jusqu’à la récupération de l’identité. Ne jamais injecter `SIRIUS_MASTER_KEY`, une clé de déploiement ou la clé du vérificateur KYB dans la CVM.
5. Pour une image GHCR privée, ajouter `DSTACK_DOCKER_REGISTRY=ghcr.io`, `DSTACK_DOCKER_USERNAME` et `DSTACK_DOCKER_PASSWORD` au fichier privé, protégé en `0600`. Le compte doit pouvoir lire le package et le jeton doit autoriser `read:packages`. Phala chiffre ces variables avant envoi ; les identifiants du registre ne sont pas exposés dans l’environnement du conteneur runner. La publication locale nécessite également `write:packages` ; ne jamais afficher le jeton dans les logs ou le chat.

Origines : staging → `https://sirius-evm-staging.vercel.app` ; production → `https://sirius-data.tech`. Les alias HTTP configurés dans Next ne changent pas le domaine signé par le runner.

## Amorcer la CVM avant les contrats

Avec Escrow v6, `lockAuthorizer` est immuable. Le compte dérivé dans Phala doit donc être connu avant le déploiement du contrat. Le mode d’amorçage initialise dstack et TLS sans exiger de contrats :

- `GET /health` retourne `status: bootstrap` ;
- `GET /ra-tls` expose la preuve matérielle, les empreintes et l’adresse publique de règlement ;
- toutes les opérations POST, y compris celles autorisées, renvoient 503 ; aucun dépôt, entraînement, permis de lock ou règlement n’est possible.

La CVM de production existe déjà : **ne pas relancer sa création pour reprendre cette intégration**. La commande suivante décrit uniquement la création initiale ; pour l’activation, utiliser la mise à jour avec `--cvm-id` plus bas.

Amorçage initial de la CVM de production, après validation du tarif et de la région dans Phala :

```bash
pnpm dlx phala@1.1.22 deploy --profile sirius \
  -n sirius-phala-production -t tdx.small --disk-size 20G --kms phala \
  --no-dev-os --no-public-logs --no-public-sysinfo \
  -c deploy/phala/compose.yaml -e .env.phala --wait
```

Conserver l’app ID et l’identifiant de la CVM. `DSTACK_APP_ID` et `DSTACK_GATEWAY_DOMAIN` sont injectés par Phala dans le Compose. Le runner utilise le socket `/var/run/dstack.sock` et le port 4100.

L’URL doit utiliser le passthrough TLS : `https://<app-id>-4100s.<gateway-domain>`. Le suffixe `s` conserve TLS jusqu’au runner ; la terminaison HTTPS générique de la gateway ne convient pas à la vérification RA-TLS de Sirius.

Capturer l’identité sans envoyer de secret métier :

```bash
DOTENV_CONFIG_PATH=.env.phala RUNNER_URL=https://<app-id>-4100s.<gateway-domain> pnpm runner:capture-ra-tls
```

La commande vérifie le certificat, son lien à la quote TDX, l’état matériel et l’event-log. Comparer aussi le compose et le digest observés au déploiement attendu : une quote valide ne suffit pas à approuver n’importe quel code.

Si le service PCCS échoue avec `ECONNRESET` uniquement sur le chemin IPv6 local, utiliser `DOTENV_CONFIG_PATH=.env.phala node --dns-result-order=ipv4first --conditions=react-server --import tsx src/runner/capture-ra-tls.ts`. Les contrôles TLS et Intel restent inchangés.

Conserver les valeurs publiques retournées : adresse `SIRIUS_LOCK_AUTHORIZER`, empreinte d’ingestion et `RUNNER_DEPLOYMENT_ID`. Ne pas encore utiliser les mesures de l’amorçage pour ouvrir l’application.

Les clés `getKey` sont dérivées sous l’app ID dstack et le chemin stable `sirius/master/v1`. Mettre à jour la même CVM, sans recréer une application ni changer ce chemin. L’activation vérifie le signataire attendu ; un changement de clé bloque le démarrage au lieu de rendre silencieusement les données inaccessibles.

## Déployer puis activer

1. Avant de remplacer un déploiement existant, maintenir une fenêtre de maintenance : arrêter les nouvelles préparations, attendre les transactions wallet en vol, terminer ou rembourser les anciens prêts et terminer les entraînements personnels. Sauvegarder la base et l’environnement historique séparément.
2. Avec l’adresse publique capturée dans `SIRIUS_LOCK_AUTHORIZER`, suivre [ESCROW-V6.md](ESCROW-V6.md) pour déployer un nouvel escrow et son nouveau registre dataset. Le script crée également le registre KYB ; renouveler les attestations/consentements nécessaires. Ne pas utiliser le signataire du déployeur comme substitut de celui de Phala.
3. Financer le compte public de Phala en ETH testnet pour ses appels `release`. Sa clé privée reste dans l’enclave.
4. Compléter `.env.phala` : `EVM_NETWORK`, `EVM_RPC_URL`, les quatre adresses `SIRIUS_*_ADDRESS`, `SIRIUS_LOCK_AUTHORIZER`, `PINATA_GATEWAY`, `PINATA_JWT`. Conserver le secret de transport et l’origine de cette cible. Passer `RUNNER_BOOTSTRAP_ONLY: "false"` dans le Compose.
5. Mettre à jour la CVM identifiée, avec le même fichier Compose et l’ensemble des variables de cette cible :

```bash
pnpm dlx phala@1.1.22 deploy --profile sirius --cvm-id <identifiant-cvm> \
  -c deploy/phala/compose.yaml -e .env.phala --wait
```

En mode actif, le démarrage vérifie le réseau RPC, les versions et liaisons escrow/registre, les adresses KYB et USDC et la correspondance du `lockAuthorizer` on-chain avec le compte dérivé et l’adresse attendue. Une panne RPC ou une divergence bloque le démarrage.

6. Recapturer RA-TLS, vérifier `mode actif` et la stabilité de l’adresse de règlement et de l’empreinte d’ingestion. Répéter après un redémarrage de la même CVM. Toute modification de code, compose ou configuration mesurée requiert une nouvelle validation des mesures. Pour vérifier le hash du Compose, utiliser le document brut de `phala cvms attestation` : l’objet normalisé retourné par `/cvms/:id` peut contenir des valeurs par défaut absentes du document mesuré.

## Configurer Next et migrer les données

Dans un fichier privé distinct, par exemple `.env.phala-next`, préparer les variables de l’application pour la cible choisie :

- `SIRIUS_REQUIRE_PHALA=true`, `TEE_MODE=phala`, `RUNNER_URL`, le même `RUNNER_TRANSPORT_SECRET` et `SIRIUS_LOCK_AUTHORIZER` public ;
- les cinq mesures retournées par la capture active : `SIRIUS_EXPECTED_MRTD`, `SIRIUS_EXPECTED_RTMR3`, `SIRIUS_EXPECTED_COMPOSE_HASH`, `SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256`, `NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256` ;
- les nouvelles adresses serveur et `NEXT_PUBLIC_*`, le réseau testnet et les origines cohérentes ;
- les anciens escrows dans `SIRIUS_LEGACY_ESCROW_ADDRESSES` pour les crédits, preuves et préimages historiques ;
- la base et les autres paramètres applicatifs existants de cette cible.

Retirer `SIRIUS_MASTER_KEY` et tout endpoint de simulateur de Next. Les mesures attendues de Next ne vont pas dans le Compose Phala : cela modifierait la mesure à épingler.

Appliquer la migration Prisma `20260919000000_track_runner_provenance` dans la fenêtre de maintenance. Elle ajoute `runnerKind` et `runnerDeploymentId` sur Dataset, TrainingJob et Loan, sans réécrire les données historiques. Les lignes existantes restent `UNKNOWN` avec une identité nulle. Une nouvelle exécution enregistre `PHALA` ou `DEVELOPMENT` et une identité dérivée de l’empreinte publique d’ingestion ; cette identité suit la clé, pas l’URL ou le certificat TLS renouvelable.

Suspendre les anciennes fiches publiées sans supprimer les blobs et reçus historiques. Réimporter les datasets depuis le navigateur du provider vers Phala et publier de nouveaux titres. Une nouvelle clé ne peut pas ouvrir les anciennes enveloppes et ne rend pas rétroactivement confidentiels les traitements Vercel.

Préserver avant la bascule le téléchargement des anciens modèles et l’environnement permettant leur re-livraison. Le nouveau runner refuse les ressources d’une autre identité ou de provenance inconnue. Les préimages déjà publics et retraits des anciens escrows restent accessibles, mais `SIRIUS_LEGACY_ESCROW_ADDRESSES` ne donne pas à Phala les anciennes clés. Un accès historique doit rester séparé de la production Phala ; aucun routage automatique vers le runner de démonstration n’est ajouté.

Avec le fichier de contrôle de la bonne cible et les migrations appliquées :

```bash
DOTENV_CONFIG_PATH=.env.phala-next pnpm runner:smoke
DOTENV_CONFIG_PATH=.env.phala-next pnpm runner:check-migration
```

Le smoke vérifie RA-TLS, le mode actif, les contrats, l’adresse de règlement financée et la clé d’ingestion liée à l’origine. Le préflight est en lecture seule : il reprend les contrôles Escrow v6, refuse les datasets publiés ou exécutions actives appartenant à un autre runner, puis compte les modèles historiques dont il faut préserver l’accès. Il ne télécharge pas ces modèles et ne migre aucune clé.

Synchroniser Next, le runner et le reaper, puis reconstruire le frontend : les variables `NEXT_PUBLIC_*` sont figées au build. La pipeline fixe `SIRIUS_REQUIRE_PHALA=true` sur main ; un déploiement main sans configuration Phala complète sera refusé. Elle ne déploie pas la CVM et ne redéploie pas les contrats.

## Validation avant réouverture

- Dépôt chiffré depuis le navigateur et entraînement personnel avec provenance persistée.
- Prêt complet avec deux wallets : approve, autorisation v6, lock, entraînement, capsule, release et retrait provider.
- Remboursement après échéance et retrait borrower ; lecture des crédits historiques.
- Refus d’un ancien dataset, d’une attestation incorrecte et d’un changement de runner ; aucune bascule in-process.
- Récupération du modèle après reconnexion, redémarrage CVM et renouvellement du certificat.
- Budget et durée d’entraînement compatibles avec les limites synchrones du runner et de Vercel.

Le RPC de règlement voit le préimage avant confirmation lors de la simulation/envoi : utiliser un RPC de confiance. La validation locale ne remplace pas ce parcours sur une CVM réelle.

Le support futur de plusieurs destinations est conservé dans [RUNNER-MULTI-BACKEND.md](RUNNER-MULTI-BACKEND.md), sans implémentation VPS dans le produit actuel.

Références Phala : [clé déterministe par app ID](https://docs.phala.com/phala-cloud/key-management/get-a-key), [variables chiffrées](https://docs.phala.com/phala-cloud/cvm/set-secure-environment-variables), [TLS passthrough](https://docs.phala.com/phala-cloud/networking/tls-passthrough), [format et recalcul des événements dstack 0.5.9](https://github.com/Dstack-TEE/dstack/blob/v0.5.9/cc-eventlog/src/tdx.rs).
