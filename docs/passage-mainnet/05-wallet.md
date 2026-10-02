# Wallet et profil

Fichiers : `src/app/(app)/wallet/page.tsx`, `src/components/wallet/*`, `src/components/layout/Sidebar.tsx`, `src/app/api/onramp/route.ts`, `src/lib/wallet/onramp.ts`.

## Ce qu'on a dit

- Retirer le bouton Wallet du menu latéral.
- Un bouton profil, en haut à droite ou en bas à gauche, avec : profil, accès au wallet, réglages et KYB, déconnexion.
- Solde, historique des transactions, lien vers l'explorateur, adresse.
- Un moyen d'ajouter des USDG plutôt que des USDC : MoonPay ou transfert crypto.
- Une section de retrait générale.
- Un retrait par dataset plus explicite, et un bouton pour tout retirer d'un coup, peut-être avec gas sponsorisé.

---

## Avant le 6 — P1

### Bouton profil

- **Position** : en haut à droite. C'est l'emplacement standard des applications web3, et il reste visible quand le menu est replié.
- **Contenu du menu** :
  - adresse raccourcie, bouton copier, lien vers l'explorateur ;
  - badge réseau, « Robinhood Chain mainnet » ou « testnet » ([02](02-general.md)) ;
  - solde USDG ;
  - Wallet, qui ouvre la page complète ;
  - Réglages et KYB ([13](13-reglages.md), [14](14-kyb.md)) ;
  - Visite guidée ([04](04-dashboard.md)) ;
  - Déconnexion.
- Le lien Wallet sort du menu latéral.

### Page Wallet, version de lancement

- Solde, adresse, lien explorateur, montants à retirer avec le bouton existant.
- **Ajout de fonds** : sur mainnet, l'ajout passe aujourd'hui par le pont Across. Avec USDG ([01](01-decisions-avant-samedi.md)), vérifier qu'Across le supporte. Sinon, pour le lancement : afficher l'adresse et un QR code pour recevoir des USDG par transfert, avec une explication claire.

---

## Après le 6 — V1.1

### Historique des transactions

- Liste des dépôts, emprunts, règlements, remboursements et retraits du wallet, chacun avec son lien explorateur.
- Source : les événements on-chain de l'escrow, déjà lus pour l'Explorer ([11](11-explorer.md)), et les transferts du jeton vers et depuis l'adresse.

### Retraits

- **Retrait général** : envoyer ses USDG vers n'importe quelle adresse, avec vérification de l'adresse et confirmation.
- **Revenus par dataset** : pour chaque dataset, ce qui a été gagné et ce qui reste à retirer.
- **Tout retirer** : un bouton qui retire tous les crédits de l'escrow en une fois. Le relais de retrait sponsorisé existe déjà côté serveur (`withdraw-relayer`) : l'étendre plutôt que créer autre chose, avec un plafond de gas par jour.

### Ajout de fonds par carte

- MoonPay ou un autre prestataire selon le support d'USDG sur Robinhood Chain. À vérifier avec le prestataire, aucune intégration avant confirmation.

## Terminé quand

- Avant le 6 : le bouton profil remplace le lien Wallet du menu et affiche le réseau. La page Wallet indique comment ajouter des USDG.
- Après : historique complet, retrait général, revenus par dataset et retrait groupé.
