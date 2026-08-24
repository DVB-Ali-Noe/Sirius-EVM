# Runner Phala — déploiement et validation B.5

Ce dossier prépare la CVM runner uniquement. Next, Prisma et SQLite restent hors de la CVM.

## Construire l’image

Choisir un tag immuable : toute mise à jour d’image ou de compose modifie l’identité mesurée. Phala recommande un tag neuf à chaque déploiement.

```bash
docker build --file Dockerfile.runner --tag ghcr.io/<organisation>/sirius-runner:<tag> .
docker push ghcr.io/<organisation>/sirius-runner:<tag>
```

## Déployer la même CVM stable

Dans Phala Cloud, créer une CVM CPU avec une image dstack de production, puis coller [`deploy/phala/compose.yaml`](../deploy/phala/compose.yaml). Monter impérativement `/var/run/dstack.sock` et garder le volume `runner_replay`.

Renseigner les variables dans les secrets chiffrés Phala :

- `SIRIUS_RUNNER_IMAGE`, `RUNNER_TRANSPORT_SECRET`, `SIRIUS_APP_ORIGIN` ;
- `PINATA_GATEWAY`, `PINATA_JWT` ;
- `XRPL_ENDPOINT`, `XRPL_NETWORK`, `XRPL_AUDIT_SIGNER_SEED`, `XRPL_SETTLEMENT_SEED` ;
- si l’image est privée : `DSTACK_DOCKER_USERNAME`, `DSTACK_DOCKER_PASSWORD` et, si nécessaire, `DSTACK_DOCKER_REGISTRY`.

Le gateway doit être utilisé en passthrough TLS : `https://<app_id>-4100s.<gateway_domain>`. Cette valeur est injectée automatiquement comme SAN dans le certificat RA-TLS du runner.

## Capturer puis épingler l’identité

Après le premier démarrage, sans redéployer le runner :

```bash
RUNNER_URL=https://<app_id>-4100s.<gateway_domain> pnpm runner:capture-ra-tls
```

La commande vérifie le certificat, sa quote TDX et le replay RTMR3, puis imprime les cinq variables à poser dans l’environnement de l’application Next. Redémarrer ou redéployer Next avec ces valeurs, `RUNNER_URL` et `RUNNER_TRANSPORT_SECRET`.

Ne jamais reporter ces cinq valeurs dans le compose de la CVM : elles changeraient le `compose_hash` qu’elles sont censées épingler. Toute modification du compose ou de l’image runner impose une nouvelle capture, puis un redéploiement de Next.

Pour vérifier la persistance de clé, arrêter puis redémarrer cette même CVM sans modifier son compose. La seconde capture doit produire exactement les mêmes cinq valeurs. Ne pas créer une nouvelle application Phala : son `app_id` peut produire une master key différente.

## Smoke RA-TLS

Depuis l’environnement de l’application Next configuré avec les cinq pins :

```bash
pnpm runner:smoke
```

Le smoke passe par la vérification DCAP, l’identité mesurée, le pinning du certificat et une requête authentifiée à la clé d’ingestion. Résultat attendu : `[runner:smoke] OK`.

## Validation testnet réelle

Utiliser deux wallets testnet distincts et financés. Rejouer le parcours décrit dans [`docs/DEMO.md`](DEMO.md) : KYB provider/borrower, ingestion chiffrée, mint MPT, `EscrowCreate`, entraînement, `EscrowFinish`, récupération du modèle, remboursement après `CancelAfter`, puis crypto-shredding. Archiver les liens XRPL dans `/audit` après chaque étape.
