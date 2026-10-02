# KYB

Fichiers : `src/components/kyb/KybInviteForm.tsx`, `src/lib/kyb/invitation.ts`, `src/lib/sirius/kyb.ts`, `src/app/api/onboarding/**`, `scripts/operations/kyb-invite.ts`, `contracts/src/SiriusKybRegistry.sol`.

## Ce qu'on a dit

- Ajouter cette section.
- Seulement pour les entreprises ?
- Quels avantages ?
- Affichage « bientôt ».

## Ce qui existe déjà

- Sur mainnet, le registre KYB est **strict** : seules les adresses vérifiées peuvent prêter et emprunter.
- Pour la bêta, la vérification passe par une **invitation signée** par un vérificateur Sirius. L'entreprise colle son invitation et devient vérifiée on-chain. Le formulaire apparaît sur la marketplace et Mes datasets quand le KYB manque.

## Avis sur les questions

- **Pour qui** : sur mainnet, tout utilisateur qui veut emprunter ou publier doit être vérifié, puisque le contrat l'exige. Pendant la bêta, cela revient aux entreprises invitées. Les particuliers peuvent consulter la marketplace sans KYB ([02](02-general.md)).
- **Avantages** : le KYB n'est pas un bonus, c'est l'accès. Ce qu'on met en avant :
  - badge « Fournisseur vérifié » sur ses datasets ;
  - plafonds de prêt plus élevés après la bêta ;
  - accès anticipé aux nouveaux modèles.

## Avant le 6 — P1

Page `/kyb`, accessible depuis le bouton profil :

- **État** : vérifié, avec la date d'expiration de l'attestation, ou non vérifié.
- **Non vérifié** : le formulaire d'invitation existant, et « Pas d'invitation ? Écrivez-nous : sirius.data.contact@gmail.com ».
- **Bientôt** : vérification en ligne sans invitation, avantages listés. Grisés, avec « Soon ».

## Après le 6 — V1.2

- Parcours de vérification sans invitation : formulaire entreprise, contrôle par un vérificateur, attestation signée. Le choix d'un prestataire de KYB est à faire.
- Statut KYB stocké dans la table des utilisateurs ([16](16-socle-technique.md)) pour l'affichage. La source de vérité reste le contrat.
- Badge « Vérifié » sur la marketplace.
- Renouvellement avant expiration de l'attestation, avec un rappel.

## Terminé quand

- Avant le 6 : la page affiche l'état, permet de coller une invitation, et présente la suite en « Soon ».
