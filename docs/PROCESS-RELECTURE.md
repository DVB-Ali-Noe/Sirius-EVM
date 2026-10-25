# Relecture, fusion et exploitation

Règles de travail issues de l'audit interne du processus (constats PRO-01 à PRO-08, 23 octobre 2026). Le dépôt est
privé, sur l'offre GitHub Free : la protection de branche et les rulesets ne sont pas disponibles. Rien dans GitHub
ne peut donc **empêcher** une fusion. Ce document dit ce qui est vérifié par des fichiers du dépôt, ce qui reste une
règle d'équipe, et ce qu'Ali doit régler à la main.

## Règles de fusion

1. **Relecture croisée.** Toute PR vers `staging` ou `main` est approuvée (bouton « Approve ») par l'autre fondateur,
   sur son dernier commit, avant la fusion. Seule exception sur `staging` : une PR qui ne touche que `docs/` ou des
   fichiers `*.md` (hors `.github/`). Sur `main`, aucune exception.
2. **L'auteur ne fusionne pas sans cette approbation.** Un accord donné à l'oral ou par messagerie ne laisse pas de
   trace : l'accord, c'est l'approbation dans GitHub.
3. **Pas prête = statut Draft.** Une PR qui ne doit pas encore être fusionnée est ouverte en Draft (« Create draft
   pull request »), puis passée en « Ready for review » quand l'accord est donné. Un mot dans le titre ou le texte
   (« brouillon », « ne pas fusionner ») ne bloque rien ; seul le statut Draft désactive le bouton de fusion.
4. **Tests liés.** Le texte de la PR donne le lien du run CI du dernier commit, et liste ce qui a été testé hors CI
   (mesures sur la CVM, gestes VPS, parcours manuel dans le navigateur). Les e2e `/phala` tournent désormais dans le
   job `Vérification` (étape « Tests end-to-end Phala »).
5. **Agents IA.** Une PR rédigée ou ouverte par un agent le dit dans son texte. La fusion reste un geste humain, après
   l'approbation de l'autre fondateur.
6. **Pas d'étape « avant fusion » impossible.** Les images (runner, worker) ne sont construites qu'après la fusion
   dans `staging` (constat PRO-07). Un essai sur la CVM d'un changement du runner se fait donc après fusion : l'écrire
   comme tel dans la PR, pas comme une condition préalable.

Le modèle `.github/pull_request_template.md` reprend ces points sous forme de cases à cocher.

## Ce que vérifient les fichiers du dépôt

| Fichier | Ce qu'il fait | Ce qu'il vaut sans protection de branche |
|---|---|---|
| `.github/workflows/relecture.yml` | Sur chaque PR vers `staging` ou `main` : échoue si la PR est en Draft, si son titre contient « brouillon », « draft » ou « WIP », si son texte contient « ne pas fusionner » ou « do not merge », ou s'il manque une approbation d'une autre personne que l'auteur sur le dernier commit (sauf PR de documentation seule vers `staging`). Une demande de changements en cours la fait aussi échouer. Après chaque relecture, le contrôle est relancé. | Le bouton de fusion reste actif. Le contrôle rouge est visible dans la PR, et il reste enregistré : une fusion faite malgré lui se voit après coup. C'est un signal et une trace, pas un verrou. |
| `.github/pull_request_template.md` | Prérempli à l'ouverture de chaque PR : relecture croisée, statut Draft, lien vers les tests, agent IA. | Une convention écrite. Rien ne vérifie que les cases sont cochées. |
| `.github/CODEOWNERS` | Liste les zones sensibles et les deux fondateurs. | **Sans effet** sur un dépôt privé en offre Free : GitHub ne demande pas de relecture automatique. Il sert de liste de référence et deviendrait actif avec une offre payante (« Require review from Code Owners »). |

Pour un vrai verrou sans changer d'offre, l'étape suivante possible (non faite, à décider à deux) : un job dans
`pipeline.yml`, sur `push` vers `staging` et `main`, qui retrouve la PR du commit de fusion et échoue si elle n'a pas
d'approbation ; `image`, `migrate`, `vercel` et `vps` en dépendraient. Une fusion non relue arriverait dans la branche
mais ne serait **pas déployée**.

## Valeurs d'exploitation masquées

La documentation versionnée n'écrit plus l'adresse du VPS, les comptes système, les dossiers du serveur, l'empreinte
d'hôte SSH, les identifiants Vercel ni d'adresse personnelle. Elle utilise ces noms :

| Nom | Désigne | Où trouver la valeur |
|---|---|---|
| `<VPS_HOST>` | Adresse du VPS de production et de staging | Secret GitHub `VPS_HOST` (non relisible) ; registre d'exploitation |
| `<VPS_USER>` | Compte de déploiement du VPS (Docker, sans sudo) | Secret GitHub `VPS_USER` ; registre d'exploitation |
| `<COMPTE_ADMIN>` | Compte d'administration du VPS (sudo) | Registre d'exploitation |
| `<COMPTE_OPS>` | Compte système des outils d'exploitation (watchdog, contrôleur, collecteur) | Registre d'exploitation ; unités `deploy/operations/*.service` |
| `<DOSSIER_PROD>`, `<DOSSIER_STAGING>` | Dossiers du reaper production et staging | `scripts/deployment-target.mjs` (`dossier_vps`) |
| `<DOSSIER_OPS>` | Code des outils d'exploitation sur le VPS | Registre d'exploitation ; unités `deploy/operations/*.service` |
| `<ETAT_OPS>`, `<CONFIG_OPS>` | État privé et configurations privées des outils d'exploitation | Registre d'exploitation ; unités `deploy/operations/*.service` |
| `<EMPREINTE_HOTE_SSH>` | Empreinte de la clé d'hôte SSH du VPS | Registre d'exploitation ; à relever par la console de l'hébergeur |
| `<ID_PROJET_VERCEL_PROD>` | Identifiant du projet Vercel de production | `scripts/deployment-target.mjs` (`projet_vercel`) ; tableau de bord Vercel |
| `<SCOPE_VERCEL>` | Nom d'équipe Vercel (dans les URL de déploiement et l'option `--scope`) | Tableau de bord Vercel |

