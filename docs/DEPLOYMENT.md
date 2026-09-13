# Branches, déploiements et authentification

État du code au 12 septembre 2026. La configuration est implémentée localement sur `staging` et sera utilisée sur `main` après publication, fusion et passage de la pipeline. Une modification locale ne met pas à jour une instance déjà déployée.

Les corrections F1–F4 du 13 septembre ajoutent une migration contractuelle distincte : lire [ESCROW-V6.md](ESCROW-V6.md) avant de publier la nouvelle version. Le choix automatique des origines ne déploie pas les contrats.

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

Les deux logs staging signalés le 13 septembre ont d'abord affiché le message générique, puis seulement `P2010` à la détection de `Loan`. Le second situe l'échec sur la première requête PostgreSQL, avant le RPC ; `P2010` seul ne distingue pas une erreur de connexion d'une erreur SQL. La première liste de diagnostics masquait certains SQLSTATE : ce défaut a été reproduit avec le vrai client Prisma et son adaptateur, puis corrigé. La cause distante reste à confirmer avec le code natif et son motif ; aucun secret distant n'a été modifié.

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
