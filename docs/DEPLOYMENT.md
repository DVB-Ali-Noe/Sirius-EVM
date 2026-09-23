# Branches, déploiements et authentification

État du code au 12 septembre 2026. La configuration est implémentée localement sur `staging` et sera utilisée sur `main` après publication, fusion et passage de la pipeline. Une modification locale ne met pas à jour une instance déjà déployée.

Les corrections F1–F4 du 13 septembre ajoutent une migration contractuelle distincte : lire [ESCROW-V6.md](ESCROW-V6.md) avant de publier la nouvelle version. Le choix automatique des origines ne déploie pas les contrats.

**Priorité avant le prochain déploiement :** terminer la [facturation du compute au borrower](COMPUTE-BILLING.md), avec devis fixe signé et prépaiement dataset + compute. Le [contrat v7, son ABI et ses tests](ESCROW-V7.md) existent séparément en local ; runner, application, budgets, migrations, scripts de déploiement et préflights doivent encore être adaptés avant la bascule Phala. Ne pas redéployer v6 pour le seul changement de runner entre-temps.

**Point de reprise Phala au 23 septembre :** la CVM de production a été revérifiée en amorçage puis arrêtée à la demande de Noé pour couper les frais de calcul ; le disque est conservé et reste facturé. Prévenir Noé avant toute nouvelle utilisation de Phala, avec son moment et son coût estimé. Aucune bascule Next, base, contrats ou reaper n’a été effectuée dans cette intégration. Les accès de production sont validés dans `.env.phala-production-secrets` ; Pinata est aussi configuré dans le fichier local `.env.phala`. Aucun prêt ni entraînement actif observé ; les modèles historiques restent à préserver. Le KYB actuel est ouvert sur testnet ; le compte de déploiement reste à choisir. L’export `.env.phala-production-current` contient toujours des valeurs `[SENSITIVE]` inutilisables. Lire [le point de reprise et l’ordre des opérations](PHALA.md#reprendre-ici--23-septembre-2026) avant tout déploiement main.

## Une cible par branche

[`scripts/deployment-target.mjs`](../scripts/deployment-target.mjs) est la source de vérité utilisée par [la pipeline](../.github/workflows/pipeline.yml).

| Branche | Environnement GitHub | Projet Vercel | Origine canonique | Compose / dossier VPS |
|---|---|---|---|---|
| `staging` | `staging` | `sirius-evm-staging` | `https://sirius-evm-staging.vercel.app` | `sirius-staging` / `/opt/sirius-staging` |
| `main` | `production` | `sirius-evm` | `https://sirius-data.tech` | `sirius` / `/opt/sirius` |

Alias explicitement autorisés pour **main** :

- `https://sirius-evm.vercel.app` ;
- `https://sirius-evm-byezzaali-gmailcoms-projects.vercel.app`.

Alias explicitement autorisé pour **staging** : `https://sirius-evm-staging-byezzaali-gmailcoms-projects.vercel.app`.

`sirius-evm.vercel.app` appartient à main, même si le dossier local est sur staging. Le navigateur ne connaît pas la branche ouverte dans l'éditeur. Les URL Vercel éphémères de chaque build ne sont pas implicitement autorisées. Aucun joker `*.vercel.app` n'est utilisé.

Les deux projets Vercel utilisent chacun leur environnement **Production**. Cela ne veut pas dire qu'ils partagent leurs variables. La branche choisit le projet ; elle ne choisit pas `Preview` à la place de `Production`.

**Branche `main`, environnement Vercel Production et réseau EVM mainnet sont trois notions distinctes.** Le réseau et les contrats restent ceux de chaque environnement. Fusionner sur main ne déploie pas de contrats, ne change pas le token et n'active pas mainnet.

## Ce qui se passe après une fusion

La cible fixe aussi `SIRIUS_REQUIRE_PHALA` : `true` sur main, `false` sur staging. La production applicative exige donc le runner Phala même si le réseau reste testnet. Avant la première fusion de cette évolution sur main, terminer le runbook [PHALA.md](PHALA.md) et configurer les mesures et le runner actif ; les secrets de démonstration ne sont pas convertis automatiquement. Staging conserve le mode in-process pour les données non sensibles. Aucun sélecteur de runner n’est exposé.

1. Le push sur `staging` ou `main` déclenche les tests, le typage, le lint, le build et les tests navigateur. Une PR seule ne déploie rien.
2. La référence exacte résout le projet Vercel, l'environnement GitHub, le dossier VPS et les origines. Une branche inconnue, un tag ou une référence de PR est refusé ; aucun fallback vers staging.
3. Le préflight et les migrations utilisent la base et les paramètres de l'environnement GitHub ciblé.
4. Le job Vercel réécrit le lien `.vercel/project.json` pour cette cible, puis synchronise trois variables publiques dans son environnement Production :
   - `SIRIUS_APP_ORIGIN` : domaine canonique signé ;
   - `SIRIUS_APP_ORIGIN_ALIASES` : liste exacte des alias de cette cible ;
   - `NEXT_PUBLIC_SIRIUS_APP_ORIGIN` : même domaine canonique, intégré au JavaScript navigateur.
5. La pipeline exécute `vercel pull`, `vercel build --prod`, puis `vercel deploy --prebuilt --prod`. Les origines sont définies **avant** le build et à l'exécution. Une erreur de synchronisation arrête le job.
6. Un smoke vérifie un vrai challenge sur le domaine canonique et chaque alias, son domaine signé, son adresse et sa clé de session. Il vérifie aussi que l'origine de l'autre branche est refusée. Il crée seulement des nonces d'authentification temporaires ; il ne signe pas de connexion, ne crée pas de prêt et n'envoie aucune transaction.

Les trois origines ne sont pas des secrets : elles sont enregistrées comme configuration lisible. Les secrets de session, de base, de transport et de chiffrement restent propres à chaque environnement. Ils ne sont jamais copiés d'une branche vers l'autre par cette synchronisation.

Les images worker/runner sont construites par la pipeline. Le worker est déployé sur le VPS de la cible ; la CVM Phala reste une opération distincte, avec vérification de ses mesures. Ne pas promouvoir un build staging déjà produit vers main : les variables `NEXT_PUBLIC_*` sont figées pendant la compilation.

## Pourquoi « Sign-in challenge rejected » apparaissait

Le 12 septembre, l'appel à `/api/auth/challenge` depuis `https://sirius-evm.vercel.app` renvoyait **403 « Origine de requête non autorisée »**, avant toute signature du wallet. L'origine configurée du déploiement main était `https://sirius-data.tech`. Le front remplaçait toutes les erreurs de cette étape par le même message générique.

Le serveur accepte maintenant les alias déclarés, uniquement si l'origine du navigateur correspond aussi à celle de l'URL appelée. Les requêtes cross-site restent refusées. Le challenge conserve le domaine canonique attendu par le runner, pour ne pas casser ses délégations. Le front affiche l'erreur renvoyée par l'API ; une signature annulée peut être réessayée avec une nouvelle clé de session.

La clé d'ingestion porte elle aussi un domaine. Accepter un alias pour le login tout en comparant cette clé uniquement à `location.origin` déplace le bug au dépôt du CSV. Le navigateur compare désormais la clé au domaine canonique de **son build**, en conservant le contrôle de son empreinte. Une clé de staging est refusée par un build main.

Le runner distant doit garder le même `SIRIUS_APP_ORIGIN` que Next. La pipeline ne reconfigure pas automatiquement la CVM. Une modification de son compose peut changer son identité mesurée : suivre [PHALA.md](PHALA.md).

## Rechargement et navigation

La reconnexion du provider EIP-1193 ne constitue pas une demande de navigation. L'accueil `/` reste sur le blob après restauration du wallet et de la session, y compris après plusieurs rechargements. L'accès au dashboard reste un clic explicite. Recharger une route déjà ouverte comme `/dashboard` conserve cette route.

L'ancien `LandingRedirect` et son drapeau `sirius.return-to-landing` ont été retirés. Ce drapeau ne survivait qu'à un retour vers l'accueil et provoquait ensuite des redirections surprenantes.

## Subtilités d'un changement de branche local

Changer de branche remplace les fichiers suivis ; cela ne remplace pas les fichiers ignorés ni l'état du navigateur.

| Élément persistant | Risque | Pratique attendue |
|---|---|---|
| `.vercel/project.json` | Déployer manuellement le code de staging vers le projet main, ou l'inverse | La pipeline recrée ce lien depuis la branche. Un lien local existant n'est pas une preuve de cible. |
| `.env`, `.env.local`, `.env.production.local`, `.vercel/.env.production.local` | Garder une base, une origine ou des adresses d'une autre cible | Vérifier les noms des variables et leur cible ; ne jamais afficher les secrets pour comparer. Un changement de branche ne télécharge pas les bonnes valeurs. |
| Variables exportées dans le terminal | Écraser silencieusement celles des fichiers `.env` | Elles ont priorité ; repartir d'un terminal configuré pour l'environnement voulu. |
| `.next`, `.vercel/output` | Réutiliser du JavaScript contenant les anciennes variables `NEXT_PUBLIC_*` | Reconstruire pour la cible ; un changement de variable à l'exécution ne corrige pas le bundle. |
| `node_modules`, Prisma généré, ABI | Garder des dépendances ou un client d'une autre révision | Réinstaller avec le lockfile, régénérer Prisma et les ABI seulement si leurs sources ont changé. |
| Cookie, IndexedDB et localStorage sur `localhost` | Conserver le compte, la délégation, les favoris et les préférences d'une autre branche | Se déconnecter puis se reconnecter après changement d'environnement. Le port sépare IndexedDB/localStorage, mais pas les cookies d'un même hôte. |
| PostgreSQL et volume de clés local | Confondre les données ou perdre la capacité de relivrer les modèles | Utiliser des bases et volumes séparés. Ne jamais remplacer une master key pour réparer le login. |
| CSV d'exemple locaux | Faire échouer les tests sur des fixtures absentes ou mal rangées | `pnpm datasets:generate` recrée les synthétiques au bon emplacement ; la pipeline le fait avant les tests. |

Pour Next, la priorité est : environnement du processus, `.env.$NODE_ENV.local`, `.env.local` (hors tests), `.env.$NODE_ENV`, `.env`. Prisma et les scripts qui utilisent seulement `dotenv/config` ne chargent pas automatiquement toute cette hiérarchie. Le runner de développement charge explicitement `.env.local`, puis `.env`.

Une valeur vide ou `[SENSITIVE]` issue d'un export Vercel ne constitue pas un secret utilisable. Le SQLite historique `file:...` ne convient plus à l'adaptateur PostgreSQL. Garder `SIRIUS_APP_ORIGIN=http://localhost:3000` et `NEXT_PUBLIC_SIRIUS_APP_ORIGIN` vide pour un développement sur cette origine ; ne pas placer les origines publiques de main dans un `.env.local` partagé avec staging.

## Vérifier sans déployer

### Échec du job Migrations

`check-evm-migration.ts` s'exécute **avant** `prisma migrate deploy`. S'il échoue, le déploiement Vercel est ignoré ; ce n'est pas une erreur du build front. La base vient du secret GitHub `DATABASE_URL` de l'environnement ciblé (`staging` pour la branche staging), pas du lien Vercel local.

Le préflight décrit l'hébergeur déduit du domaine, l'indice de pooler, le port et le mode TLS, sans afficher l'hôte ni les identifiants. Un hébergeur inconnu ou un pooler non détecté reste indéterminé. Il annonce ensuite chaque étape PostgreSQL puis RPC : la dernière étape affichée situe l'échec.

Le diagnostic conserve les codes SQLSTATE valides, même absents du dictionnaire de traduction. Le motif natif PostgreSQL est limité à une ligne, après masquage des URL et des composants de `DATABASE_URL` (y compris les identifiants encodés). L'objet d'erreur Prisma/RPC complet n'est jamais journalisé. Par exemple, `28P01` indique un refus d'authentification, `42P01` une table absente et `57P03` un serveur qui ne peut pas encore accepter de connexion. Voir les [codes PostgreSQL](https://www.postgresql.org/docs/current/errcodes-appendix.html). Ne pas appliquer les migrations ni contourner le préflight avant d'avoir identifié la cause.

L'avertissement de `pg-connection-string` sur `sslmode=require` annonce un futur changement de comportement ; il ne prouve pas un échec TLS. `sslmode=verify-full` rend explicite le comportement actuellement utilisé, mais ne répare ni les identifiants, ni le réseau, ni le schéma SQL. Ne pas désactiver la vérification des certificats pour faire passer ce contrôle.

Les premiers logs staging du 13 septembre ont affiché le message générique, puis seulement `P2010` à la détection de `Loan`. La première liste de diagnostics masquait certains SQLSTATE : ce défaut a été reproduit avec le vrai client Prisma et son adaptateur, puis corrigé.

Le troisième log confirme la cause : **Neon, connexion via pooler, SQLSTATE `53000`, quota de temps de calcul dépassé**. Le serveur refuse la connexion avant toute lecture applicative ou vérification EVM. Modifier la requête SQL, les certificats ou relancer les jobs ne rétablit pas le quota.

Pour remettre staging en service :

1. Ouvrir le projet concerné dans la console Neon et vérifier sa consommation et sa période de facturation.
2. Rétablir sa capacité de calcul. Sur l'offre gratuite, la suspension prend fin au renouvellement mensuel du quota ou au passage à une offre payante ; voir la [documentation officielle Neon](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md). La suspension pour quota ne supprime pas les données.
3. Une fois la connexion disponible, relancer les jobs échoués de la pipeline staging. Le préflight pourra alors poursuivre les contrôles SQL et EVM habituels.

La consommation est aussi à examiner côté worker : `src/worker/reaper.ts` interroge la base toutes les 30 secondes par défaut, même sans prêt à traiter. S'il fonctionne en continu sur cette base, il peut empêcher la mise en veille Neon après cinq minutes d'inactivité ; c'est une piste fondée sur le code, pas une mesure de consommation du compte. Voir [la gestion des computes Neon](https://neon.com/docs/manage/endpoints/). Ne pas arrêter un worker chargé de prêts actifs sans prévoir leur suivi. Aucun worker, quota, abonnement ou secret distant n'a été modifié pendant ce diagnostic.

### Échec du contrôle du reaper sur le VPS

Après rétablissement de Neon, le run staging du 13 septembre valide les migrations, Vercel et les smokes, mais échoue sur « Vérifier que le reaper tourne ». L'ancienne commande terminait par `grep -q 'reaper running'` : un conteneur arrêté ou en redémarrage donnait seulement un code 1, sans état ni logs. La première ligne `HOST=...` affichée par GitHub n'identifie pas la commande fautive.

Une incompatibilité de démarrage a été reproduite avec la configuration **distante** de Vercel staging, puis vérifiée sur le testnet : Escrow `0xede81141d007593d4bfce2de4778f753d167700e` est v5 et DatasetRegistry `0x18a6594a7a5b227b87808c733c40067d20357618` est v4 ; leurs liaisons réciproques sont correctes. Le worker appelait le contrôle v6 des nouveaux prêts et refusait donc ces contrats pourtant lisibles par son moteur de réconciliation.

Le worker utilise désormais un contrôle de lecture dédié qui accepte l'escrow v5 ou v6 avec le registre v4 correctement lié. Ce contrôle n'alimente pas le cache d'autorisation des nouveaux prêts : ceux-ci exigent toujours v6. Les erreurs métier de démarrage sont affichées sans exposer les erreurs RPC brutes.

`deploy/vps/check-reaper.sh` affiche l'état, le code de sortie, l'éventuel dépassement mémoire et le nombre de redémarrages du conteneur. En cas d'échec, il affiche les derniers logs du seul service `reaper` du projet ciblé. Il ne lit ni n'affiche la configuration des secrets. Ce contrôle vérifie le processus en cours d'exécution, pas la réussite de toutes les réconciliations futures.

Le fichier `/opt/sirius-staging/.env.vps` doit rester cohérent avec la configuration de l'application ; il n'a pas été consulté ni modifié pendant cette correction. Le correctif doit être publié pour reconstruire l'image worker et déployer son nouveau digest. Relancer uniquement l'ancien job VPS réutiliserait l'ancienne image.

### Contrôles locaux

```bash
node scripts/deployment-target.mjs staging
node scripts/deployment-target.mjs main
node --test scripts/deployment-target.test.mjs
pnpm datasets:generate
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

Les deux premières commandes affichent uniquement la cible versionnée, sans lire de secret, changer de branche ou appeler Git. Le smoke distant `node scripts/smoke-auth.mjs staging` vise exclusivement le déploiement staging ; son résultat dépend du code et de la configuration déjà publiés, pas des modifications locales.

Les tests locaux ne prouvent pas que DNS, Vercel, la base et Phala sont correctement configurés à distance. Un domaine absent ou inaccessible fait échouer le smoke même si son alias Vercel répond. Les constats ouverts et l'état observé de staging sont dans [l'audit du 12 septembre](AUDIT-STAGING-2026-09-12.md).

## Correctifs du 13 septembre

Next et `eslint-config-next` sont alignés sur `16.3.5`. Après changement de branche, réinstaller avec `pnpm install --frozen-lockfile` avant de lancer Next ; ne pas partager un ancien `node_modules` ou bundle entre ces versions. Le bloc généré par Next dans `AGENTS.md` ne change pas la règle du projet : ce fichier reste exclu du suivi.

La vérification CI exécute `pnpm audit:deps`. Les alertes modérées, hautes et critiques bloquent ; les alertes faibles restent visibles. Au 13 septembre, une alerte faible `elliptic` n’a pas de correction publiée. Voir [le suivi des correctifs](AUDIT-CORRECTIFS-2026-09-13.md).

Changer de compte, de provider ou de réseau invalide désormais une connexion en cours et recrée les états privés. Cela ne remplace pas la déconnexion/reconnexion nécessaire quand les secrets, la base ou le domaine d’un même localhost changent avec la branche.

Le registre KYB strict passe à v3 (domaine EIP-712 `2`, époque signée). La migration reste indépendante du déploiement Next. Garder les anciens escrows dans `SIRIUS_LEGACY_ESCROW_ADDRESSES` pour les crédits et les preuves, et tester le retrait dans Wallet après release/refund.

### Échec des tests de solde en CI

Les premiers tests A1/A5 passaient localement grâce à l’adresse USDC de `.env.local`, absente du job GitHub de vérification. `fetchUsdcBalance` résout cette adresse avant d’appeler `eth_call` : sans elle, le mock ne reçoit jamais la lecture. Les tests Wallet/Dashboard attendent donc une réponse retardée qui n’existe pas ; celui du retrait confirme le crédit à zéro mais ne peut pas afficher le nouveau solde.

`playwright.config.ts` définit désormais une adresse USDC factice identique dans `SIRIUS_USDC_ADDRESS` et `NEXT_PUBLIC_SIRIUS_USDC_ADDRESS` pour son serveur de test. Ces valeurs remplacent celles du terminal ou des `.env` locaux et ne configurent aucun déploiement. Il ne faut pas ajouter de secrets de staging à ce job ni augmenter les timeouts pour résoudre ce cas.

Après une modification des tests E2E, vérifier aussi depuis une copie sans `.env*`, avec un environnement de processus nettoyé et un seul worker. Une suite verte dans le dossier de développement ne suffit pas à valider la configuration CI.