Le « registre d'exploitation » est un emplacement **hors dépôt** tenu par Ali et Noé (par exemple le dossier local
`.ops/`, ignoré par Git). Il ne doit jamais être copié dans `docs/`, dans un texte de PR ni dans un chat.

Limites à connaître :

- **L'historique Git contient toujours les anciennes valeurs.** Les commits passés n'ont pas été réécrits. Si le dépôt
  doit redevenir public ou être ouvert à un tiers : réécrire l'historique ou repartir d'un nouveau dépôt, et changer
  la clé d'hôte du VPS si besoin.
- Les fichiers qui **servent** au déploiement gardent leurs valeurs, sans quoi ils ne marcheraient plus :
  `scripts/deployment-target.mjs` (dossiers, identifiants de projet et alias Vercel autorisés),
  `deploy/operations/*.service` (comptes et dossiers), `.github/workflows/pipeline.yml` (identifiant d'équipe
  Vercel). La sécurité du VPS repose sur les clés SSH, pas sur le secret de ces noms.
- Les textes des anciennes PR (#117, #120) citent encore des chemins privés : ils se corrigent à la main dans GitHub.

## Actions manuelles pour Ali (réglages GitHub)

Aucune de ces actions n'a été faite par un fichier du dépôt. Elles se font dans GitHub, onglet *Settings*. Aucune
valeur de secret n'est écrite ici.

### Secrets : passer du niveau dépôt aux environnements (PRO-04, PRO-11)

Aujourd'hui, 9 secrets sont au **niveau du dépôt** : `DATABASE_URL`, `VERCEL_TOKEN`, `VPS_HOST`, `VPS_USER`,
`VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `GHCR_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Tout workflow, sur toute branche,
peut les lire. Les environnements `staging` et `production` ont déjà leurs propres `DATABASE_URL`, `EVM_RPC_URL` et
secrets `VPS_*` ; `VERCEL_TOKEN` n'existe qu'au niveau du dépôt.

Point à vérifier d'abord : la documentation GitHub réserve les environnements des dépôts privés aux offres payantes.
Les déploiements récents montrent qu'ils fonctionnent encore, mais si GitHub ignorait un secret d'environnement, le
job prendrait **sans le dire** le secret du même nom au niveau du dépôt. Les étapes ci-dessous suppriment donc un
secret du niveau dépôt seulement après un run vert qui prouve que l'environnement suffit.

1. Créer un jeton Vercel pour staging (avec la portée la plus étroite que Vercel propose) et l'enregistrer comme
   secret `VERCEL_TOKEN` de l'environnement **`staging`**. Faire de même avec un **autre** jeton pour l'environnement
   **`production`** : on pourra révoquer l'un sans toucher l'autre.
2. Environnement `staging` → *Deployment branches and tags* → *Selected branches* → ajouter la seule branche
   `staging`. Vérifier que l'environnement `production` est bien limité à `main`.
3. Supprimer du niveau dépôt les 3 secrets orphelins, que rien ne lit (`pipeline.yml`, `scripts/`, `deploy/`) :
   `GHCR_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
4. Supprimer du niveau dépôt `VERCEL_TOKEN`, `DATABASE_URL`, `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`,
   `VPS_KNOWN_HOSTS`.
5. Relancer la pipeline sur `staging` (fusion suivante ou *Re-run all jobs* du dernier run `push`). Les jobs
   `Migrations`, `Front Vercel` et `Reaper sur le VPS` doivent être verts. S'ils échouent sur un secret vide :
   l'environnement n'est pas pris en compte sur cette offre ; recréer le secret au niveau dépôt et noter le constat.
6. Même contrôle sur `main` à la prochaine mise en production.
7. Environnement `production` : vérifier si `DATA_BASE_URL` sert à quelque chose (rien dans le dépôt ne le lit), puis
   le supprimer.
8. Faire tourner (renouveler) la clé SSH des pipelines sur le VPS et l'ancien jeton Vercel, puis révoquer ce dernier :
   on ne peut pas exclure qu'une branche les ait lus pendant qu'ils étaient au niveau dépôt.
9. Vérifier à la fin : `gh secret list -R DVB-Ali-Noe/Sirius-EVM` ne doit plus rien lister ;
   `gh secret list --env staging` et `--env production` listent chacun `DATABASE_URL`, `EVM_RPC_URL`, `VERCEL_TOKEN`
   et les quatre `VPS_*`.

### Autres réglages

- **Copilot (PRO-01).** La relecture automatique est demandée sur chaque PR mais ne s'exécute plus (quota atteint) :
  elle affiche une « relecture » vide. Rétablir le quota, ou retirer la demande automatique.
- **Compte machine pour les agents (PRO-05).** Faire ouvrir les PR des agents par un compte ou une GitHub App distincte
  (droit d'écriture, pas d'admin), et garder la fusion pour les deux fondateurs.
- **Poussées directes (PRO-02).** Ajouter au hook global `pre-push` de chaque poste (et des environnements d'agents)
  un refus des poussées vers `refs/heads/staging` et `refs/heads/main`. Ce n'est pas garanti côté serveur, mais cela
  évite l'erreur.
- **Textes de PR.** Retirer des textes des PR #117 et #120 les chemins privés qu'ils citent.
