# Sirius

**Louer des datasets de valeur sans jamais les exposer.**

Sirius est un protocole de *data lending confidentiel* sur XRPL. Le propriétaire d'un dataset le met à disposition sans jamais livrer la donnée brute : l'emprunteur soumet un job d'entraînement qui s'exécute dans un **TEE** (boîte noire matérielle), et ne récupère que le **modèle entraîné**. Tout le règlement et l'audit passent par XRPL.

> Deux mauvaises options aujourd'hui : garder sa donnée (zéro revenu) ou la vendre (perte de contrôle, copie). Sirius en ouvre une troisième : **louer**, avec revenu récurrent, contrôle conservé et traçabilité.

## Le principe en une image

```
Provider                    XRPL (mainnet)                 Borrower
  │ dataset chiffré (AES-256) → IPFS                          │
  ├─ mint MPT (identité on-chain du dataset)                  │
  ├─ KYB via Credentials + Permissioned Domain               │
  │                                                           │
  │                        EscrowCreate (XRP) ◄───────────────┤ bloque les fonds
  │                       conditionnel + CancelAfter          │
  │                                                           │
  │        ┌─────────── Phala TEE (boîte noire) ──────────┐   │
  │        │ déchiffre en enclave · entraîne le modèle    │◄──┤ soumet le job
  │        │ → modèle + attestation signée                │   │
  │        └──────────┬───────────────────────────────────┘   │
  │                   └─► capsule ECDH+fulfillment ───────────►│ persistée avant paiement
  │                                                           │
  │    runner ─► EscrowFinish ─► provider payé + fulfillment ─►│ capsule ouverte
```

L'échange est **atomique au niveau XRPL** : après persistance locale de la capsule verrouillée, le runner soumet `EscrowFinish`. Cette transaction paie le provider et publie simultanément le fulfillment nécessaire pour ouvrir la capsule. Next ne voit jamais la clé modèle en clair.

## Stack

| Couche | Techno |
|---|---|
| Frontend | Next.js 16.2.11 · React 19 · Tailwind 4 · Three.js · Zustand · TanStack Query |
| Backend | API routes Next.js |
| Chain | XRPL **mainnet-ready** (testnet pour le dev) · `xrpl.js` |
| Persistance | SQLite + Prisma |
| TEE | Phala dstack (stub swappable en dev) |
| Storage | IPFS / Pinata + AES-256-GCM |
| Règlement | XRP au MVP · RLUSD cible |

## Primitives XRPL (toutes live sur mainnet)

- **MPT** (XLS-33) — tokenise le dataset
- **Credentials** (XLS-70) — KYB provider/borrower
- **Permissioned Domains** (XLS-80) — gating de conformité
- **TokenEscrow** (XLS-85) — règlement conditionnel du loan

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour le détail et les choix.

## Statut

Inc. 0→3c terminés. **3d.1, 3d.2, 3d.2b et 3d.3 sont code-complete** : master key dstack, quote TDX, replay RTMR3, liaison `compose_hash`, empreinte de la chaîne KMS et fulfillment scellé. Le runner confidentiel isolé est terminé jusqu'à **B.4**. L'outillage **B.5 est code-complete** : `Dockerfile.runner`, manifeste Phala, TLS 1.3 dans la CVM, clé/certificat générés par dstack, quote liée au certificat, vérification DCAP et épinglage côté Next des mesures, de la chaîne KMS et de la clé d'ingestion.

Les signatures utilisateur sont désormais entièrement côté client : `EscrowCreate`, paiements, mint/destroy MPT et `CredentialAccept` KYB. L'application ne charge plus de seed provider/borrower. Le remboursement après `CancelAfter` est réconcilié par le runner et déclenchable depuis l'UI ; la transaction `EscrowCancel` est conservée pour l'audit sans pénaliser automatiquement une partie. Le catalogue expose une réputation issue des règlements confirmés et chaque participant dispose d'un registre d'audit vérifiable.

Validation locale au 14 août 2026 : suite de tests, TypeScript et ESLint passants ; `pnpm audit --prod` ne rapporte aucune vulnérabilité connue. Un audit statique couvre sessions, CSRF, grants anti-rejeu, contrôles d'accès API, chiffrement/IPFS, runner RA-TLS et escrows XRPL : aucun contournement exploitable n'a été démontré. Il ne remplace pas la validation de la configuration ni le smoke d'une CVM Phala réelle.

Restent la construction et la publication d'une image runner immuable, son déploiement et le smoke RA-TLS dans une vraie CVM Phala (**B.5**), la validation du parcours réel avec deux wallets testnet et la vidéo de secours. Le déploiement est détaillé dans [docs/PHALA.md](docs/PHALA.md).

La migration `bind_dataset_terms` suspend volontairement les anciens datasets publiés : leur reçu runner historique ne liait ni prix ni délai. Ils doivent être recréés et rescellés avant de redevenir empruntables.

Le MVP entraîne actuellement une **régression linéaire déterministe** sur CSV. Les jobs sont synchrones avec un timeout runner de 60 s ; le code arbitraire et les entraînements longs sont post-MVP et nécessiteront une file asynchrone.

La topologie retenue est une **CVM CPU stable**, démarrée/arrêtée selon les besoins — pas une nouvelle machine par job. Voir [docs/ROADMAP.md](docs/ROADMAP.md).

## Quickstart

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local   # remplir les seeds XRPL + Pinata
pnpm prisma migrate dev
pnpm dev                      # http://localhost:3000
```

Validation automatisée locale :

```bash
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

### Runner séparé avec Docker Compose

```bash
docker compose --env-file .env.local up --detach --wait --build
pnpm runner:smoke
docker compose --env-file .env.local down
```

Le service `app` appelle `http://runner:4100` et reste seul détenteur de la DB. Les secrets sont projetés explicitement par service : l'app ne reçoit pas la master key ni le seed de règlement, et le runner ne reçoit pas les seeds applicatifs. Le runner utilise une image immuable sans montage du code ou de `node_modules`, un volume dédié à l'anti-rejeu et un port hôte limité à `127.0.0.1` pour le smoke local.

Le déroulé de démonstration sans CVM est décrit dans [docs/DEMO.md](docs/DEMO.md) ; la procédure de déploiement et de validation Phala est dans [docs/PHALA.md](docs/PHALA.md).
