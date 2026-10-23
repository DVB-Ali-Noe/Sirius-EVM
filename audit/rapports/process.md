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

## 6. Règles de relecture et de protection compatibles GitHub Free, dépôt privé, deux fondateurs

## 7. Constats

## 8. Ce qui n'a pas pu être vérifié
