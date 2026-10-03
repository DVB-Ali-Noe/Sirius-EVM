# Self training

Fichiers : `src/app/(app)/train/page.tsx`, `src/lib/sirius/self-train.ts`, `src/app/api/train/**`, `src/lib/phala-demo/operator.ts`.

## Ce qu'on a dit

- Une page cachée, seulement pour nous et pour les tests au début. On la révèle plus tard selon les retours.
- Liée au dashboard admin.

## Avant le 6 — P1

- Le self training disparaît de l'interface publique ([09](09-train-et-certificat.md)).
- **Accès réservé** aux adresses opérateurs : vos deux wallets. Le contrôle existe déjà pour la démo Phala (`SIRIUS_DEMO_OPERATORS`, `operatorAllowed`). On le réutilise avec une variable dédiée `SIRIUS_ADMIN_ADDRESSES`, pour ne pas mélanger les rôles.
- La protection se fait **côté serveur**, sur les routes de self training. Masquer un lien dans l'interface ne suffit pas.
- Un non-opérateur qui tape l'URL reçoit une page « bientôt disponible », sans fuite d'information.

## Contrôle côté serveur (N5)

Variable `SIRIUS_ADMIN_ADDRESSES`, documentée dans `.env.example` : adresses EVM de l'équipe, séparées par des virgules, toute casse acceptée (comparées en minuscules). Lue par `adminAllowed` dans `src/lib/auth/admin.ts`.

- Vide ou absente : personne n'est administrateur.
- Une seule entrée invalide (pas une adresse, adresse nulle, virgule finale), ou plus de dix entrées : la liste entière est refusée, personne n'est administrateur. Une faute de frappe ferme donc l'accès au lieu de l'ouvrir ; un avertissement est écrit dans les journaux du serveur, sans la valeur.
- Variable distincte de `SIRIUS_DEMO_OPERATORS`, qui ne sert qu'au contrôleur de la démo Phala.

Routes gardées par `assertSelfTrainingAccess` (`src/lib/sirius/self-training-access.ts`), juste après l'authentification et avant toute lecture de corps, toute requête en base, toute vérification de grant et tout appel runner :

| Route | Hors équipe |
|---|---|
| `GET /api/train` | 403 « Bientôt disponible » |
| `POST /api/train` | 403 « Bientôt disponible », corps non lu |
| `POST /api/train/[id]/key` | 403 « Bientôt disponible », corps non lu |
| `GET /api/admin/me` | `{ "admin": false }` ; sert à l'interface pour afficher ou masquer |

Exception, uniquement sur une instance de démonstration Phala (`SIRIUS_PHALA_DEMO=true` **et** `EVM_NETWORK=testnet`, donc jamais sur mainnet) : la démo publique ([12](12-test-phala.md)) est elle-même un self training sur ses propres données et passe par `/api/train`. Un visiteur y garde la liste de ses jobs et le lancement d'un entraînement porté par un grant de démo (`demoSessionRevision` présent, vérifié ensuite par le runner contre la session ouverte). Le reste, dont la livraison de clé, reste réservé à l'équipe.

## Après le 6 — V1.2

- Page dédiée `/admin/self-training`, accessible depuis le dashboard admin ([15](15-dashboard-admin.md)).
- Usage : tester de nouveaux modèles sur nos propres données, préparer leur sortie publique.
- Révélation publique décidée selon les retours de la bêta. Quand elle arrive, la page sort de l'admin avec son tuto ([02](02-general.md)).

## Terminé quand

- Avant le 6 : aucun utilisateur ne voit ni n'atteint le self training. Vos deux adresses y accèdent, et les routes refusent les autres côté serveur.
