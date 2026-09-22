# Plusieurs destinations d’entraînement — spécification différée

Statut : non implémenté. À réexaminer sur demande client. La production actuelle vise un seul runner Phala ; le VPS héberge le reaper et l’in-process reste réservé au développement ou à la recette non sensible.

## Produit

- Le provider autorise les destinations dès le dépôt : Phala, VPS ou les deux.
- Le borrower choisit uniquement parmi les destinations autorisées. Un VPS standard donne accès au plaintext à son opérateur et ne peut être présenté comme un TEE attesté.
- Le choix est fixé avant la préparation du prêt et conservé dans les preuves et l’historique. Aucune bascule automatique en cas de panne.

## Chiffrement et routage

- Clés maître, clés d’ingestion, secrets de transport et signataires de règlement séparés.
- Dépôt chiffré spécifique à chaque destination autorisée, sans exporter la master key de Phala.
- Lier la destination et son identité aux autorisations provider/borrower, aux reçus, aux datasets et aux exécutions.
- Router dépôt, permis de lock, entraînement, règlement et livraison historique vers la même identité.
- Conserver RA-TLS pour Phala ; un runner VPS aurait un transport HTTPS authentifié et des garanties explicitement différentes.

## EVM et exploitation

Escrow v6 accepte un seul `lockAuthorizer` immuable et le registre dataset ne lie qu’un escrow. Avec les contrats actuels, des signataires séparés nécessitent des couples escrow/registre dataset séparés. Il faudrait adapter les titres, les contrôles de déploiement/KYB, le reaper, les transactions wallet, les historiques et les préflights. Ne pas mutualiser les clés pour contourner cette contrainte.

Prévoir l’exploitation du service VPS : limites CPU/RAM, admission, persistance, sauvegarde des clés, restauration et tests de panne. Une nouvelle architecture de contrats serait une décision distincte, avec sa propre revue.

## Validation requise

Tester les substitutions de destination et de clé, les autorisations incompatibles, les reprises, la re-livraison historique, les deux règlements et l’absence de repli automatique. Les enregistrements `UNKNOWN` ne deviennent pas des exécutions attestées par une migration de base.
