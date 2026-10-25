<!--
Règles complètes : docs/PROCESS-RELECTURE.md.
PR pas encore prête : l'ouvrir en Draft (flèche à côté de « Create pull request » → « Create draft pull request »).
Un mot dans le titre ou le texte ne bloque rien ; le contrôle « Relecture croisée » échoue s'il en trouve un.
Ces commentaires ne s'affichent pas dans la PR.
-->

## Quoi et pourquoi



## Zone touchée

- [ ] Documentation seule (`docs/`, `*.md`, hors `.github/`)
- [ ] Zone sensible : `src/lib/tee/`, `src/runner/`, `contracts/`, `src/lib/billing/`, `prisma/migrations/`, `.github/`, `deploy/`, `scripts/operations/`
- [ ] Autre code

## Tests

- Run CI du dernier commit (job « Vérification ») : <!-- coller le lien du run -->
- Testé hors CI (commande et résultat, ou « rien ») : <!-- ex. e2e Phala en local, mesure sur la CVM -->
- À faire après la fusion (les images runner et worker ne sont construites qu'après la fusion dans `staging`) : <!-- ou « rien » -->

## Relecture croisée (obligatoire, sauf documentation seule vers `staging`)

- [ ] L'autre fondateur a approuvé la PR dans GitHub (« Approve »), sur le dernier commit : un accord oral ou par messagerie ne compte pas
- [ ] Le contrôle « Relecture croisée » est vert avant la fusion
- [ ] PR rédigée ou ouverte par un agent IA : oui / non <!-- si oui : quel agent, et qui a relu -->
