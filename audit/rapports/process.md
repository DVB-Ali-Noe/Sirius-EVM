# Audit du processus : comment le code est arrivé en staging (PR #105 à #124)

Date : 23 octobre 2026. Base auditée : `origin/staging` au commit `f31a917` (fusion de la PR #124).

Ce rapport décrit des faits. Il ne juge personne : il dit ce que GitHub et le dépôt enregistrent, et ce qu'ils
n'enregistrent pas.

## 1. Méthode

- `gh` est disponible et authentifié (compte `alibenyezza`). Toutes les données viennent de l'API GitHub, en
  lecture seule, et de `git log` sur `origin/staging`.
- Pour chaque numéro de 105 à 124 : `gh pr view <n> --json …` (auteur, fusion, dates, relectures, commentaires,
  texte, statut CI), `gh api repos/DVB-Ali-Noe/Sirius-EVM/pulls/<n>/comments` (commentaires de relecture en ligne),
  `gh api …/pulls/<n>/commits`.
- Pipeline après fusion : `gh run list --branch staging --event push`, puis `gh run view <id> --json jobs`.
- Réglages lus sans rien modifier : `gh api repos/DVB-Ali-Noe/Sirius-EVM`, `…/branches/<b>`,
  `…/branches/<b>/protection`, `…/rulesets`, `…/environments`, `…/actions/permissions/workflow`,
  `…/collaborators`, `gh secret list` (noms seulement, jamais de valeur).
- `docs/` : recherche par motifs (adresses IP, chemins serveur, comptes SSH, identifiants Vercel, etc.). Les
  valeurs ne sont pas recopiées ici : seulement le fichier, la ligne et le type d'information.

Les commandes sont rappelées dans chaque constat pour pouvoir refaire la vérification.

## 2. Tableau des PR #105 à #124

Faits communs à toutes les PR de la période :

- **Auteur** : `CHAAIISE` (Noé) pour les 19 PR. **Fusionnées par** : `CHAAIISE` pour les 18 PR fusionnées.
- **Base** : `staging` pour toutes. Aucune n'a visé `main`.
- **Relectures humaines** : 0. Aucune approbation, aucune demande de changement. `reviewDecision` est vide partout.
- **Relectures Copilot** : 18 « relectures » enregistrées (toutes les PR sauf #120), **toutes vides**. Chacune
  contient le même texte : *« Copilot was unable to review this pull request because the user who requested the
  review has reached their quota limit. »* Aucun commentaire en ligne de Copilot ni de personne (0 sur les 19 PR).
- **CI sur la PR** (événement `pull_request`, dernier commit) : `Vérification` = succès ; `Cible`, `Images`,
  `Migrations`, `Front Vercel`, `Reaper sur le VPS`, `Fumée` = sautés. C'est le comportement prévu du workflow
  (voir partie 4).
- **CI après fusion** (événement `push` sur `staging`, commit de fusion) : les 7 jobs en succès pour les 18 fusions.
- **CI terminée avant la fusion** : oui pour les 18. Aucune autre PR n'a été fusionnée dans `staging` entre le
  début de la CI d'une PR et sa fusion : aucune fusion sur une base périmée.
- **Commits directs sur `staging`** : aucun. Les 18 commits de premier parent depuis `3ba030c` sont tous des
  commits de fusion « Merge pull request #… ».

| PR | Titre | Créée → fusionnée | Fin de CI → fusion | Relecture | CI PR | CI push staging |
|---|---|---|---|---|---|---|
| #105 | fix(training): support bounded 30k-row CSVs | 1 h 53 | 6 min 28 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #106 | fix(phala-demo): visible refusals, no orphan drafts, readable attestation page | 0 h 41 | 30 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #107 | test(phala-demo): align wallet connection scenario with the wallet choice menu | 0 h 18 | 5 min 14 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #108 | docs(phala-demo): demo alias move and 30k-row logistic measurement | 0 h 36 | 24 min 48 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #109 | refactor(phala-demo): drop unreachable sign-in label | 0 h 24 | 12 min 53 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #110 | feat(phala-demo): attestation page as a verifiable chain of trust | 0 h 28 | 26 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #111 | feat(models): profil gradient_boosted_trees v1 (phase 1, désactivé) | 5 h 30 | 31 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #112 | *Issue, pas une PR* : « TEE : RTMR0–2 et événements os-image-hash / app-id / key-provider non contrôlés » (ouverte le 18 oct., toujours ouverte) | — | — | — | — | — |
| #113 | feat(phala-demo): publish attested app-compose (image proven) | 1 h 00 | 49 min 55 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #114 | fix(phala-demo): attestation page always showed 'Too many checks' | 0 h 14 | 31 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #115 | docs: politique de sortie de l'enclave et API sur modèles privés (D-27) | 0 h 39 | 29 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #116 | Arbres boostés — préparation phase 2 staging (brouillon) | 5 h 58 | 59 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #117 | feat(datasets): rapport de qualité à l'import, dans le navigateur (E1) | 0 h 51 | 1 min 01 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #118 | feat(phala): rapport de qualité sur la cible choisie | 2 h 42 | 5 min 26 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #119 | feat(datasets): conversions silencieuses de Number() dans le rapport de qualité | 0 h 27 | 13 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #120 | docs: préparation des sessions GBDT et financement à 9 USD | **non fusionnée** (fermée après 1 h 54) | — | aucune | V ✓, 6 sautés | — |
| #121 | fix: empêcher les CSV invalides de couper le runner | 0 h 17 | 26 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #122 | docs: session staging arbres et release attestée | 0 h 14 | 20 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #123 | fix: les refus ne consomment plus le budget sponsorisé (audit N1) | 0 h 43 | 28 min 49 s | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |
| #124 | docs: release runner attestée 2fdc091 (correctif N1) | 2 h 18 | 2 h 04 min | Copilot vide | V ✓, 6 sautés | 7/7 ✓ |

Légende : « V ✓ » = job `Vérification` en succès ; « 6 sautés » = `Cible`, `Images`, `Migrations`,
`Front Vercel`, `Reaper sur le VPS`, `Fumée` à l'état `SKIPPED`. « 7/7 ✓ » = les 7 jobs en succès sur le run `push`
du commit de fusion.

Remarques factuelles :

- 10 des 18 fusions ont lieu **moins d'une minute** après la fin de la CI (#106, #110, #111, #114, #115, #116,
  #117, #119, #121, #122). La fusion automatique est désactivée sur le dépôt (`allow_auto_merge: false`). Qui, ou
  quoi, a déclenché la fusion depuis le compte `CHAAIISE` : **NON VÉRIFIÉ** (GitHub ne le distingue pas).
- Plusieurs textes de PR et `docs/GBDT-PHASE2.md:70` décrivent un agent IA qui rédige les PR (« Agent (moi) »,
  « `Moi` = cet agent ») et un « agent principal » qui exécute les commandes VPS et Phala. Ces agents agissent sous
  des comptes humains : GitHub ne permet pas de distinguer une action de l'agent d'une action de la personne.
- Le seul commentaire de discussion humain de la période est celui de `CHAAIISE` sur #117 (capture d'écran
  décrite) et la note de fermeture de #120.
- Juste avant la période, les fusions de #91, #92, #96, #97, #99, #101 et #103 dans `staging` portent le nom
  `alibenyezza` (commit de fusion). De #105 à #124, toutes portent `CHAAIISE`. Les auteurs des PR antérieures à #105
  n'ont pas été relevés : **NON VÉRIFIÉ** hors période.

## 3. PR marquées « brouillon » ou « ne pas fusionner »

Recherche dans le titre et le texte de chaque PR : « brouillon », « ne pas fusionner », « draft », « WIP »,
« do not merge ». Les mentions de « brouillon de dataset » (vocabulaire métier, #106, #111, #121, #123) sont
écartées.

| PR | Mention exacte (extrait) | Marquée « Draft » dans GitHub | Issue | Date |
|---|---|---|---|---|
| #115 | « **Brouillon : ne pas fusionner sans accord de Noé.** » | non | **fusionnée** par `CHAAIISE` | 19 oct. 00:18:19 UTC, 29 s après la CI |
| #116 | titre « … (brouillon) » et « **Brouillon — ne pas fusionner sans l'accord de Noé.** » | non | **fusionnée** par `CHAAIISE` | 19 oct. 18:20:08 UTC, 59 s après la CI |
| #117 | « **Brouillon : ne pas fusionner sans accord de Noé.** » | non | **fusionnée** par `CHAAIISE` | 19 oct. 13:36:15 UTC, 1 min après la CI |
| #118 | « **Brouillon : ne pas fusionner sans accord de Noé.** » | non | **fusionnée** par `CHAAIISE` | 19 oct. 18:50:04 UTC, 5 min 26 s après la CI |
| #119 | « **Brouillon : ne pas fusionner sans accord de Noé.** » | non | **fusionnée** par `CHAAIISE` | 19 oct. 21:55:40 UTC, 13 s après la CI |
| #120 | « Ne pas fusionner sans accord de Noé. » | **oui** (`isDraft: true`) | **non fusionnée**, fermée par `CHAAIISE` | 20 oct. 10:08:00 UTC, avec la note « Fermée sur décision de Noé » |
| #122 | « Brouillon : ne pas fusionner sans accord de Noé. » | non | **fusionnée** par `CHAAIISE` | 20 oct. 10:13:06 UTC, 20 s après la CI |

Faits :

- 6 PR portent la mention et sont fusionnées ; 1 (#120) est restée non fusionnée.
- La condition écrite est « l'accord de Noé ». Les 6 PR sont fusionnées depuis le compte de Noé. **Aucune trace de
  cet accord** n'existe dans GitHub (ni approbation, ni commentaire), sauf pour #121, dont le texte dit « Fusion
  staging autorisée par Noé après CI verte du dernier commit » : c'est une phrase de l'auteur, pas un acte de Noé.
- Le mot « brouillon » écrit dans le texte n'empêche rien : seul le statut « Draft » de GitHub bloque le bouton de
  fusion. Il n'a été utilisé que pour #120, ce qui montre qu'il fonctionne sur ce dépôt.
- Le titre de #116 contenait encore « (brouillon) » au moment de la fusion.
- Si l'accord a été donné ailleurs (oral, messagerie) : **NON VÉRIFIÉ**.

## 4. Pipeline : jobs qui tournent sur staging, jobs sautés

Un seul workflow : `.github/workflows/pipeline.yml`. Déclencheurs : `push` sur `main` et `staging`, et
`pull_request` (toutes branches) (`pipeline.yml:29-32`).

| Job (nom affiché) | Dépend de | Sur une PR | Sur un push `staging` | Pourquoi |
|---|---|---|---|---|
| `verify` (Vérification) | — | **tourne** | tourne | aucune condition (`pipeline.yml:46`) |
| `cible` (Cible) | — | **sauté** | tourne | `if: github.event_name == 'push'` (`pipeline.yml:137`) |
| `image` (Images) | verify, cible | **sauté** | tourne | dépend de `cible`, sauté sur PR (`pipeline.yml:172`) |
| `migrate` (Migrations) | verify, cible | **sauté** | tourne | idem (`pipeline.yml:233`) |
| `vercel` (Front Vercel) | verify, cible, migrate | **sauté** | tourne | idem (`pipeline.yml:263`) |
| `vps` (Reaper sur le VPS) | cible, image, migrate | **sauté** | tourne | idem (`pipeline.yml:336`) |
| `fumee` (Fumée) | cible, vercel | **sauté** | tourne | idem (`pipeline.yml:409`) |

Contenu de `Vérification` (`pipeline.yml:79-133`) : installation figée, `pnpm audit:deps` (niveau `moderate`),
génération des jeux synthétiques, `tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm test:phala-demo`,
`pnpm test:operations`, `pnpm test:postgres` (PostgreSQL 17 en service), `pnpm contracts:test`, `pnpm test:billing`,
typage v7, `pnpm build`, Playwright (`pnpm test:e2e`).

Ce que la pipeline ne fait pas, ou ne vérifie pas :

- **Scénarios e2e de `/phala`** : `playwright.config.ts:16` les exclut (`testIgnore: "**/phala/**"`) ; ils ne
  tournent qu'avec `playwright.phala.config.ts`, qui n'est appelé nulle part dans la CI. Les PR #118 et #119 le
  disent (« Ce fichier e2e ne tourne pas en CI »). Les résultats e2e Phala annoncés dans les PR sont donc locaux.
- **Image runner sur la CVM Phala** : construite et publiée par `Images` après fusion, mais jamais déployée par la
  pipeline (`pipeline.yml:23-25`, `209-213`, `226-229`). Le déploiement sur la CVM est manuel, par choix documenté.
- **Contrats** : jamais déployés par la pipeline (`pipeline.yml:23-25`), par choix documenté.
- **Hôte de démonstration** (`demo.sirius-data.tech`) : alias posé sur un déploiement Vercel figé
  (`scripts/deployment-target.mjs:19`, `docs/PHALA-DEMO-IMPLEMENTATION.md:544`). Un push vert sur `staging` ne le
  met pas à jour ; le déplacement de l'alias est manuel (#108, #116, #122).
- **Images construites seulement après fusion** : `image` est sauté sur une PR. Une modification du runner ne peut
  donc être essayée sur la CVM qu'une fois fusionnée dans `staging`. La PR #105 listait « Avant fusion : déployer
  l'image staging, attester le nouveau hash, mesurer 30 000 lignes sur tdx.small » ; la mesure sur la CVM est
  rapportée ensuite par #106 et #108, après la fusion.
- **Pas de filtre de chemins** : une PR de documentation seule (#108, #115, #122, #124) déclenche après fusion la
  reconstruction des images, les migrations, le redéploiement Vercel et le redémarrage du reaper staging.
- **`Fumée`** vérifie seulement un HTTP 200 sur l'URL publique de la cible et les challenges de connexion
  (`pipeline.yml:418-434`).

Autres points de la pipeline, relevés au passage :

- Permissions du jeton : défaut du dépôt en lecture (`default_workflow_permissions: read`), les Actions ne peuvent
  pas approuver de PR (`can_approve_pull_request_reviews: false`). `image` élève à `packages: write`, `vps` à
  `packages: read`.
- Les actions tierces sont épinglées par étiquette (`actions/checkout@v4`, `docker/login-action@v3`,
  `docker/build-push-action@v6`…), pas par empreinte de commit.
- `pipeline.yml:292-293` écrit en clair l'identifiant d'organisation Vercel dans le workflow, puis l'affiche dans le
  journal (`cat .vercel/project.json`). Le commentaire `pipeline.yml:279-283` dit que ce n'est pas un secret.
- `pipeline.yml:19-21` affirme qu'« une cible ne peut pas atteindre les identifiants de l'autre ». Ce n'est vrai que
  pour les secrets d'environnement : le dépôt a aussi 9 secrets **au niveau du dépôt** (voir PRO-04).
- Les 18 runs `push` sur `staging` de la période sont en succès (7/7 jobs). Le dernier échec de la pipeline sur
  `staging` remonte au 8 octobre (fusion de #88), hors période.

## 5. Informations d'exploitation dans `docs/`

Les valeurs ne sont **pas** recopiées. Les lignes ont été trouvées par motifs puis classées une à une avec les
valeurs masquées. `docs/` n'est pas servi par le site : aucun fichier de `src/` ni `next.config.ts` ne lit `docs/`.
L'exposition se limite donc aux personnes et aux outils (agents IA compris) qui lisent le dépôt, et à tous si le
dépôt redevient public (hypothèse évoquée dans la PR #110).

| Type d'information | Fichier:ligne |
|---|---|
| **Adresse IP publique du VPS** (même adresse partout) | `docs/DEPLOYMENT.md:7`, `docs/GBDT-PHASE2.md:70`, `docs/OPERATIONS-ACCOUNTING.md:85`, `docs/PHALA-DEMO-RUNBOOK.md:77`, `docs/PHALA-TRIAL-CREDITS.md:59`, `docs/PHALA-V7-STAGING.md:22`, `docs/VPS-MIGRATION.md:5`, `docs/VPS-MIGRATION.md:65`, `docs/VPS-MIGRATION.md:112`, `docs/passage-mainnet/19-mise-en-production.md:28`, `:51`, `:266` |
| **Valeur d'un secret GitHub écrite en clair** (valeur attendue de `VPS_HOST`) | `docs/VPS-MIGRATION.md:112` |
| **Format complet attendu du secret `VPS_KNOWN_HOSTS`** (avec l'adresse) | `docs/VPS-MIGRATION.md:65` |
| **Empreinte de clé d'hôte SSH du VPS** et comptes système vérifiés | `docs/VPS-MIGRATION.md:5` |
| **Compte SSH « utilisateur@adresse »** du serveur de production | `docs/passage-mainnet/19-mise-en-production.md:51`, `:266` |
| **Comptes système, dossiers et projets Compose du VPS** (staging et production) | `docs/passage-mainnet/19-mise-en-production.md:28`, `:267`, `:280`, `:304`, `:403` ; `docs/VPS-MIGRATION.md:10`, `:35`, `:62`, `:71-73`, `:91`, `:96`, `:100`, `:131`, `:133`, `:137` ; `docs/PHALA-DEMO-RUNBOOK.md:69`, `:77`, `:79` ; `docs/PHALA-TRIAL-CREDITS.md:39`, `:48`, `:50-52`, `:57`, `:59` ; `docs/PHALA.md:101`, `:159` ; `docs/DEPLOYMENT.md:42`, `:85-86`, `:188` ; `docs/MAINNET-RUNBOOKS.md:33-34`, `:74` ; `docs/OPERATIONS-PREPARATION.md:119` ; `docs/GBDT-PHASE2.md:138` ; `docs/PHALA-DEMO-IMPLEMENTATION.md:301`, `:442`, `:448`, `:766`, `:774`, `:778` ; `docs/PHALA-V7-STAGING.md:23` ; `docs/passage-mainnet/20-finalite-rapide.md:98` ; `docs/passage-mainnet/AUDIT-2026-10-05.md:43`, `:191`, `:351` ; `docs/passage-mainnet/audit.md:1408`, `:1428` |
| **Chemin et nom du fichier d'environnement du serveur** (`.env.vps` et variantes) | 42 lignes, dont `docs/DEPLOYMENT.md:40-48`, `:142`, `:188` ; `docs/VPS-MIGRATION.md:10`, `:12`, `:79`, `:85`, `:91`, `:97` ; `docs/passage-mainnet/19-mise-en-production.md:267-306`, `:403`, `:490-492`, `:550` ; `docs/MAINNET-RUNBOOKS.md:74-76` ; `docs/PHALA-DEMO-IMPLEMENTATION.md:377`, `:428`, `:774` ; `docs/passage-mainnet/AUDIT-2026-10-05.md:43-45`, `:191`, `:203`, `:351` ; `docs/PHALA.md:74` ; `docs/PHALA-V7-STAGING.md:21` ; `docs/GBDT-PHASE2.md:112` ; `docs/DEMO.md:108` ; `docs/PHALA-DEMO-RESTE-A-FAIRE.md:154` ; `docs/passage-mainnet/20-finalite-rapide.md:98`, `:120` |
| **État de sécurité du serveur** (port ouvert, pare-feu, port d'écoute interne d'un service, watchdog désactivé, anciens services non arrêtés) | `docs/PHALA-DEMO-RUNBOOK.md:83`, `docs/OPERATIONS-ACCOUNTING.md:85` |
| **Identifiant de projet Vercel** | `docs/PHALA.md:101`, `docs/passage-mainnet/19-mise-en-production.md:26` |
| **Nom d'équipe Vercel dérivé d'une adresse e-mail personnelle**, dans des URL de déploiement | `docs/AUDIT-STAGING-2026-09-12.md:92`, `docs/DEPLOYMENT.md:91`, `:93`, `docs/PHALA-DEMO-IMPLEMENTATION.md:544`, `:546`, `:550`, `:554`, `docs/PHALA.md:101`, `docs/passage-mainnet/19-mise-en-production.md:25` (et hors `docs/` : `scripts/deployment-target.mjs:20`) |
| **URL de déploiement Vercel figé** (cible de retour arrière de l'hôte de démonstration) | `docs/PHALA-DEMO-IMPLEMENTATION.md:544`, `:546`, `:550`, `:554` |
| **Adresse e-mail personnelle** (autre que l'adresse de contact publique de l'application) | `docs/PHALA-INTEGRATION-BRIEF.md:220` |
| **Compte déployeur et trésorerie testnet** : adresse, nom de la variable de clé privée présente dans un `.env` local, solde relevé | `docs/PHALA.md:51` |
| **Chemin local privé** d'un poste (prototypes hors dépôt) | `docs/EGRESS-POLICY-API.md:291` |
| **Organisation des accès** : qui (personne ou agent) a accès au VPS et à la CLI Phala | `docs/GBDT-PHASE2.md:70`, `docs/passage-mainnet/19-mise-en-production.md:51` |

Classés comme **non sensibles** après examen (pas des constats) :

- 18 lignes contenant une valeur hexadécimale de 64 caractères : ce sont des empreintes de bytecode (code hash
  USDC/USDG) ou des hachages de transaction, publics par nature (`docs/PHALA-V7-STAGING.md:28-31`,
  `docs/MAINNET-RUNBOOKS.md:132`, etc.). Aucune clé privée trouvée.
- Les 2 URL de RPC repérées sont des RPC publics ou des liens de documentation, sans clé
  (`docs/PHALA-V7-STAGING.md:54`, `docs/passage-mainnet/19-mise-en-production.md:534`).
- Les ports `127.0.0.1:5432` de `docs/passage-mainnet/audit.md` décrivent la base PostgreSQL locale des tests.
- L'adresse de contact publique de l'application (16 lignes, la même que dans `src/lib/copy/disclaimers.ts`).
- Les motifs `phala@1.x` et `pnpm@…` sont des versions de paquets, pas des adresses e-mail.
- Aucun jeton d'accès (`ghp_`, `gho_`, `sk-`, `AKIA`, JWT) trouvé dans `docs/`.

Hors `docs/` mais lié : le texte de la PR #120 cite le chemin du fichier d'environnement staging sur le VPS, et
celui de la PR #117 un chemin local privé. Les textes de PR sont visibles par toute personne ayant accès au dépôt.

## 6. Règles de relecture et de protection compatibles GitHub Free, dépôt privé, deux fondateurs

### Ce que l'offre actuelle permet ou non (constaté)

- Le dépôt est **privé**, propriété d'une **organisation** à l'offre **free** (`gh api orgs/DVB-Ali-Noe`).
- Protection de branche et rulesets : **indisponibles**. `GET …/branches/staging/protection` et `GET …/rulesets`
  répondent 403 « Upgrade to GitHub Pro or make this repository public to enable this feature ».
  `staging` et `main` : `protected: false`.
- Deux collaborateurs, tous deux **admin** : `alibenyezza` et `CHAAIISE`.
- Le statut « Draft » des PR fonctionne (#120 l'utilise).
- Les environnements existent et sont appliqués par la pipeline (des déploiements `staging` et `production` sont
  enregistrés). `production` a une règle de branche (`main` seulement) ; `staging` n'en a aucune. Aucun des deux n'a
  de relecteur obligatoire. Que la règle de branche de `production` soit réellement appliquée sur un dépôt privé en
  offre Free : **NON VÉRIFIÉ** (la documentation GitHub réserve ces fonctions aux offres payantes pour les dépôts
  privés ; à confirmer par un essai).

### Option A — rester sur Free : règles par convention, rendues vérifiables par la pipeline

GitHub ne peut pas bloquer le bouton de fusion. La pipeline, elle, peut refuser de **déployer**. C'est le levier
réel sur Free.

1. **Deux mains pour les zones sensibles.** Toute PR qui touche `src/lib/tee/`, `src/runner/`, `contracts/`,
   `src/lib/billing/`, `prisma/migrations/`, `.github/workflows/`, `deploy/`, `scripts/operations/` reçoit une
   approbation (« Approve ») de **l'autre** fondateur avant fusion. L'auteur ne fusionne pas sa propre PR sensible.
   Les PR de documentation seule peuvent rester en auto-fusion par l'auteur.
2. **Garde de relecture dans la pipeline.** Ajouter un job `relecture` sur `push` vers `staging` et `main`, dont
   dépendent `image`, `migrate`, `vercel` et `vps` : il retrouve la PR du commit de fusion
   (`GET /repos/{owner}/{repo}/commits/{sha}/pulls`), et échoue si la PR touche une zone sensible sans approbation
   d'un compte différent de l'auteur, ou si son titre ou son texte contient encore « brouillon » ou « ne pas
   fusionner ». Le jeton du workflow suffit (`pull-requests: read`). Effet : une fusion non relue arrive dans la
   branche mais **n'est pas déployée**.
3. **Brouillon = statut Draft, pas un mot.** Ouvrir en « Draft » toute PR qui ne doit pas être fusionnée ; la
   passer en « Ready for review » seulement quand l'accord est donné. Le job `relecture` ci-dessus sert de filet si
   le mot reste dans le texte.
4. **Accord écrit dans GitHub.** Quand une PR dit « sans accord de X », l'accord prend la forme d'une approbation de
   X dans la PR. Un accord donné ailleurs n'est pas traçable.
5. **Agents IA sous leur propre identité.** Faire ouvrir les PR des agents par un compte machine ou une GitHub App
   distincte (droits d'écriture, pas d'admin), et réserver la fusion aux deux fondateurs. Le job `relecture` peut
   alors refuser une fusion faite par ce compte. Sur Free, un compte avec droit d'écriture peut techniquement
   fusionner : la garde de la pipeline reste nécessaire.
6. **Secrets.** Supprimer les secrets du niveau dépôt qui doublonnent ceux des environnements ; créer
   `VERCEL_TOKEN` dans chaque environnement (idéalement un jeton par projet) ; ajouter à l'environnement `staging`
   une règle de branche `staging` seulement ; supprimer les secrets orphelins (PRO-04, PRO-11). But : une PR qui
   modifie le workflow ne peut plus lire de secret.
7. **Poussées directes.** Ajouter aux hooks globaux `pre-push` des deux postes (et des environnements d'agents) un
   refus de toute poussée vers `refs/heads/staging` et `refs/heads/main`. Non garanti côté serveur, mais cela évite
   l'erreur.
8. **Copilot.** La relecture automatique est demandée mais ne s'exécute plus (quota atteint). Soit rétablir le
   quota ou la facturation par l'organisation, soit retirer la demande automatique pour ne plus afficher une
   « relecture » vide.

### Option B — passer à une offre payante (Team pour une organisation)

Les fonctions bloquées aujourd'hui (protection de branche, rulesets, statuts requis, approbation requise) se
débloquent. Réglage minimal proposé pour deux fondateurs : sur `staging` et `main`, PR obligatoire, 1 approbation
obligatoire d'une autre personne que l'auteur, statut `Vérification` requis, branche à jour avant fusion,
interdiction du force-push et de la suppression ; sur `main`, en plus, relecteur obligatoire sur l'environnement
`production`. Avec seulement deux personnes, exiger une approbation sur toutes les PR bloquerait aussi la
documentation : une variante consiste à mettre 0 approbation générale, activer « Require review from Code Owners »
et lister dans un fichier `CODEOWNERS` les zones sensibles du point 1 de l'option A, attribuées aux deux fondateurs.
Une PR sensible attend alors l'autre fondateur (l'auteur ne peut pas approuver sa propre PR), une PR de
documentation non. Prix et périmètre exact de l'offre :
**NON VÉRIFIÉ** (à lire sur la page de tarifs GitHub).

## 7. Constats

### PRO-01 — Aucune relecture effective sur les 18 PR fusionnées

- **Sévérité** : Haute
- **Où** : PR #105 à #124 (sauf #112, issue, et #120, non fusionnée)
- **Ce qui se passe** : 0 relecture humaine, 0 approbation, 0 commentaire de relecture en ligne. Les 18
  « relectures » Copilot sont toutes des messages d'échec (« Copilot was unable to review this pull request because
  the user who requested the review has reached their quota limit »). L'auteur et la personne qui fusionne sont le
  même compte pour les 18 PR. Parmi elles : un nouveau profil de modèle et une version v5 du contrat de registre
  (#111, dont le texte dit « Ce changement devra passer en audit avant mainnet »), la facturation du runner (#123),
  la page d'attestation (#110, #113, #114).
- **Comment le vérifier** : `gh pr view <n> --json reviews,author,mergedBy` ; `gh api
  repos/DVB-Ali-Noe/Sirius-EVM/pulls/<n>/comments` (liste vide).
- **Correction proposée** : partie 6, option A points 1, 2 et 8 (ou option B).

### PRO-02 — Aucune protection sur `staging` ni `main`

- **Sévérité** : Haute
- **Où** : réglages du dépôt ; `staging` et `main`
- **Ce qui se passe** : protection de branche et rulesets indisponibles sur l'offre actuelle (403). Les deux comptes
  admin, et tout outil ou agent qui agit avec leurs identifiants, peuvent pousser directement, réécrire l'historique
  ou supprimer `staging` et `main`, et fusionner sans CI verte. Fait observé : sur la période, aucun commit direct
  (les 18 commits de premier parent sont des fusions de PR) et la CI était verte avant chaque fusion. Ces bonnes
  pratiques ne tiennent qu'à la discipline.
- **Comment le vérifier** : `gh api repos/DVB-Ali-Noe/Sirius-EVM/branches/staging --jq .protected` (false) ;
  `gh api repos/DVB-Ali-Noe/Sirius-EVM/branches/staging/protection` (403) ;
  `git log --first-parent --format='%h %s' origin/staging`.
- **Correction proposée** : partie 6, option A points 2 et 7, ou option B.

### PRO-03 — « Brouillon : ne pas fusionner » sans effet ni trace d'accord

- **Sévérité** : Moyenne
- **Où** : PR #115, #116, #117, #118, #119, #122 (fusionnées) ; #120 (non fusionnée)
- **Ce qui se passe** : 6 PR dont le texte dit « ne pas fusionner sans accord de Noé » sont fusionnées, entre 13 s et
  5 min 26 s après la fin de la CI. Aucune n'a le statut Draft de GitHub. Aucune approbation ni commentaire ne
  matérialise l'accord. Les fusions sont faites depuis le compte de Noé, ce qui est compatible avec un accord, mais
  rien ne permet de le distinguer d'une fusion faite par un agent sous ce compte (PRO-05).
- **Comment le vérifier** : `gh pr view <n> --json title,body,isDraft,mergedAt,mergedBy,reviews,comments`.
- **Correction proposée** : partie 6, option A points 2, 3 et 4.

### PRO-04 — Secrets au niveau du dépôt, lisibles depuis n'importe quelle branche

- **Sévérité** : Haute
- **Où** : réglages Actions du dépôt ; `.github/workflows/pipeline.yml:19-21`, `:253`, `:300`, `:360-369`
- **Ce qui se passe** : 9 secrets sont définis **au niveau du dépôt**, dont `DATABASE_URL`, `VERCEL_TOKEN`,
  `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`. Un secret du dépôt est lisible par tout workflow, sur
  toute branche, y compris un run `pull_request` d'une branche du dépôt dont le `pipeline.yml` a été modifié, avant
  toute relecture. L'environnement `staging` (qui contient la base, le RPC et l'accès SSH du VPS) n'a pas de règle
  de branche. `VERCEL_TOKEN` n'existe qu'au niveau du dépôt : staging et production partagent donc le même jeton,
  ce qui contredit le commentaire `pipeline.yml:19-21` (« une cible ne peut pas atteindre les identifiants de
  l'autre »). Quelle base et quel serveur désignent les secrets du niveau dépôt : **NON VÉRIFIÉ** (valeurs non
  lisibles, et non lues).
- **Comment le vérifier** : `gh secret list -R DVB-Ali-Noe/Sirius-EVM` ; `gh secret list --env staging` ;
  `gh secret list --env production` ; `gh api repos/DVB-Ali-Noe/Sirius-EVM/environments`.
- **Correction proposée** : partie 6, option A point 6. Faire tourner (renouveler) la clé SSH du VPS et le jeton
  Vercel après le ménage si l'on ne peut pas exclure qu'une branche les ait lus.

### PRO-05 — Les agents IA agissent sous les comptes des fondateurs

- **Sévérité** : Moyenne
- **Où** : PR #116 (tableau « Agent (moi) », « Agent VPS »), #110 (« l'agent demo-followups »),
  `docs/GBDT-PHASE2.md:70`
- **Ce qui se passe** : les textes décrivent des agents qui rédigent les PR, préparent les commandes et, pour
  « l'agent principal », exécutent les commandes VPS et Phala. Toutes les PR et fusions de la période apparaissent
  sous `CHAAIISE`. 10 fusions sur 18 ont lieu moins d'une minute après la fin de la CI, alors que la fusion
  automatique est désactivée. Il est impossible, avec les traces GitHub, de dire si une fusion est une décision
  humaine.
- **Comment le vérifier** : `gh pr view 116 --json body` ; `gh api repos/DVB-Ali-Noe/Sirius-EVM --jq
  .allow_auto_merge` ; comparer `mergedAt` et `completedAt` du job `Vérification` dans `statusCheckRollup`.
- **Correction proposée** : partie 6, option A point 5.

### PRO-06 — Les scénarios e2e de `/phala` ne tournent pas en CI

- **Sévérité** : Moyenne
- **Où** : `playwright.config.ts:16` ; `playwright.phala.config.ts:5` ; `.github/workflows/pipeline.yml:132-133`
- **Ce qui se passe** : `pnpm test:e2e` lance `playwright.config.ts`, qui ignore `e2e/phala/**`. Aucun job n'appelle
  `playwright.phala.config.ts`. Les PR #107, #109, #118 et #119 modifient le parcours `/phala` et annoncent « 6/6 »
  ou « 7/7 » e2e Phala, vérifiés en local seulement.
- **Comment le vérifier** : lire les deux fichiers de configuration ; chercher `playwright.phala` dans
  `.github/workflows/` (aucun résultat).
- **Correction proposée** : ajouter une étape `pnpm exec playwright test -c playwright.phala.config.ts` au job
  `Vérification`, après les e2e existants.

### PRO-07 — Les images ne sont construites qu'après la fusion

- **Sévérité** : Moyenne
- **Où** : `.github/workflows/pipeline.yml:137`, `:170-229` ; PR #105
- **Ce qui se passe** : `Images` dépend de `Cible`, qui ne tourne que sur `push`. Une image runner n'existe donc
  qu'après fusion dans `staging`. Un essai sur la CVM d'un changement du runner se fait forcément après fusion. La PR
  #105 listait « Avant fusion : déployer l'image staging, attester le nouveau hash, mesurer 30 000 lignes » : ces
  étapes ne pouvaient pas précéder la fusion, et la mesure est rapportée après (#106, #108).
- **Comment le vérifier** : lire `pipeline.yml:135-172` ; `gh pr view 105 --json body,mergedAt` puis
  `gh pr view 108 --json body,createdAt`.
- **Correction proposée** : construire l'image runner sur les PR (sans publier, ou publier avec une étiquette
  `pr-<numéro>-<sha>`), ou ajouter un déclencheur manuel `workflow_dispatch` pour une branche. Sinon, retirer des
  modèles de PR les étapes « avant fusion » qui ne peuvent pas l'être.

### PRO-08 — Informations d'exploitation dans `docs/`

- **Sévérité** : Moyenne (Haute si le dépôt redevient public ou est ouvert à un tiers)
- **Où** : voir le tableau de la partie 5 ; en particulier `docs/VPS-MIGRATION.md:5`, `:65`, `:112`,
  `docs/passage-mainnet/19-mise-en-production.md:28`, `:51`, `:266`, `docs/PHALA.md:51`, `:101`,
  `docs/PHALA-DEMO-RUNBOOK.md:77`, `:83`
- **Ce qui se passe** : l'adresse IP publique du VPS (12 lignes), la valeur attendue d'un secret GitHub, l'empreinte
  de clé d'hôte SSH, les comptes SSH et système, les dossiers et projets Compose, le chemin du fichier
  d'environnement du serveur, l'état du pare-feu, des identifiants Vercel, un nom d'équipe Vercel dérivé d'une
  adresse personnelle, une adresse e-mail personnelle et le compte déployeur testnet sont écrits dans la
  documentation versionnée. Toute personne ou tout outil qui lit le dépôt les obtient.
- **Comment le vérifier** : relancer la recherche par motifs sur `docs/` (adresses IPv4, `SHA256:`, `/opt/`,
  `.env.vps`, `team_`, `prj_`, `@`).
- **Correction proposée** : remplacer ces valeurs par des noms symboliques (« l'hôte du secret `VPS_HOST` », « le
  dossier de la cible staging ») et garder les valeurs dans un emplacement non versionné réservé à l'exploitation.
  L'historique Git conserve les anciennes valeurs : si le dépôt doit devenir public, prévoir une réécriture
  d'historique ou un nouveau dépôt, et changer l'empreinte d'hôte (nouvelle clé) si besoin.

### PRO-09 — Chaque fusion redéploie tout, même pour de la documentation

- **Sévérité** : Basse
- **Où** : `.github/workflows/pipeline.yml:29-32` (pas de filtre `paths`)
- **Ce qui se passe** : les fusions de documentation seule (#108, #115, #122, #124) ont reconstruit les images,
  appliqué les migrations, redéployé Vercel staging et redémarré le reaper staging sur le VPS.
- **Comment le vérifier** : `gh run view <id> --json jobs` sur les runs `push` de ces fusions (7/7 jobs exécutés).
- **Correction proposée** : ajouter un job qui détecte les chemins modifiés et saute `image`, `migrate`, `vercel` et
  `vps` quand seuls `docs/` ou `*.md` changent.

### PRO-10 — Actions tierces épinglées par étiquette

- **Sévérité** : Basse
- **Où** : `.github/workflows/pipeline.yml:64`, `:66`, `:73`, `:190`, `:192`, `:200`, `:216`
- **Ce qui se passe** : `actions/checkout@v4`, `actions/setup-node@v4`, `actions/cache@v4`,
  `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/build-push-action@v6`. Une étiquette peut être
  déplacée par l'éditeur de l'action ; le job `Images` a `packages: write`.
- **Comment le vérifier** : lire les lignes citées.
- **Correction proposée** : épingler chaque action par empreinte de commit complète, avec l'étiquette en
  commentaire.

### PRO-11 — Secrets orphelins

- **Sévérité** : Basse
- **Où** : secrets du dépôt `GHCR_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` ; secret `DATA_BASE_URL` de
  l'environnement `production`
- **Ce qui se passe** : ces quatre secrets ne sont référencés ni par `pipeline.yml` ni par `scripts/`, `deploy/` ou
  `.github/`. `DATA_BASE_URL` ressemble à une variante de `DATABASE_URL`. Un secret inutilisé reste une valeur à
  protéger et à renouveler.
- **Comment le vérifier** : `gh secret list` (dépôt et environnements) ; chercher chaque nom dans le dépôt.
- **Correction proposée** : vérifier qu'ils ne servent à rien d'autre, puis les supprimer.

### PRO-12 — Identifiant d'organisation Vercel en clair dans le workflow et dans les journaux

- **Sévérité** : Basse
- **Où** : `.github/workflows/pipeline.yml:292-293`
- **Ce qui se passe** : l'identifiant d'organisation Vercel est écrit dans le workflow, et `cat .vercel/project.json`
  l'imprime dans chaque journal de déploiement. Le commentaire `:279-283` explique que ce n'est pas un secret ; il
  facilite néanmoins le ciblage du compte Vercel si le jeton fuit.
- **Comment le vérifier** : lire les lignes citées ; ouvrir le journal du job `Front Vercel` d'un run `push`.
- **Correction proposée** : retirer le `cat` ; garder l'identifiant dans une variable d'environnement GitHub.

### PRO-13 — Une CI verte sur `staging` ne met pas à jour la démonstration

- **Sévérité** : Basse
- **Où** : `scripts/deployment-target.mjs:19` ; `docs/PHALA-DEMO-IMPLEMENTATION.md:544` ; PR #108, #116, #122
- **Ce qui se passe** : l'hôte de démonstration pointe sur un déploiement Vercel figé ; l'image du runner Phala est
  déployée à la main. Après un push vert, le site staging est à jour mais la démonstration et le runner attesté ne le
  sont pas tant que les gestes manuels (alias, `phala deploy`, déclaration du Compose) ne sont pas faits. C'est un
  choix documenté (`pipeline.yml:23-25`) ; le risque est l'écart non vu entre ce qui est fusionné et ce qui tourne.
- **Comment le vérifier** : comparer le commit déclaré dans la dernière entrée de `DECLARED_RELEASES` avec la tête de
  `staging` ; lire le journal de `docs/PHALA-DEMO-IMPLEMENTATION.md`.
- **Correction proposée** : faire afficher par le job `Fumée` (ou un job séparé) le commit servi par l'hôte de
  démonstration et le commit du runner attesté, et signaler l'écart avec la tête de `staging`.

### Récapitulatif

| Sévérité | Nombre | Constats |
|---|---|---|
| Critique | 0 | — |
| Haute | 3 | PRO-01, PRO-02, PRO-04 |
| Moyenne | 5 | PRO-03, PRO-05, PRO-06, PRO-07, PRO-08 |
| Basse | 5 | PRO-09, PRO-10, PRO-11, PRO-12, PRO-13 |

## 8. Ce qui n'a pas pu être vérifié

- **NON VÉRIFIÉ** : qui (personne ou agent) a cliqué sur « Merge » pour chaque PR fusionnée depuis `CHAAIISE`.
- **NON VÉRIFIÉ** : l'existence d'un accord de Noé donné hors GitHub pour les PR marquées « brouillon ».
- **NON VÉRIFIÉ** : les valeurs des secrets du niveau dépôt (base, serveur, jeton désignés) ; elles n'ont pas été
  lues, par règle.
- **NON VÉRIFIÉ** : l'application effective de la règle de branche de l'environnement `production` sur un dépôt
  privé en offre Free.
- **NON VÉRIFIÉ** : le prix et le périmètre exact des offres payantes GitHub.
- **NON VÉRIFIÉ** : les auteurs des PR antérieures à #105.
- Hors du périmètre de ce rapport : `staging` a 55 commits d'avance sur `main` ; la dernière fusion vers `main`
  est la PR #104 du 14 octobre.
