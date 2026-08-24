# Runner Phala et rail EVM

Le runner est la frontière de confiance : il détient la master key dstack, ouvre le dataset, entraîne le modèle, dérive le préimage du hashlock et appelle `SiriusEscrow.release` après persistance de la capsule par le borrower.

## État actuel

`Dockerfile.runner`, le manifeste Phala, RA-TLS et la capture des mesures sont présents et configurés pour le rail EVM. Ils restent à déployer puis à vérifier sur une CVM réelle.

## Variables EVM requises dans la CVM

- `EVM_NETWORK=testnet` ou `mainnet` ;
- `EVM_RPC_URL` ;
- `SIRIUS_ESCROW_ADDRESS` ;
- `SIRIUS_KYB_ADDRESS` et `SIRIUS_DATASET_ADDRESS` ;
- `PINATA_GATEWAY` et `PINATA_JWT` ;
- `RUNNER_TRANSPORT_SECRET` et `SIRIUS_APP_ORIGIN` ;
- les variables dstack, RA-TLS et de limites déjà requises par le runner.

Le compte EVM de règlement est dérivé dans le runner depuis la master key scellée. Il doit recevoir suffisamment d'ETH natif pour payer les appels `release` et `refund`. Sa clé privée ne doit jamais être injectée par variable d'environnement.

## Séquence de déploiement

1. Compiler, tester et déployer les contrats sur testnet.
2. Poser les adresses testnet d'escrow, KYB et dataset dans l'environnement du runner et dans l'application.
3. Mettre à jour `deploy/phala/compose.yaml` avec les variables EVM ci-dessus.
4. Construire et publier une image runner immuable.
5. Déployer une CVM stable, puis capturer les mesures RA-TLS :

```bash
RUNNER_URL=https://<app_id>-4100s.<gateway_domain> pnpm runner:capture-ra-tls
```

6. Épingler les valeurs retournées dans l'environnement Next et exécuter :

```bash
pnpm runner:smoke
```

7. Vérifier un prêt testnet réel : verrouillage borrower, contrôle de portée par le runner, release, ouverture de capsule et retrait des crédits.

Toute modification de l'image ou du compose implique une nouvelle capture RA-TLS. La même CVM doit être redémarrée pour vérifier la persistance de la master key et du compte de règlement dérivé.
