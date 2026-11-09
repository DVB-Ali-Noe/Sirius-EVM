# Démonstration Phala — exploitation manuelle

État du 26 septembre 2026 : implémentation locale ; **pas publiée, pas activée chez Phala**. Lire le [journal de validation](PHALA-DEMO-IMPLEMENTATION.md), le [plan complet](PLAN-VPS-PHALA.md) et la [checklist du reste à faire](PHALA-DEMO-RESTE-A-FAIRE.md). Ce document remplace les commandes de bascule globale du lot B pour ce nouveau parcours.

**Mise à jour du 1er novembre 2026 ([D-28](DECISIONS.md#d-28--plus-aucune-livraison-de-modèle--prédiction-signée-seule)) :** plus aucune livraison de modèle. Le modèle entraîné (trois profils) reste scellé sur le volume du runner ; le visiteur l'interroge par prédiction signée pendant la session ouverte, avec quota quotidien. CVM arrêtée = aucune prédiction.

## Ce qui est livré dans le code

- `/phala` : présentation sur le site principal, parcours complet sur l’instance dédiée. CSV personnel ou deux exemples synthétiques ; régression linéaire/logistique ou arbres ; maximum 3 Mo et profils existants.
- `/operator` : page liée nulle part, `noindex`, 404 hors `SIRIUS_PHALA_DEMO=true`. Wallet de `SIRIUS_DEMO_OPERATORS` connecté **et signé**, puis code d’accès vérifié à chaque lecture et commande. Activer, désactiver, arrêt d’urgence. Les commandes et compteurs sont persistants.
- Le navigateur chiffre le CSV, signe l’autorisation liée à la session, publie son titre **testnet privé** et lance le self-train. Aucun prêt, paiement client ou utilisation d’USDC réel. Du gas ETH testnet reste nécessaire pour le titre et éventuellement le KYB.
- La fermeture normale bloque les nouvelles admissions, attend les opérations déjà admises et leur persistance côté Next, puis arrête la CVM. L’urgence peut supplanter une commande en cours ; elle attend uniquement la fin de l’appel fournisseur en vol avant l’arrêt.
- Le modèle est chiffré sous une clé dérivée de l’enclave sur le volume privé du runner ; il n’en sort jamais. Les prédictions (valeur à 3 chiffres significatifs en linéaire, décision 0/1 sinon) ne répondent qu’au wallet propriétaire et seulement pendant une session ouverte.
- Aucun bouton visiteur ni polling ne démarre la CVM. Aucune durée de session ni fermeture automatique. Le budget épuisé ou l’attestation invalide rend le calcul indisponible sans prendre la décision de fermeture à votre place.

## Décisions et accès nécessaires avant déploiement

| Élément | État / action |
|---|---|
| Domaine de l’espace Phala | Choisir, par exemple `confidential.sirius-data.tech` ; proposition seulement |
| Origine HTTPS du contrôleur | Certificat valide et accès Vercel → VPS ; ne pas exposer 4443 sans configuration réseau/TLS |
| Wallets opérateurs | Deux adresses publiques explicitement choisies ; les wallets de test précédents ne sont pas promus automatiquement administrateurs |
| Base Phala | Créer une base/branche Neon et des identifiants propres ; ne pas vider les bases historiques |
| Financement et coûts | Préparer puis valider le relevé de crédits, le complément payé éventuel, le plafond cumulé, la réserve machine/disque/arrêt et le coût des opérations |
| Publication | Nouvelle image, mesures, déploiement dédié et répétition du vrai parcours avant session publique |

Aucun secret n’est à transmettre dans le chat. Réutiliser les accès privés disponibles seulement lorsque leur périmètre convient ; ne pas copier les configurations staging/prod en bloc.

## Configuration des trois composants

### Site principal

`SIRIUS_PHALA_DEMO=false` (ou absent) et `SIRIUS_PHALA_DEMO_ORIGIN=https://ORIGINE_CHOISIE`. La page `/phala` crée le lien. Le runner historique n’est pas modifié par ce lien. Le transfert des entraînements habituels vers VPS reste P09 ; seuls les reapers ont déjà été transférés.

### Instance Next dédiée

Même code, projet/configuration Vercel distincts :

- `SIRIUS_PHALA_DEMO=true`, `SIRIUS_DEPLOYMENT_MODE=demo`, `EVM_NETWORK=testnet`, `NEXT_PUBLIC_EVM_NETWORK=testnet`, `TEE_MODE=phala`, `SIRIUS_REQUIRE_PHALA=true`.
- `DATABASE_URL` propre à Phala. Appliquer les migrations normales de la base neuve, dont `20260926000000_add_self_train_delivery`. **Tout autre déploiement de ce nouveau code doit aussi appliquer cette migration additive avant de servir les requêtes Prisma**, même avec le mode Phala désactivé.
- `SIRIUS_APP_ORIGIN` et `NEXT_PUBLIC_SIRIUS_APP_ORIGIN` : même origine dédiée ; configurer aussi les domaines de connexion wallet/Web3Auth. Pas d’alias autorisant les anciennes sessions par inadvertance.
- `RUNNER_URL`, `RUNNER_TRANSPORT_SECRET`, pins RA-TLS/ingestion vérifiés pour la nouvelle image/origine. Retirer toute `SIRIUS_MASTER_KEY` de Next. Aucun simulateur.
- Les contrats privés/publics doivent correspondre. Si les contrats du 25 septembre sont réutilisés : `SIRIUS_BILLING_VERSION=7`, registre dataset v4 lié à cet escrow v7. Leur présence ne crée pas de facturation du self-train.
- Configurer le KYB **ouvert testnet** avec les variables prévues par l’application. Le démarrage du mode démo exige actuellement aussi les clés faucet et KYB existantes ; elles restent côté Next, distinctes de l’enclave. Vérifier les soldes avant la répétition.
- `PHALA_DEMO_CONTROLLER_URL=https://ORIGINE_CONTROLEUR`, `PHALA_DEMO_CONTROLLER_SECRET`, `SIRIUS_DEMO_OPERATORS=adresse_operateur_1,adresse_operateur_2`.
- `SIRIUS_DEMO_OPERATOR_CODE_HASH=scrypt:…` : empreinte produite par `pnpm ops:demo-operator-code` (code généré, ou code choisi sur l’entrée standard : 12 à 128 caractères ASCII sans espace). Seul Next la porte ; le contrôleur n’en a pas besoin. Transmettre le code aux opérateurs hors chat et hors Git. Absente ou invalide : accès opérateur fermé. Cinq codes faux verrouillent le wallet quinze minutes, toutes instances confondues : chaque tentative est inscrite dans la table `OperatorCodeAttempt` avant vérification (migration `20260926120000_add_operator_code_attempts`).
- Garder les contrôles d’origine, limites d’ingress et `SIRIUS_TRUST_PROXY_HEADERS=true` avec un proxy qui écrase réellement ces en-têtes. Le contrôleur n’a besoin d’aucun accès PostgreSQL : `/api/phala-demo/drain` lui indique uniquement les jobs en cours.

Ne pas relancer le workflow v7 staging annulé : il conserve l’ancien projet de bascule globale. La pipeline actuelle gère main/staging, **pas encore le troisième projet Phala**. Préparer son déploiement explicite avant publication ; ne pas détourner la branche staging sans réconcilier sa configuration.

### Runner Phala

Nouveau digest immuable contenant les modifications de cette livraison. Le rendu `demo-init` combine amorçage, initialisation v7 existante et volumes dédiés ; `demo-active` combine les Compose base/v7/demo. Exemples de commandes locales, sans déploiement :

```bash
pnpm phala:compose-v7 demo-init ghcr.io/dvb-ali-noe/sirius-runner@sha256:DIGEST_VERIFIE /chemin/prive/demo-init.json
pnpm phala:compose-v7 demo-active ghcr.io/dvb-ali-noe/sirius-runner@sha256:DIGEST_VERIFIE /chemin/prive/demo-active.json
```

Le digest doit contenir 64 caractères hexadécimaux. Le rendu conserve les références de secrets chiffrés ; ne pas interpoler les valeurs sur le poste avant téléversement. Les volumes `sirius_phala_demo_budget` et `sirius_phala_demo_replay` sont indépendants des volumes historiques. Ne pas les supprimer pour débloquer une erreur.

Maintenance d'un volume déjà initialisé, sans réinitialisation (détails : [GBDT-PHASE2.md](GBDT-PHASE2.md)) :

- `demo-budget` prolonge la politique sponsorisée dans `ledger.sqlite` (`RUNNER_BUDGET_RENEWAL={"validUntil":…,"observedAtMs":…}`, au plus 31 jours après le relevé). Elle exige aussi `EVM_NETWORK` et `SIRIUS_LOCK_AUTHORIZER`.
- `demo-billing` remplace le tarif (`RUNNER_UPDATED_BILLING_POLICY`). Elle exige aussi `EVM_NETWORK`, `SIRIUS_USDC_ADDRESS` et `SIRIUS_COMPUTE_RECIPIENT`.
- `demo-renewal` enchaîne les deux, le tarif n'étant remplacé qu'après une prolongation réussie.
- `demo-active --opt-in-models=gradient_boosted_trees` écrit l'interrupteur en clair dans le Compose actif. Absent par défaut.

Retirer les variables de maintenance de l'environnement chiffré avant de repasser au Compose actif. Le résultat se vérifie sans journaux dans `/operations/budget` : `check.expired`, `check.quotesUntilMs`, `tariff.version`, `tariff.profiles` et `tariff.sha256`.

Ajouter `RUNNER_DEMO_CONTROL_SECRET`, distinct du transport et du monitoring. La session est stockée à `/var/lib/sirius-runner/budget/demo-sessions.sqlite`. L’initialisation v7 exige une politique budget **sponsored** et une politique de tarification v7 valide ; cette dernière maintient la compatibilité de configuration, les opérations de prêts étant refusées dans ce mode dédié. Les politiques doivent désigner les contrats/signataire réels, et les volumes doivent être vides avant leur première initialisation.

Dans le budget : racine `earnedMarginUsdMicros="0"`, `cashUsdMicros="0"`, aucun `trial`. `sponsored` contient le financement ci-dessous, `origin` exacte et `observedAtMs`. Les prix positifs `costsUsdMicros` et `fixedReserveUsdMicros` restent obligatoires. Provisionner assez d’opérations pour ingestion + scellement + entraînement ; **scellement et entraînement comptent chacun comme une opération de session**. Les quotas historiques Next (3 entraînements/wallet/heure, 30 globaux/heure, un calcul à la fois) restent aussi applicables.

Le changement de Compose modifie les mesures : capturer et vérifier matériellement la quote `UpToDate`, le lien certificat, MRTD, RTMR3, hash Compose, chaîne KMS et empreinte d’ingestion, puis épingler dans Next et le contrôleur. Vérifier que le signataire correspond aux contrats. Une nouvelle CVM/identité peut demander de nouveaux contrats ; ne jamais partager la clé Phala avec le VPS.

### Contrôleur sur le nouveau VPS

Hôte prévu : `<VPS_HOST>`, compte système `<COMPTE_OPS>`, code `<DOSSIER_OPS>`. Le service `deploy/operations/sirius-phala-demo-controller.service` est préparé **sans timer**. Son redémarrage ne lance aucune commande CVM ; une commande interrompue exige une intervention opérateur.

Préparer un répertoire `<ETAT_OPS>/phala-demo` en 0700 appartenant à `<COMPTE_OPS>`, et le fichier `<CONFIG_OPS>/phala-demo-controller.env` en 0600. Modèle : `deploy/operations/phala-demo-controller.env.example`. Vérifier le chemin Node du serveur avant d’installer l’unité. Node 22.13+ et les dépendances de production sont nécessaires.

Le profil Phala CLI 1.1.22 reste local au compte `<COMPTE_OPS>`. Le service lance seulement `cvms get/start/stop` sur la CVM déclarée et contrôle son app ID. `PHALA_DEMO_CONTROLLER_SECRET` est partagé avec Next ; `RUNNER_DEMO_CONTROL_SECRET` est partagé avec le runner. Les pins attestés doivent être les mêmes que ceux de Next. Aucune clé fournisseur n’est envoyée au navigateur.

Le service écoute par défaut en HTTPS sur `127.0.0.1:4443`. Installer un accès HTTPS authentifié utilisable depuis Vercel (proxy ou écoute adaptée avec certificat valide). Configurer correctement pare-feu, renouvellement du certificat et droits de lecture ; l’ouverture réseau actuelle du VPS ne suffit pas (état détaillé tenu hors dépôt). Préserver les reapers et les autres dossiers du VPS.

Laisser les watchdogs historiques désactivés. Un collecteur de supervision en lecture seule peut rester périodique ; il ne doit pas commander d’arrêt.

## Passer des crédits à un budget payé

Le fichier privé `PHALA_DEMO_FUNDING_FILE` est lu lors d’une commande **Activer**. Exemple de structure volontairement non financée, à compléter avant utilisation :

```json
{
  "funding": "credits",
  "creditsUsdMicros": "0",
  "cashUsdMicros": "0",
  "ceilingUsdMicros": "0",
  "observedAtMs": 0,
  "maxOperations": 20,
  "maxOperationsPerWallet": 4,
  "maxConcurrent": 1
}
```

- `credits` : complément payé nul ; `sirius` : crédits nuls ; `mixed` : deux sources explicitement affectées. Un USD = 1 000 000 micro-USD.
- Les montants/plafonds sont **cumulés depuis la création du registre**. Exemple : 1 USD déjà engagé et 2 USD supplémentaires autorisés exigent un plafond cumulé de 3 USD, pas une remise à zéro.
- Plafond positif, couvert par les sources et supérieur aux engagements + réserve fixe. Date de relevé réelle. Les quotas ne créent aucun droit de dépense supplémentaire.
- La mise à jour est refusée tant que la session est ouverte ou qu’une réservation reste incertaine. Ancienne/nouvelle politique et acteur sont conservés dans SQLite ; les compteurs financiers ne sont jamais effacés.
- La commande ne renouvelle ni la date de validité des prix ni leurs montants. Une politique expirée demande une maintenance comptable contrôlée ; ne pas fabriquer un nouveau registre pour continuer.
- **Relever le plafond en pratique** (fait le 2 novembre 2026, 9 puis 11 puis 16 USD) : session **fermée**, relever le solde Phala (`phala api /auth/me`), sauvegarder puis modifier `PHALA_DEMO_FUNDING_FILE` sous `<CONFIG_OPS>` (`ceilingUsdMicros` et `creditsUsdMicros` cumulés, `observedAtMs` = l'heure du relevé). Rien ne change avant le prochain **Activer**, qui applique la politique puis ouvre. Indice de dépassement : session `open` mais `available: false`, entraînement refusé sous le minimum des coûts (0,41 USD au tarif actuel).

Ce mécanisme autorise une enveloppe interne. Il ne choisit pas le solde que Phala prélève et ne garantit pas un plafond fournisseur. **La machine allumée continue de coûter même sans entraînement ; le disque continue après arrêt.** Prévoir cette réserve et vérifier le relevé fournisseur avant/après chaque ouverture. L’estimation automatique de l’hébergement et les notifications externes ne sont pas encore intégrées au panneau : surveillance opérateur requise avant toute ouverture publique.

## Répétition obligatoire avant accès public

1. Contrôleur lancé, CVM arrêtée : une visite, un appel d’état et un visiteur authentifié ne démarrent rien ; commande visiteur refusée.
2. Un opérateur autorisé clique Activer : seul ce geste lance la CVM ; attente d’attestation ; ouverture enregistrée. Mauvais pin = refus, sans fallback.
3. Entraîner les deux exemples puis un fichier personnel. Vérifier titre PRIVATE, métriques, prédiction signée et budget consommé. Un nouvel identifiant wallet ne contourne pas le plafond global.
4. Fermer pendant un entraînement : aucune nouvelle admission, l’opération engagée finit et son résultat est persisté avant l’arrêt confirmé.
5. Rouvrir puis prédire sur le job précédent ; tester autre wallet, refus attendu, et l’épuisement du quota quotidien. CVM arrêtée : prédiction indisponible.
6. Réouvrir : dépenses antérieures conservées ; ancien grant de session refusé. Tester une limite de quota et un budget insuffisant : aucune fermeture automatique.
7. Arrêt d’urgence pendant ouverture puis pendant calcul ; vérifier l’état réel dans Phala. Après arrêt brutal, réconcilier les réservations avant réouverture.
8. Redémarrer uniquement le contrôleur : aucune commande automatique à Phala. Une commande interrompue passe en erreur et réclame une action opérateur.

Les essais unitaires/navigateur locaux ne remplacent pas cette répétition réseau/Phala/Neon/wallet. Ne pas annoncer la confidentialité matérielle de cette nouvelle version avant sa vérification effective.

### Mesure du plafond CSV sur la CVM staging (différée jusqu’au financement)

1. Après réapprovisionnement, relever le solde et le tarif fournisseur actuels, puis annoncer créneau et budget maximal **très inférieur au solde** ; obtenir l’autorisation explicite avant de démarrer et ne jamais consommer tout le solde. Ne pas assimiler les crédits du testnet EVM au financement Phala. Vérifier que la session est fermée et que l’image candidate est issue de la PR staging ; ne pas toucher à production.
2. Installer l’image runner figée par digest et les mesures attendues propres à son nouveau Compose. Vérifier matériellement la quote `UpToDate`, le hash Compose, MRTD/RTMR3, la clé KMS, l’empreinte d’ingestion et le signataire avant ouverture manuelle ; ne pas réutiliser les anciens pins.
3. Depuis la même origine, le même navigateur et un wallet opérateur autorisé, importer un CSV synthétique binaire de 30 000 lignes de données, 23 variables numériques plus la cible, sous 3 Mio ; noter taille et empreinte SHA-256 **sans publier les données**. Contrôler l’acceptation navigateur, l’ingestion, puis lancer un seul self-train. Mesurer séparément l’aller-retour complet (chiffrement, IPFS et réseau inclus) et le calcul du worker si les journaux internes le permettent ; relever le pic mémoire du conteneur et l’état du worker, qui ne sont pas équivalents au heap V8 de 128 Mio.
4. Réussite attendue : résultat de 30 000 lignes, prédiction signée disponible, aucune interruption du worker ni 503, marge réelle sur les 15 s de calcul et sur la mémoire de la CVM. Un rejet à 31 251 lignes avec 31 variables doit rester explicite côté navigateur, sans nouveau calcul facturé ; ne pas envoyer un CSV tiers pour cette vérification.
5. Fermer manuellement en drainant les opérations et confirmer l’arrêt chez Phala. Relever le coût et le solde avant/après. Si mémoire ou délai manquent, analyser leur cause sur la CVM avant de proposer 256 Mio d’old-gen ou 30 s ; un changement de délai du parcours facturé v7 exige également un devis signé cohérent. Consigner les mesures dans la PR avant toute fusion.

## Mettre à jour le runner de la démo

Procédure suivie trois fois les 1er et 2 novembre 2026. Une fusion dans `staging` publie l'image runner mais ne touche jamais la CVM : cette mise à jour reste un geste opérateur, session fermée.

1. **Image.** Relever le digest publié pour le commit de `staging` (`gh api orgs/DVB-Ali-Noe/packages/container/sirius-runner/versions`, tag `staging-<commit>`).
2. **Compose.** `pnpm phala:compose-v7 demo-active <image@digest> <fichier> --opt-in-models=gradient_boosted_trees` (sans `--origin` : la démo lit son origine dans l'environnement chiffré). Comparer au Compose en service : seule l'image doit changer, et les volumes `sirius_phala_demo_*` rester identiques.
   **API incluse à toute location (D-33)** : avant de déployer un code Next qui loue, le tarif du volume et `SIRIUS_BILLING_POLICY_JSON` sur Vercel doivent tous deux porter `apiAccessDailyComputeAmount` et un quota `apiCallsPerDay` par profil louable (procédure `demo-billing` ci-dessous) ; sinon toute location v7 est refusée, et un champ présent sur Vercel seulement fait échouer les devis (« Devis compute hors scope »).
   **Si la nouvelle image exige un champ de tarif absent du volume** (cas de D-30 : `noTrainingComputeAmount`, `apiCallsPerDay`), mettre d'abord le tarif à jour : `pnpm phala:compose-v7 demo-billing <image@digest> <fichier>` (sans `--opt-in-models`), tarif = celui du volume (vérifier que son SHA-256 compact égale `tariff.sha256` du rapport de supervision) avec une nouvelle `tariffVersion` et les champs ajoutés, même `validUntil`. Fichier d'environnement = `runner.trees-active.env` + `RUNNER_UPDATED_BILLING_POLICY='<json>'` (vérifier son SHA-256 sur le VPS). Déployer ce Compose comme à l'étape 3 : **sur une CVM arrêtée, `deploy` enregistre le Compose sans démarrer** et l'attente expire après 300 s ; lancer alors `phala cvms start <app>` et vérifier `dstack-update-billing-policy-1` en `Exited (0)` dans `phala ps`. Déployer ensuite le Compose actif : un runner `Up` stable prouve que le tarif du volume est valide. Aligner `SIRIUS_BILLING_POLICY_JSON` de Vercel staging sur les mêmes octets.
3. **Déploiement.** Copier le Compose sous `<ETAT_OPS>/phala-demo/runner/` (`sirius-ops`, 0600), arrêter le contrôleur, puis, en tant que `<COMPTE_OPS>` : `pnpm dlx phala@1.1.22 deploy --profile sirius --cvm-id <cvm> -c <compose> -e <ETAT_OPS>/phala-demo/runner/runner.trees-active.env --no-public-logs --no-public-sysinfo --public-tcbinfo --wait`. Les journaux étant privés, contrôler avec `phala ps --cvm-id <cvm>` (conteneur `Up` stable, pas `Restarting`) et `phala logs --cvm-id <cvm> --serial`.
4. **Attestation.** `phala cvms attestation <app> --json` : SHA-256 de `tcb_info.app_compose` = `compose_hash`, image = digest attendu. Puis `DOTENV_CONFIG_PATH=/dev/null RUNNER_URL=<url> pnpm runner:capture-ra-tls` : « Quote matérielle vérifiée — mode actif » ; seule l'empreinte du Compose doit changer (MRTD, RTMR0–2, `SIRIUS_EXPECTED_OS_IMAGE_HASH`, `SIRIUS_EXPECTED_APP_ID`, chaîne KMS, empreinte d'ingestion, `SIRIUS_LOCK_AUTHORIZER`, `RUNNER_DEPLOYMENT_ID` identiques). Un changement d'OS dstack ou de taille de VM change RTMR0–2 et `os-image-hash` : vérifier la nouvelle image OS avant de réépingler ces valeurs partout.
5. **Pins.** Sauvegarder puis remplacer `SIRIUS_EXPECTED_COMPOSE_HASH` dans le contrôleur et le moniteur (`<CONFIG_OPS>`) et dans `.env.vps` du reaper (`<DOSSIER_STAGING>`, puis `docker compose -p sirius-staging --env-file .env.vps up --detach`) ; redémarrer le contrôleur. Vercel staging : `vercel env add SIRIUS_EXPECTED_COMPOSE_HASH production --force --type config` (garder le type `Config`), puis relancer le job « Front Vercel » du dernier run staging. Vérifier `/api/phala-demo/attestation` (`composeHash` = nouvelle empreinte).
6. **Déclaration.** PR : `src/lib/phala-demo/composes/<hash>.json` (octets exacts de `tcb_info.app_compose`) et entrée `DECLARED_RELEASES` (image, commit), pour que la page d'attestation affiche une version prouvée plutôt que « non répertoriée ».

**En service au 7 novembre 2026** : Compose `9f796418fb526914ba71e616fda93e729c9bfaa71ff975fdd69fbb4213e08a62`, image `sirius-runner@sha256:7b7f6303548371b7e0e060c3bf5eeb24f63fb7549a0bf6d62993de0da44a00c4`, commit `2bb02f5` (API développeurs, D-30). Tarif du volume et de Vercel `demo-trees-api-2026-11-07` (SHA-256 `3dbc528e5443ef081716a89701fc719878c6b5c855e3764495d581e7efec6cec`) : tarif précédent + `noTrainingComputeAmount` = 0,10 USD et `apiCallsPerDay` = 50 (logistique) / 100 (arbres). Seule l'empreinte du Compose a changé ; MRTD, RTMR0–2, image OS, `app-id`, chaîne KMS, empreinte d'ingestion et signataire identiques. La démo refuse toujours les prêts, donc l'API : elle se teste sur un environnement facturé.

Pour `vercel env add` hors pipeline, le `.vercel/project.json` temporaire doit reprendre l'`orgId` exact de `.github/workflows/pipeline.yml` (la casse compte) ; sinon la CLI répond « Could not retrieve Project Settings ».

## API développeurs

L'API développeurs (D-30) sert les modèles loués depuis la CVM runner de **production/staging**, jamais depuis la démonstration : `scripts/operations/api-availability.ts` refuse de démarrer si `SIRIUS_PHALA_DEMO=true`, si `SIRIUS_PHALA_DEMO_APP_ID` (app ID de la démonstration, obligatoire, `none` s'il n'y en a aucune sur le compte Phala) manque ou est égal à `SIRIUS_API_PHALA_APP_ID`, ou si `PHALA_DEMO_CVM_ID`/`PHALA_DEMO_APP_ID` figurent dans son environnement avec la même CVM ou le même app ID (audit E F6). L'app ID est revérifié à chaque lecture de la CVM. Sirius paie la machine tant qu'elle est allumée.

**Règle.** Toutes les `SIRIUS_API_AVAILABILITY_POLL_SECONDS` (60 s), le contrôleur lit la base : la CVM est nécessaire s'il existe un prêt en cours qui a encore du travail pour le runner (audit E F2 : `release` diffusé ; prêt ordinaire `TRAINING` ou `SETTLING` ; prêt ordinaire `ESCROWED` 30 min après son lock, mesurées depuis sa préparation (`createdAt`, jamais réécrit, plus les 10 min du lock), soit 40 min au plus ; pack ou pass tant qu'il n'est ni refusé, `apiAccessRefusedAt`, ni rattaché à une location échue ; prolongation tant que le modèle d'origine n'est pas supprimé ; jamais un lock échu sans `release`) ou un réveil encore valable (`RunnerAvailability.requestedUntil`, posé par Next pour 15 min et repoussé par chaque activité, au plus toutes les 5 min, après les contrôles de la route : création de clé, prédiction depuis le site ou achat d'appels par l'emprunteur d'une location active ; appel de l'API publique avec une clé existante, non révoquée, d'une location réglée et non échue ; publication d'un dataset par son fournisseur, brouillon, scellement ou envoi en morceaux ; devis d'un emprunt ou d'une prolongation par l'emprunteur ; lancement de l'entraînement d'un prêt verrouillé (`/run`) ; règlement d'un pack ou d'un pass verrouillé ; jamais par une clé inconnue ou révoquée ni une requête invalide, voir D-30). Depuis l'option 1 (8 novembre 2026), une clé API seule ne garde plus la CVM allumée. Besoin et CVM arrêtée : `cvms start`, phase `starting`, puis `running` seulement quand `GET /health` du runner répond `ok` via RA-TLS. Aucun besoin depuis `SIRIUS_API_AVAILABILITY_IDLE_MINUTES` (45 min) : arrêt en deux temps (audit E F3), `stopping` publié d'abord, besoins relus, puis `cvms stop` seulement s'ils sont toujours nuls (sinon la CVM est gardée, `Besoin revenu avant l'arrêt`), et `stopped` une fois arrêtée, soit environ une heure après la dernière activité. La phase est publiée à chaque tour dans `RunnerAvailability`, avec `validUntil` = tour + 3 intervalles + 90 s (4 min 30 avec 60 s) ; au-delà sans nouvelle publication, Next ne croit plus la phase (audit E F4) : `503 controller_unavailable` avec `Retry-After: 60`, rien relayé ni réveillé, et une ligne `ALERTE contrôleur de disponibilité muet` dans les journaux Next ; `/settle` et le règlement d'une prolongation ne réveillent rien mais vérifient la même phase (`503 controller_unavailable` ou `503 enclave_starting`, attendu par la page), le reaper réglant toujours sans ce contrôle ; hors `running`, `/api/v1` et les routes wallet ci-dessus répondent `503 enclave_starting` avec `Retry-After`, le site et les SDK relançant seuls. Une commande Phala n'est pas répétée avant 5 min ; un redémarrage du contrôleur relance le délai d'inactivité (jamais d'arrêt immédiat) et n'arrête jamais la CVM en quittant.

**Budget de réveil.** `requestedUntil` n'est écrit que s'il lui reste moins de 10 min : une attente relancée toutes les 30 à 45 s n'écrit qu'une fois. Sur la publication, le devis, le lancement d'un entraînement (`/run`) et le règlement d'un pack ou d'un pass, chaque écriture dépense le budget du compte, tenu en base dans `RunnerWakeBudget` (6 par heure, 12 par jour, commun à toutes les instances Next, dépense atomique) : épuisé, une CVM allumée sert la requête sans être prolongée, une CVM qui démarre déjà répond le `503 enclave_starting` habituel, une CVM arrêtée ou qui s'arrête répond `429` avec un `Retry-After` jusqu'à la fin de la fenêtre (au plus 600 s), sans rien écrire. Le reaper supprime les lignes dont les deux fenêtres sont échues (au plus un jour après la dernière dépense). Pire cas : ~12 heures de CVM par jour et par compte KYB ; entre comptes, autant de fois que de wallets obtenus par l'attestation parrainée (`docs/passage-mainnet/14-kyb.md`), le tout plafonné par une CVM allumée en continu (D-30, précision « budget de réveil »).

**Installation.** Même hôte et même compte `<COMPTE_OPS>` que le contrôleur de démonstration, profil Phala CLI 1.1.22 dédié à la CVM de l'API. Fichier `<CONFIG_OPS>/api-availability.env` en 0600 d'après `deploy/operations/api-availability.env.example` : `SIRIUS_API_AVAILABILITY=true`, identité Phala (`SIRIUS_API_PHALA_PROFILE`, `SIRIUS_API_PHALA_CVM_ID`, `SIRIUS_API_PHALA_APP_ID`, contrôlé à chaque lecture), `DATABASE_URL` de l'application (rôle limité à la lecture de `Loan` et à la lecture/écriture de `RunnerAvailability` si possible), `RUNNER_URL` et les pins attestés identiques à ceux de Next (`SIRIUS_EXPECTED_MRTD`, `_RTMR0`, `_RTMR1`, `_RTMR2`, `_OS_IMAGE_HASH`, `_APP_ID`, `_COMPOSE_HASH`, `_MASTER_KEY_CHAIN_SHA256`, `NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256` ; `SIRIUS_EXPECTED_RTMR3` n'est plus lu), validés au démarrage comme dans Next : un pin absent ou mal formé arrête le service au lieu de laisser `/health` échouer, CVM allumée (audit E F5). Migration `20261108040000_add_runner_availability_valid_until` appliquée avant la mise à jour. Installer `deploy/operations/sirius-api-availability.service`, vérifier le chemin Node, puis `systemctl enable --now sirius-api-availability`. Lancement manuel : `pnpm ops:api-availability`.

**Mise à jour (audit E) et retour arrière.** Le contrôleur refuse désormais de démarrer sans `SIRIUS_PHALA_DEMO_APP_ID` ni pin valide : avec `Restart=on-failure`, un code mis à jour avant le fichier boucle sur « SIRIUS_PHALA_DEMO_APP_ID requis », et Next lit alors la dernière phase sans `validUntil` comme avant, sans alerte. Ordre : (1) compléter `<CONFIG_OPS>/api-availability.env` (`SIRIUS_PHALA_DEMO_APP_ID`, `SIRIUS_EXPECTED_RTMR0`, `_RTMR1`, `_RTMR2`, `_OS_IMAGE_HASH`, `_APP_ID`, retirer `SIRIUS_EXPECTED_RTMR3`) avant toute copie du code dans `/opt/sirius-ops` ; (2) appliquer la migration `20261108040000_add_runner_availability_valid_until` (pipeline Next) ; (3) déployer Next et copier le code du contrôleur ; (4) `systemctl restart sirius-api-availability` ; (5) vérifier la première publication : `journalctl -u sirius-api-availability -n 20` montre « Contrôleur actif » sans erreur, et `SELECT phase, "validUntil" FROM "RunnerAvailability"` donne un `validUntil` dans les 5 min à venir, repoussé au tour suivant. Retour à l'ancien contrôleur : il n'écrit pas `validUntil`, qui resterait figé et ferait répondre `503 controller_unavailable` à toutes les routes runner après au plus 4 min 30 ; juste après l'avoir relancé, exécuter `UPDATE "RunnerAvailability" SET "validUntil" = NULL WHERE id = 1;` (Next lit de nouveau la phase comme avant). La colonne peut rester en place.

**Surveillance.** `journalctl -u sirius-api-availability` : phases, commandes et refus, sans secret ni identifiant de clé. Une ligne `ALERTE` (répétée toutes les 10 min) signale un runner injoignable depuis plus de 10 min alors qu'il est nécessaire : vérifier `phala ps --cvm-id <cvm>`, `phala logs --cvm-id <cvm> --serial` et les pins (un réépinglage oublié après mise à jour bloque `/health` attesté). Base indisponible : aucun changement de la CVM à ce tour. Pour une maintenance : (1) `systemctl stop sirius-api-availability` (le contrôleur relancerait sinon la machine au prochain besoin) ; (2) publier la phase de maintenance, `systemd-run --wait --pipe --uid=<COMPTE_OPS> -p EnvironmentFile=<CONFIG_OPS>/api-availability.env -p WorkingDirectory=/opt/sirius-ops /usr/bin/node --conditions=react-server --import tsx scripts/operations/api-availability.ts maintenance` : Next répond aussitôt `503 controller_unavailable` au lieu de relayer vers une CVM qu'on arrête ; (3) arrêter la CVM à la main. Pour reprendre, `systemctl start sirius-api-availability` : le premier tour republie la phase réelle. Sans l'étape 2, Next relaie encore jusqu'à l'échéance de `validUntil` (au plus 4 min 30). Une `ALERTE contrôleur de disponibilité muet` dans les journaux Next hors maintenance : vérifier `systemctl status sirius-api-availability` et l'accès du VPS à la base.

**Répétition.** (1) CVM arrêtée, aucun appel : rien ne démarre, même avec des clés actives. (2) Appel `/v1` avec une clé inconnue ou révoquée, ou sur une location expirée : `401`/`403`, rien ne démarre (`requestedUntil` inchangé). (3) Appel signé avec une clé valide d'une location active : `503 enclave_starting` avec `Retry-After`, démarrage, `starting` puis `running`, le SDK obtient la prédiction. (4) Plus aucun appel : arrêt environ une heure après le dernier (15 min de réveil + 45 min d'inactivité), confirmé chez Phala, sans révoquer la clé.

## Incident et reprise

- Erreur de commande/attestation : page indisponible ; consulter l’état fournisseur. Aucune garantie que la machine soit arrêtée tant que Phala ne le confirme pas. Utiliser Arrêt d’urgence si nécessaire.
- Calcul interrompu : les réservations SQLite restent engagées. La réconciliation automatique self-train après SIGKILL n’est pas livrée ; ne pas marquer artificiellement un job réussi ni recréer un budget. Préserver les deux registres et traiter la reprise en maintenance.
- Perte de réponse Next avant persistance : un résultat peut rester scellé dans le runner sans job `DONE` en base ; la prédiction n’est alors pas garantie. Le drainage normal protège les jobs RUNNING, pas une panne arbitraire de Next.
- Volume runner perdu : les modèles scellés sont perdus ; aucun autre exemplaire n’existe. Ne pas promettre le contraire.
- Pause longue : fermer manuellement puis confirmer l’arrêt, vérifier charges disque et sauvegardes. Aucun minuteur ne le fait à votre place.
- Conteneur absent, CVM en `error` au démarrage, `Docker login failed: ghcr.io … denied` dans `phala logs --serial` : le jeton de lecture du registre (`DSTACK_DOCKER_USERNAME` / `DSTACK_DOCKER_PASSWORD` de l'environnement chiffré) a expiré. Créer un jeton classique **`read:packages` seul**, le déposer sur le VPS sans l'afficher, mettre à jour le fichier d'environnement avec sauvegarde, redéployer. Noter son échéance : aucune alerte ne prévient.
- Runner en redémarrage permanent (`Restarting (1)`) : vérifier d'abord le RPC de l'environnement runner. Un `429 Monthly capacity limit exceeded` d'Alchemy empêche la vérification des contrats au démarrage ; le même RPC sert au contrôleur et au moniteur.
- Prêt remboursé ou réglé mais encore ouvert en base : le reaper lit l'état au bloc **finalisé**, environ 30 minutes derrière la tête de chaîne sur Robinhood testnet. Attendre la finalité avant de conclure à une panne.

## Travail restant sans attribution nominative

La [checklist complète](PHALA-DEMO-RESTE-A-FAIRE.md) détaille les 14 étapes, les limites techniques et le chantier VPS : domaines/opérateurs, financement/quotas, base/migrations, cible Vercel et pipeline, réconciliation staging, livraison GitHub, image/volumes, contrôleur HTTPS, attestation, finition de l’interface, exploitation et répétition réelle.

L’interface peut être finalisée en parallèle de l’infrastructure et du financement. Toute modification de fichiers communs doit être coordonnée. Après validation des preuves et des huit scénarios, décider manuellement de l’ouverture. Le runner VPS habituel (P09), les gros fichiers, l’asynchronisme, les arbres, le pilote et les portes mainnet restent les suites prévues.
