# Socle technique partagé

Les briques dont plusieurs features ont besoin. À construire **en premier**, vendredi matin, avant les pages qui en dépendent.

Responsable proposé : **Ali**. Le schéma de la base et les migrations sont dans son couloir.

---

## 1. Table des utilisateurs — P0

Aujourd'hui, la base n'a pas de table des utilisateurs : un compte n'existe qu'à travers ses datasets, ses prêts et ses sessions. Les tutos, les réglages et le KYB ont besoin d'un endroit où mémoriser l'état d'un wallet.

**Nouveau modèle `UserProfile`**, une ligne par wallet :

| Champ | Usage |
|---|---|
| `address` | Clé, adresse du wallet en minuscules |
| `tourCompletedAt` | Tuto de première connexion terminé ([04](04-dashboard.md)) |
| `featureTours` | Tutos par page déjà vus ([02](02-general.md)) |
| `settings` | Réglages ([13](13-reglages.md)) : langue, menu replié |
| `kybStatus`, `kybCheckedAt` | Cache d'affichage du KYB ([14](14-kyb.md)). La source de vérité reste le contrat |
| `blockedAt`, `blockedReason`, `blockedBy` | Blocage côté site ([15](15-dashboard-admin.md)), après le 6 |
| `createdAt`, `lastSeenAt` | Suivi d'activité |

- Créée à la première connexion réussie.
- Migration **additive** uniquement : aucune colonne existante modifiée. Elle passe sur la base de staging puis sur la base neuve de production samedi.
- Les routes qui lisent ou écrivent ce profil vérifient la session : un wallet ne touche que son propre profil.

## 2. Nouveaux champs sur `Dataset` — P0

| Champ | Usage |
|---|---|
| `category` | Catégorie, liste fixe ([07](07-upload.md), [08](08-marketplace.md)) |
| `listingStatus` | En ligne ou en pause ([06](06-mes-datasets.md)) |
| `listingExpiresAt` | Fin de la durée de publication ([01](01-decisions-avant-samedi.md)) |
| `trainingConsentAt`, `trainingConsentVersion`, `trainingConsentRevokedAt` | Consentement à l'amélioration des modèles ([07](07-upload.md)) |

La marketplace n'affiche que `listingStatus = en ligne` et `listingExpiresAt` dans le futur.

## 3. Journal des accès — P1

Pour le traçage déclaré ([06](06-mes-datasets.md)) : une table `DatasetAccessLog` avec le dataset, le wallet, le prêt, la date et l'empreinte du modèle livré. Écrite au moment de la livraison de la clé du modèle. Lecture réservée à l'admin.

## 4. Textes d'avertissement communs — P0

Un seul fichier source, pour que le même texte apparaisse partout et se modifie en un endroit : `src/lib/copy/disclaimers.ts`.

| Clé | Texte | Où |
|---|---|---|
| `modelQuality` | « Sirius currently trains baseline models: linear and logistic regression on tabular data. Results depend on the data. New models are in development. » | Dashboard, upload, marketplace, train, tutos |
| `contactUs` | « Need a stronger model or specific data? Contact us at sirius.data.contact@gmail.com. » | Mêmes endroits |
| `betaLimits` | « Beta: invitation-only access, capped amounts per loan and in total. » | Dashboard, tuto, landing |
| `retrainDeterministic` | « Linear and logistic regression are deterministic: retraining on the same data gives the same model. » | Train |
| `dataLimits` | « CSV up to 3 MB, 100 to 20,000 rows, numeric columns, up to 31 input features. » | Upload, tuto |

Les limites citées viennent du code (`MAX_DATASET_BYTES`, `MAX_CSV_ROWS`, `MIN_TRAINING_ROWS`, `MAX_TRAINING_FEATURES`). Les textes lisent ces constantes plutôt que de les recopier, pour rester justes si elles changent.

Les textes passent par les fichiers de traduction existants : le test des traductions vérifie qu'aucun n'est oublié.

## 5. Direction artistique — P1

- Pas de maquette supplémentaire : on part du site actuel, fond noir, sphère blanche, typographie actuelle.
- Un jeu de composants communs, à créer une fois et à réutiliser partout :
  - **carte de dataset**, partagée par Mes datasets et la marketplace ;
  - **pastille d'état** ;
  - **encart d'avertissement** ;
  - **décomposition de prix**, partagée par l'upload et la fiche marketplace.
- Ces composants vivent dans `src/components/ui/` et `src/components/datasets/`, pour que les deux couloirs les utilisent sans se marcher dessus. Celui qui les crée en premier les publie, l'autre les réutilise.

## 6. Conditions d'utilisation — P0

Ajouts à `src/app/terms/page.tsx` avant le lancement :

- l'enregistrement des accès et des empreintes de modèles pour détecter les fuites ([06](06-mes-datasets.md)) ;
- le consentement facultatif à l'amélioration des modèles, révocable ([07](07-upload.md)) ;
- la possibilité de suspendre un compte en cas d'abus ([15](15-dashboard-admin.md)) ;
- le délai de sécurité de 3 jours et la règle de remboursement en cas d'échec ([01](01-decisions-avant-samedi.md)) ;
- le jeton USDG.

## Terminé quand

- Migration additive appliquée sur staging, testée, prête pour la base de production.
- Fichier de textes communs utilisé par toutes les pages concernées.
- Composants partagés publiés avant que les pages datasets et marketplace ne les utilisent.
- Conditions d'utilisation mises à jour.
