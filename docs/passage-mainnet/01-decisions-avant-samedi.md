# Décisions à prendre avant samedi matin

Les contrats mainnet sont déployés **samedi 4 octobre**. Ils sont immuables : toute décision qui touche ce qu'ils enregistrent doit être prise avant. Ce fichier liste les quatre décisions, l'option retenue et ce qu'elle implique dans le code.

Priorité : **P0**. Responsables : Ali et Noé.

---

## 1. Le jeton : USDG

**Décision** : l'escrow mainnet est déployé avec **USDG** (Paxos) au lieu de l'USDC natif.

**Ce que ça implique.** L'escrow n'accepte qu'un seul jeton, fixé dans son constructeur. Le code a été préparé pour l'USDC natif `0x80e0…6ca8` : il faut le généraliser au jeton retenu.

**Trouver et vérifier l'adresse officielle d'USDG**, au moment de commencer à coder :

1. Prendre l'adresse sur une source officielle : la page « contract addresses » de la documentation Paxos pour USDG, ou la documentation de Robinhood Chain. Jamais une adresse trouvée sur un DEX ou un agrégateur : plusieurs jetons portent le même nom.
2. Vérifier sur l'explorateur `robinhoodchain.blockscout.com` que le contrat est vérifié, nommé « Global Dollar », symbole USDG, émis par Paxos.
3. Lire `decimals()` et le code hash avec l'exécution à blanc du script de déploiement (voir [17](17-audit-et-lancement-restants.md)). L'USDG est annoncé à 6 décimales : à confirmer on-chain.
4. Vérifier qu'il n'a ni frais de transfert ni rebasage : l'escrow suppose qu'un `transferFrom` de N crédite exactement N.

**Fichiers à adapter** une fois l'adresse confirmée :

| Fichier | Changement |
|---|---|
| `scripts/deploy-policy.ts` | `MAINNET_USDC` devient le jeton retenu, avec son code hash |
| `scripts/initialize-runner-volume.ts` | Même constante pour la politique de facturation |
| `scripts/phala-v7-preflight.ts`, `scripts/operations/release-check.mjs` | Contrôle du jeton et de ses décimales |
| `src/lib/evm/networks.ts` | `USDC_DECIMALS_BY_NETWORK.mainnet` si les décimales diffèrent de 6 |
| Interface (`wallet`, `dashboard`, `marketplace`, upload) | Libellé « USDG » sur mainnet au lieu de « USDC » |
| `src/app/api/onramp/route.ts` | Le pont Across supporte-t-il USDG ? Sinon, autre moyen d'ajout de fonds ([05](05-wallet.md)) |
| `docs/MAINNET-RUNBOOKS.md` | Commandes de déploiement avec la nouvelle adresse |

Les variables d'environnement gardent leur nom historique `SIRIUS_USDC_ADDRESS` : renommer partout pour le lancement ajouterait du risque pour rien.

**Terminé quand** : l'exécution à blanc du déploiement passe avec l'adresse USDG, et les tests de `deploy-policy` couvrent le refus d'un autre jeton.

---

## 2. Le ré-entraînement : un nouvel emprunt complet

**Décision** : chaque ré-entraînement est **un nouvel emprunt complet**. La donnée est payée à nouveau, plus le calcul.

**Pourquoi.** Le contrat v7 refuse un prêt dont le montant de la donnée vaut zéro (`ZeroAmount`). Faire payer seulement le calcul demanderait de modifier le contrat avant samedi, sans audit de cette modification : un risque disproportionné à deux jours du lancement.

**Ce que ça implique** :

- Aucun changement de contrat ni de moteur.
- L'interface présente clairement l'offre : « un emprunt = l'accès à la donnée + un entraînement ». Le bouton « ré-entraîner » ouvre un nouvel emprunt avec le prix complet affiché ([09](09-train-et-certificat.md)).
- Un ré-entraînement au prix du calcul seul reste une évolution possible, avec un futur contrat v8 ([02](02-general.md)).

---

## 3. La période de remboursement : fixée par Sirius, durée d'activité gérée par le site

**Aujourd'hui.** Le fournisseur choisit à l'upload une « période de remboursement » de 1 à 30 jours. C'est en réalité le **délai de sécurité de l'escrow** : si le prêt n'est pas réglé avant ce délai, l'emprunteur peut récupérer ses fonds. Il protège l'emprunteur, pas le fournisseur, et il n'a rien à voir avec la durée de mise en vente.

**Décision** :

- Le délai de sécurité est **fixé par Sirius à 3 jours** pour tous les datasets. Le fournisseur ne le choisit plus. Trois jours couvrent la finalité mainnet, environ 16 minutes, une panne de la machine Phala un week-end, et une intervention opérateur, sans bloquer longtemps l'argent de l'emprunteur en cas d'échec.
- On ajoute une **durée d'activité sur la marketplace**, choisie par le fournisseur : 30 jours par défaut, renouvelable. Elle est gérée par le site, dans la base, sans toucher au contrat.

**Ce que ça implique** :

- Contrat inchangé : `challengeDays` reste un paramètre du devis, valeur 3.
- Base de données : un champ d'expiration de l'annonce sur `Dataset` ([16](16-socle-technique.md)).
- Upload : le champ « période de remboursement » disparaît, remplacé par « durée de publication » ([07](07-upload.md)).
- Les datasets déjà publiés sur testnet gardent leur valeur actuelle.

---

## 4. Le prix : le fournisseur fixe son gain, pas de commission en plus pendant la bêta

**Décision** :

- Le fournisseur fixe **ce qu'il veut gagner** par emprunt.
- Le prix payé par l'emprunteur = son gain + les **frais de calcul** du tarif Sirius (le montant compute du devis, qui va au Safe).
- **Aucune commission supplémentaire** pendant la bêta. Les frais de calcul couvrent le coût Phala et une marge.
- À l'upload, on affiche les trois montants : ce que le fournisseur touche, les frais de calcul, le total payé par l'emprunteur. On affiche aussi le minimum imposé par le tarif.

**Ce que ça implique** : aucun changement de contrat. Le devis v7 sépare déjà `datasetAmount` et `computeAmount`. C'est un travail d'affichage ([07](07-upload.md), [08](08-marketplace.md)).

---

## Récapitulatif

| Décision | Choix | Touche le contrat ? |
|---|---|---|
| Jeton | USDG | Oui : adresse au déploiement |
| Ré-entraînement | Nouvel emprunt complet | Non |
| Délai de sécurité | Fixé à 3 jours, durée d'activité côté site | Non |
| Prix | Gain du fournisseur + frais de calcul, sans commission | Non |
