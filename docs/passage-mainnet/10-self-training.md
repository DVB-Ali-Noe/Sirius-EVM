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

## Après le 6 — V1.2

- Page dédiée `/admin/self-training`, accessible depuis le dashboard admin ([15](15-dashboard-admin.md)).
- Usage : tester de nouveaux modèles sur nos propres données, préparer leur sortie publique.
- Révélation publique décidée selon les retours de la bêta. Quand elle arrive, la page sort de l'admin avec son tuto ([02](02-general.md)).

## Terminé quand

- Avant le 6 : aucun utilisateur ne voit ni n'atteint le self training. Vos deux adresses y accèdent, et les routes refusent les autres côté serveur.
