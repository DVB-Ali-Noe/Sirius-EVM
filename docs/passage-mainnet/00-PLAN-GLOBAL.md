# Passage au mainnet — plan global

Lancement de la bêta restreinte sur Robinhood Chain mainnet : **mardi 6 octobre 2026**.

Ce dossier reprend :

- la réunion produit d'Ali et Noé du 2 octobre ;
- les retours de l'audit du 1er octobre encore ouverts ;
- le [plan de lancement technique](../MAINNET-LAUNCH-PLAN.md).

## Le principe

**Seuls les contrats sont figés avant le déploiement mainnet.** Une fois déployés sur mainnet, ils ne changent plus sans redéploiement et migration. Tout le reste — pages, textes, tableaux de bord — peut être mis à jour à tout moment après le lancement, par une PR puis un clic d'approbation sur l'environnement de production.

D'où trois règles :

1. Les **décisions qui touchent les contrats** sont prises avant le déploiement : [01-decisions-avant-samedi.md](01-decisions-avant-samedi.md). Elles sont tranchées : USDG, ré-entraînement en nouvel emprunt complet, délai de sécurité fixé à 3 jours, gain du fournisseur plus frais de calcul sans commission.
2. Avant le 6, on livre **toute la partie datasets, les tutos, les avertissements et les petites features**, chacun dans son couloir pour éviter les conflits.
3. On lance le 6 **avec ce qui est prêt et testé**. Une feature inachevée attend la semaine suivante ; elle n'est jamais fusionnée à moitié.

## Calendrier jusqu'au lancement

| Quand | Quoi | Qui |
|---|---|---|
| **Vendredi 2, soir** | Relecture de ce dossier, adresse USDG officielle ([01](01-decisions-avant-samedi.md)) | Ali et Noé |
| **Samedi 3, d'abord** | Socle : table des utilisateurs, champs datasets, textes communs, composants partagés ([16](16-socle-technique.md)) | Ali |
| **Samedi 3 et dimanche 4** | Partie datasets, tutos et petites features en parallèle (répartition ci-dessous) | Ali et Noé, chacun avec Claude Code |
| **Dimanche 4, en parallèle du code** | Ce qui ne dépend pas des pages : contrats mainnet, machine Phala de production, base de production. Le code des contrats et du moteur ne bouge plus | Noé pour la machine et les contrats, Ali pour la base |
| **Dimanche 4, minuit** | **Gel du code** : seules les corrections critiques passent ensuite | — |
| **Lundi 5, matin** | Test complet sur testnet et second audit multi-agents ([17](17-audit-et-lancement-restants.md)) | Ali avec Claude Code |
| **Lundi 5, matin** | Fusion staging → main, approbation, réglage de la production, premier prêt réel de 5 USDG | Ali et Noé |
| **Lundi 5, journée** | Tests complets en production et sur testnet, corrections critiques uniquement. **Décision de lancer à 20h** | Ali et Noé |
| **Mardi 6** | Ouverture de la bêta restreinte et annonce | Ali et Noé |

Le gel du code est à dimanche minuit, pour garder tout le lundi aux tests. Les contrats et la machine de production sont préparés dimanche en parallèle du code : sinon toute la mise en production tomberait lundi, le jour des tests.

Le calendrier reste serré : la partie datasets et les tutos occupent samedi et dimanche. Si le temps manque, ce qui glisse en premier vers la V1.1, dans cet ordre : les filtres avancés de la marketplace (fourchettes et tri), les statistiques détaillées par dataset, le certificat d'exécution.

## Répartition avant le 6

Chacun ne touche que ses fichiers : aucun conflit de fusion. Les composants partagés sont créés une fois par Ali en premier, puis réutilisés.

| Ali | Noé |
|---|---|
| Socle : table des utilisateurs, champs datasets, textes communs, composants partagés ([16](16-socle-technique.md)) | Mes datasets : mosaïque, fiche, statistiques, réglages ([06](06-mes-datasets.md)) |
| Tuto de première connexion et tutos par page ([04](04-dashboard.md), [02](02-general.md)) | Upload en deux étapes, prix, consentement ([07](07-upload.md)) |
| Avertissements sur toutes les pages, conditions d'utilisation ([16](16-socle-technique.md)) | Marketplace : grille, fiche, filtres, sans connexion ([08](08-marketplace.md)) |
| Bouton profil, réseau affiché, page Wallet de lancement ([05](05-wallet.md)) | Train : catalogue retiré, ré-entraînement, remboursement des échecs ([09](09-train-et-certificat.md)) |
| Réglages et KYB en version « bientôt » ([13](13-reglages.md), [14](14-kyb.md)) | Self training caché côté serveur ([10](10-self-training.md)) |
| Explorer : renommage, vue par utilisateur ([11](11-explorer.md)) | Certificat d'exécution, si le temps le permet ([09](09-train-et-certificat.md)) |
| Adaptation au jeton USDG ([01](01-decisions-avant-samedi.md)) | — |

Noé porte aussi la préparation de la production de dimanche.

## Priorités

