# Démo locale sans CVM

Cette procédure reproduit la frontière Next/runner avec le stub confidentiel local. Elle ne valide pas le matériel TDX ni RA-TLS ; ces deux contrôles appartiennent à B.5 sur une vraie CVM Phala. La procédure dédiée est dans [PHALA.md](PHALA.md).

## Préparation

Dans `.env.local`, renseigner au minimum :

- `SIRIUS_MASTER_KEY`, `SIRIUS_SESSION_SECRET` et `RUNNER_TRANSPORT_SECRET` : 32 octets en base64 ;
- `XRPL_VERIFIER_SEED` et `XRPL_SETTLEMENT_SEED` : comptes testnet financés ;
- `SIRIUS_VERIFIER_ADDRESS` : adresse du vérificateur ;
- `PINATA_JWT` et `PINATA_GATEWAY` pour le parcours réel d'upload ;
- `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID` si le wallet Google est utilisé.

Génération des secrets locaux :

```bash
openssl rand -base64 32
```

## Validation automatisée

```bash
pnpm install --frozen-lockfile
pnpm prisma migrate dev
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

Les tests Playwright utilisent des API locales simulées et n'envoient aucune transaction XRPL ni donnée à Pinata. Le flag `NEXT_PUBLIC_SIRIUS_E2E=1` est injecté uniquement par Playwright et provoque un arrêt immédiat si `NODE_ENV=production`.

## Frontière Docker locale

```bash
docker compose --env-file .env.local up --detach --wait --build --remove-orphans
docker compose --env-file .env.local ps
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:3000
pnpm runner:smoke
```

Résultat attendu : `app` et `runner` healthy, HTTP `200`, puis `[runner:smoke] OK`.

## Parcours testnet réel

Utiliser deux wallets testnet distincts et financés.

1. Provider : connexion, signature de session, KYB, dépôt d'un CSV, chiffrement navigateur, upload, puis mint MPT.
2. Borrower : connexion, KYB, sélection du dataset et signature de l'`EscrowCreate`.
3. Borrower : lancement du job TEE stub, persistance de la capsule, `EscrowFinish`, récupération du modèle.
4. Les deux parties : vérification des transactions et de l'attestation dans `/audit`.
5. Variante remboursement : laisser dépasser `CancelAfter`, puis utiliser « Récupérer l'escrow » ; vérifier l'`EscrowCancel` dans `/audit`.
6. Provider : supprimer un dataset sans prêt actif, vérifier le crypto-shredding puis la destruction MPT.

## Arrêt

```bash
docker compose --env-file .env.local down
```

Conserver les volumes si les preuves de démo doivent être rejouées. Utiliser `down --volumes` uniquement pour repartir volontairement d'une base et d'un registre anti-rejeu vides.
