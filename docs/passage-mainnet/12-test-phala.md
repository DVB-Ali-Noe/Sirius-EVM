# Démo « Test Phala »

Fichiers : `src/app/(app)/phala/page.tsx`, `src/components/phala-demo/*`, `src/lib/phala-demo/*`, `scripts/operations/demo-controller.ts`.

## Ce qu'on a dit

- On la garde, désactivable quand on veut comme aujourd'hui.
- Améliorer l'expérience et les statistiques d'entraînement, selon ce que Phala peut fournir.
- Un certificat pour chaque entraînement, avec la preuve de calcul Phala.

## Rappels

- La démo tourne **sur le testnet uniquement**. Le code refuse de la démarrer sur mainnet. Elle reste donc sur staging après le lancement.
- Elle est ouverte et fermée par le contrôleur, avec un coût d'environ 0,06 dollar de l'heure quand la machine tourne.
- Une session orpheline ne bloque plus la réouverture depuis la correction M7 du 2 octobre. Elle prend effet au prochain déploiement de l'image de démo.
- Tant que Phala n'a pas répondu, on reste factuel dans la communication : « runs on Phala Cloud ».

## Avant le 6 — P2

Rien d'obligatoire. La démo n'est pas sur le chemin du mainnet.

- Si un créneau de démo est ouvert pour l'annonce, redéployer d'abord l'image de démo à jour, pour embarquer la correction M7.

## Après le 6 — V1.2

### Statistiques

Ce que l'enclave et Phala peuvent fournir sans rien exposer de la donnée :

- durée d'entraînement mesurée dans l'enclave ;
- métriques du modèle : R² ou exactitude ;
- mesures de la machine (MRTD, RTMR3, hash de composition), horodatage et état du TCB de la quote ;
- nombre d'entraînements de la session, places restantes.

Les afficher pendant et après l'entraînement, avec une courte explication de chaque ligne.

### Certificat

Même page de certificat que pour les emprunts ([09](09-train-et-certificat.md)), adaptée au self training de la démo : pas de règlement on-chain, mais la quote et le hash du résultat.

### Expérience

- Un parcours guidé en trois étapes : choisir un fichier d'exemple ou le sien, entraîner, voir le modèle et son certificat.
- Un état clair quand la démo est fermée : prochaine ouverture si elle est prévue, sinon contact.

## Terminé quand

- La démo s'ouvre et se ferme comme aujourd'hui.
- Après : statistiques et certificat visibles pour chaque entraînement de démo.