- **P0 — bloquant** : sans cela, on ne lance pas. Décisions contrats, socle, partie datasets, tutos, avertissements, conditions d'utilisation, éléments externes, machine et contrats de production, test complet.
- **P1 — avant le 6 si possible** : bouton profil, Réglages, KYB, Explorer, nettoyage de Train, self training caché, certificat.
- **P2 — après le lancement** : la suite, dans l'ordre ci-dessous.

## Après le lancement, dans l'ordre

**V1.1 — du 7 au 10 octobre : ce que les nouveaux utilisateurs voient en premier**

1. Ce qui aurait glissé : filtres avancés, statistiques détaillées, certificat.
2. Refonte de la landing et de la sphère ([03](03-landing.md)).
3. Dashboard v2 et menu masquable ([04](04-dashboard.md)).
4. Wallet complet : historique, retrait général, revenus par dataset, retrait groupé avec gas sponsorisé ([05](05-wallet.md)).

**V1.2 — du 13 au 24 octobre : vos outils et la profondeur**

1. Dashboard admin et Explorer global avec filtres et indexation ([15](15-dashboard-admin.md), [11](11-explorer.md)).
2. Blocage d'utilisateurs et procédure de révocation KYB ([15](15-dashboard-admin.md)).
3. Self training révélé avec sa page dédiée ([10](10-self-training.md)).
4. Section KYB complète ([14](14-kyb.md)).
5. Statistiques et certificat de la démo Phala ([12](12-test-phala.md)).
6. Connexion anti-phishing, reportée par l'audit ([17](17-audit-et-lancement-restants.md)).
7. Modification du prix d'un dataset sans republication ([06](06-mes-datasets.md)).

**Ensuite : le produit**

1. Nouveaux modèles plus performants, entraînés dans l'enclave sur les datasets dont le consentement est actif.
2. Revente d'un modèle déjà entraîné ([02](02-general.md)).
3. Ré-entraînement au prix du calcul seul, avec un futur contrat v8 ([01](01-decisions-avant-samedi.md)).
4. Ajout de fonds par carte en USDG ([05](05-wallet.md)).
5. Notifications par email et interface en français ([13](13-reglages.md)).

## Checklist de décision — lundi 5 à 20h

- [ ] Contrats mainnet déployés avec USDG, vérifiés sur l'explorateur, admin KYB = Safe.
- [ ] Machine Phala de production active, mesures épinglées, même adresse de règlement après redémarrage.
- [ ] Premier prêt réel de 5 USDG réglé de bout en bout, certificat vérifié.
- [ ] Test complet sur testnet passé : parcours, pannes, emprunts simultanés, parcours MetaMask.
- [ ] Second audit : aucun problème critique ou élevé ouvert.
- [ ] Partie datasets, tutos et avertissements en ligne sur staging et testés.
- [ ] Conditions d'utilisation à jour : traçage, consentement, suspension, délai de 3 jours, USDG.
- [ ] Plafonds de la bêta configurés, accès sur invitation actif.
- [ ] Nettoyeur de production en marche, supervision et alertes ETH en place.
- [ ] Runbooks relus par les deux ([../MAINNET-RUNBOOKS.md](../MAINNET-RUNBOOKS.md)).

Un seul des quatre premiers points non coché suffit à reporter.

## Règles de travail

- Tout passe par une PR vers staging, CI verte obligatoire, plus de `[skip ci]`.
- Staging reste sur testnet. Main est la production sur mainnet. Le même code, deux réglages.
- Après chaque fusion dans main, l'un de vous approuve le déploiement dans l'onglet Actions.
- Aucune signature d'assistant dans les commits ou PR.

## Index

| Fichier | Sujet | Avant le 6 |
|---|---|---|
| [01-decisions-avant-samedi.md](01-decisions-avant-samedi.md) | Jeton, prix, délai de sécurité, ré-entraînement | Oui |
| [02-general.md](02-general.md) | Tutos, emprunts simultanés, connexion, réseau, revente de modèle | En partie |
| [03-landing.md](03-landing.md) | Page d'accueil | Lien des conditions seulement |
| [04-dashboard.md](04-dashboard.md) | Tableau de bord et tuto de première connexion | Tuto et avertissement |
| [05-wallet.md](05-wallet.md) | Wallet et profil | Bouton profil |
| [06-mes-datasets.md](06-mes-datasets.md) | Mes datasets | Oui |
| [07-upload.md](07-upload.md) | Publication d'un dataset | Oui |
| [08-marketplace.md](08-marketplace.md) | Marketplace | Oui |
| [09-train-et-certificat.md](09-train-et-certificat.md) | Entraînement et certificat | Oui, certificat si possible |
| [10-self-training.md](10-self-training.md) | Self training | Masquage |
| [11-explorer.md](11-explorer.md) | Explorer, ancien Audit | Renommage et vue utilisateur |
| [12-test-phala.md](12-test-phala.md) | Démo Phala | Non |
| [13-reglages.md](13-reglages.md) | Réglages | Version minimale |
| [14-kyb.md](14-kyb.md) | KYB | Version minimale |
| [15-dashboard-admin.md](15-dashboard-admin.md) | Dashboard admin | Non |
| [16-socle-technique.md](16-socle-technique.md) | Briques partagées | Oui, en premier |
| [17-audit-et-lancement-restants.md](17-audit-et-lancement-restants.md) | Audit et lancement technique | Oui |
