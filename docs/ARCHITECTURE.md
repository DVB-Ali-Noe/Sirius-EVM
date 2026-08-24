# Architecture

## Principe

Sirius est un protocole de **data lending confidentiel** : le dataset ne quitte jamais le contrôle de son propriétaire. L'emprunteur n'obtient qu'un **modèle entraîné dans un TEE**, jamais la donnée brute. XRPL sert de couche de **règlement conditionnel + audit infalsifiable**.

Contrainte fondatrice : **tout doit être déployable sur XRPL mainnet aujourd'hui**. Aucune dépendance à un amendment non activé (pas de Vault XLS-65, pas de Lending XLS-66, pas de Smart Escrow/Wasm XLS-100).

## Primitives XRPL utilisées (live mainnet)

| Primitive | Amendment | Rôle |
|---|---|---|
| **MPT** (XLS-33) | `MPTokensV1` (oct. 2025) | Identité/provenance on-chain du dataset |
| **Credentials** (XLS-70) | `Credentials` | KYB provider/borrower |
| **Permissioned Domains** (XLS-80) | `PermissionedDomains` (fév. 2026) | Gating de conformité |
| **TokenEscrow** (XLS-85) | `TokenEscrow` (fév. 2026) | Règlement conditionnel (XRP/RLUSD/MPT) |
| **RLUSD** | — (token natif) | Cible de règlement stable post-MVP |

> Détail du statut des amendments : voir [DECISIONS.md](DECISIONS.md#mainnet-only).

## Flow end-to-end

### 1. Provider — déposer un dataset
1. Next crée l'identité stable du dataset et récupère la clé publique d'ingestion du runner.
2. Le navigateur vérifie l'origine et l'empreinte SHA-256 épinglée de cette clé, puis chiffre le CSV (**ECDH P-256 + AES-256-GCM**) avant tout transit. Next ne reçoit jamais le fichier en clair.
3. Le runner ouvre l'enveloppe dans le TEE, calcule le Merkle root et les métriques de volume, génère une **DEK aléatoire**, chiffre le dataset puis wrappe la DEK sous la master key dstack.
4. Le blob chiffré part sur **IPFS / Pinata**. Next ne conserve que le CID, la DEK wrappée, le Merkle root, les métadonnées et un reçu HMAC émis par le runner. Ce reçu lie aussi le prix en drops et le délai de remboursement choisis par le provider.
5. Seuls les volumes globaux (nombre de lignes et de colonnes) sont publics ; aucune statistique par colonne, aucun nom de colonne ni extrait de ligne n'est conservé par Next.
6. **Credential KYB accepté** — émis par le vérificateur, accepté par la signature du provider.
7. **Mint MPT signé par le provider** — le dataset existe on-chain, puis son état est réconcilié dans Prisma.

> État actuel : toutes les transactions utilisateur sont préparées côté serveur, contrôlées champ par champ après signature puis soumises par l'API. `EscrowCreate`, paiements, mint/destroy MPT et `CredentialAccept` sont signés par leur propriétaire. L'émission du credential reste logiquement l'acte du vérificateur KYB (D-13/D-14).

### 2. Borrower — emprunter l'accès
1. Parcourt la marketplace : métadonnées, volumes publics et réputation du provider. Cette réputation est une projection déterministe des `EscrowFinish`/`EscrowCancel` confirmés ; aucune ligne brute, statistique par colonne ni schéma n'est exposé.
2. KYB borrower (Credentials).
3. Le runner fournit la condition publique liée au `loanId` et au wallet borrower.
4. Le borrower signe côté client un **EscrowCreate en XRP** vers le provider, au prix et au délai imposés par le reçu provider :
   - `Condition` = crypto-condition PREIMAGE-SHA-256 (le fulfillment est détenu par le vérificateur TEE, **pas** par le borrower).
   - `CancelAfter` = fin de la challenge period.
5. Next persiste le blob signé, son hash et `LastLedgerSequence` sous `SUBMITTING`, puis ne passe à `ESCROWED` qu'après validation ou réconciliation XRPL.
6. Le runner vérifie la transaction historique **et l'objet escrow live** avant le calcul. Le MVP exécute une **régression linéaire multivariée déterministe** bornée à 20 000 lignes, 31 features et un budget de 20 M d'opérations.

### 3. TEE — exécution confidentielle (Phala dstack)
1. Un service Node autonome `src/runner/` tourne seul dans la CVM. Next et la DB restent hors enclave ; seul l'`EscrowFinish` est signé et soumis par le runner.
2. Le runner récupère le blob IPFS, unwrappe la DEK avec la master key obtenue via `DstackClient.getKey()`, vérifie le Merkle root puis déchiffre en enclave.
3. Il entraîne le modèle, applique l'output-gate, chiffre le modèle et le stocke sur IPFS.
4. Il produit une attestation métier et, en mode Phala, une **quote TDX** liée au `payloadHash`.
5. Il émet des reçus HMAC scellés. Chaque opération sensible exige aussi un grant P-256 signé par le wallet, scopé, valable 60 s et inscrit dans un registre anti-rejeu persistant.

### 4. Règlement atomique
1. Après un job réussi, le runner chiffre la clé modèle pour une clé ECDH navigateur **et** sous le fulfillment d'escrow. Cette capsule est persistée puis relue en IndexedDB ; son hash canonique doit correspondre au reçu runner avant tout paiement.
2. Next vérifie l'attestation ; en production distante, la quote TDX, le replay de l'event-log RTMR3 et les valeurs épinglées `mrTd`/`RTMR3`/`compose_hash` sont obligatoires.
3. Le navigateur autorise alors le règlement. Le runner signe et soumet lui-même `EscrowFinish` sans exposer le fulfillment à Next.
4. Next sérialise l'opération sous `SETTLING`; après crash ou timeout, le runner retrouve l'`EscrowFinish` depuis le ledger de création avant toute nouvelle soumission.
5. La transaction validée paie le provider et publie simultanément le fulfillment. Le navigateur le lit sur XRPL et ouvre la capsule déjà détenue.
6. Le payload attesté est gravé on-chain par un Payment minimal avec memo, en best-effort.

Un reaper démarré avec l'application réconcilie périodiquement les `SUBMITTING`/`SETTLING`, libère les leases de calcul abandonnés et demande au runner d'annuler les escrows expirés. Le borrower peut déclencher la même réconciliation depuis `/train` dès que l'échéance locale est atteinte. Le runner compare alors l'heure du ledger validé, contrôle l'`EscrowCreate` historique et l'objet live, puis soumet `EscrowCancel`. La DB ne passe à `CANCELLED` qu'après une transaction de remboursement `tesSUCCESS` retrouvée on-chain et conserve son hash dans `cancelTxHash` ; `shredDataset` reste bloqué jusque-là.

## Réputation et registre d'audit

- La réputation n'est pas déclarative : elle est recalculée depuis les prêts `SETTLED` dotés d'un `settleTxHash`. Les `EscrowCancel` confirmés restent affichés comme volume neutre, sans pénaliser automatiquement une partie dont la responsabilité n'est pas prouvée.
- Le score mesure la profondeur de l'historique de règlements confirmés et atteint son maximum après quinze preuves. Un nouveau wallet reste à `0`, ce qui évite de présenter une identité sans historique comme fiable.
- `/audit` est limité aux wallets borrower/provider concernés. Il expose le titre MPT, l'`EscrowCreate`, le hash d'attestation et l'`EscrowFinish` ou l'`EscrowCancel`, avec liens vers l'explorateur du réseau actif.
- Le score mesure un historique d'exécution, pas la qualité sémantique du dataset. L'arbitrage qualité reste post-MVP.

## Exécution et cycle de vie de la CVM

- En développement, `compose.yaml` reproduit la frontière cible avec deux images séparées. Next attend le healthcheck du runner via `RUNNER_URL=http://runner:4100`. Le runner ne monte ni source, ni `node_modules`, ni Prisma/DB ; son filesystem est read-only hors volume anti-rejeu. Les secrets sont explicitement séparés et les ports hôte restent sur `127.0.0.1`. Le fallback in-process reste disponible sans `RUNNER_URL`.
- L'outillage B.5 fournit `Dockerfile.runner`, un manifeste CVM minimal dans `deploy/phala/compose.yaml` et une commande de capture des mesures. La construction/publication de l'image et la validation sur une CVM Phala réelle restent des opérations de déploiement ; voir [PHALA.md](PHALA.md).
- Topologie MVP : **une CVM runner CPU stable** avec un `app_id` conservé. En production, TLS 1.3 est terminé par le runner dans cette CVM ; le gateway Phala reste en passthrough (`…-4100s.…`). `DstackClient.getTlsKey({ usageRaTls:true })` génère la clé privée et le certificat dans la CVM.
- Avant toute requête métier, Next récupère uniquement l'évidence publique `/ra-tls`, vérifie la quote DCAP (`UpToDate`), sa liaison au SHA-256 du certificat présenté, le hostname, `mrTd`, le replay RTMR3 et `compose_hash`, puis épingle pendant cinq minutes le certificat, l'empreinte de la chaîne KMS et celle de la clé d'ingestion. Capabilities, grants et payloads ne partent qu'après cette validation.
- Pendant la validation : démarrage/arrêt manuel de cette même CVM. Supprimer et recréer une application par job n'est pas retenu, car la master key est liée à l'identité d'application et l'économie de stockage est négligeable.
- Pour le MVP public : la CVM peut rester allumée pour garantir une disponibilité immédiate. Un arrêt/démarrage automatique de la même CVM pourra être ajouté ensuite.
- Le flux actuel est synchrone avec un timeout Next→runner de **60 s**. Il convient à la régression linéaire actuelle, sous réserve de benchmarks.
- `SIRIUS_REAPER_ENABLED=true` active la récupération autonome des états de prêt ; cette valeur est obligatoire au démarrage de production. Le cycle vaut 30 s par défaut et utilise des claims DB idempotents pour éviter les doubles soumissions.
- Les limites mémoire de Next restent une défense locale. La production refuse de démarrer sans `SIRIUS_INGRESS_RATE_LIMITED=true`, qui atteste que l'ingress applique des limites distribuées par IP et globales avant de transmettre les requêtes.
- Les entraînements durant plusieurs heures exigeront une file de jobs, un accusé de réception rapide, un worker asynchrone et du polling ou des événements. Ils ne sont pas supportés par le flux actuel.
- Aucun GPU n'est requis pour le modèle actuel.

## Fair-exchange atomique : protection des DEUX parties ⭐

Le release de l'escrow n'est contrôlé **ni par le borrower ni par le provider**, mais par le **vérificateur TEE** qui détient le fulfillment.

```
TEE produit le modèle ─► capsule verrouillée persistée chez le Borrower
                                      │
                                      └─► EscrowFinish soumis par le runner
                                                ├─► Provider payé
                                                └─► fulfillment public → capsule ouverte

TEE échoue / rien produit ─► personne ne révèle ─► CancelAfter → Borrower remboursé
```

| Scénario | Issue |
|---|---|
| Tout se passe bien | La même transaction paie le provider et déverrouille la capsule déjà détenue ✅ |
| Dataset invalide techniquement | Le job échoue, aucun fulfillment n'est produit → cancel possible ✅ |
| Borrower veut le modèle sans payer | Impossible : la capsule exige le fulfillment que seul l'`EscrowFinish` publie ✅ |
| Dataset valide mais de mauvaise qualité | Non tranché par l'escrow seul → **challenge period + arbitrage** (roadmap) ⚠️ |

C'est le cœur de la proposition de valeur : **confiance neutre prouvée**, sans intermédiaire de confiance.

## Audit sécurité — 14 août 2026

L'audit statique du code n'a démontré aucune vulnérabilité exploitable. Il a couvert les sessions HMAC en cookie `HttpOnly`, les challenges à nonce consommé, la protection CSRF par origine canonique, les grants wallet P-256 scopés et anti-rejeu, les contrôles de propriété API, les entrées bornées, le chiffrement IPFS, le runner isolé/RA-TLS, les contrôles d'escrow XRPL et les dépendances de production.

Cette conclusion concerne le code et la configuration déclarée. Avant toute mise en production, restent obligatoires la validation de l'ingress réel, la capture des mesures de la CVM Phala, l'épinglage des valeurs d'attestation et le smoke RA-TLS sur cette CVM.

## Couche IA — 4 briques (POST-MVP, NON incluses au MVP)

> ⚠️ Aucune de ces briques n'est dans le MVP. Le MVP actuel exécute uniquement la régression linéaire fournie par Sirius. Le code d'entraînement arbitraire du borrower appartient à la vision post-MVP et nécessitera sandboxing, sortie bornée et orchestration asynchrone.

Vocabulaire (à ne pas confondre) :
- **LLM** = modèle de langage. Comprend et écrit du texte ou du code.
- **Agent** = LLM + outils + boucle (agit, observe, recommence).
- **Modèle ML** = apprend une tâche sur des données (≠ langage). Ne « parle » pas.

### Les 4 briques

| # | Nom | Type | Rôle | Voit quoi | Où | À qui |
|---|---|---|---|---|---|---|
| 1 | **Modèle du borrower** | Modèle ML | Le produit final entraîné | la vraie data | **TEE** | Borrower |
| 2 | **Agent de découverte** | LLM + outils | « trouve-moi le bon dataset » | métadonnées (public) | serveur (API OK) | Sirius |
| 3 | **Agent de data-prep** | LLM + outils | commandes NL → code de nettoyage | schéma + stats + synthétique | LLM hors TEE, **code → TEE** | Sirius |
| 4 | **Générateur synthétique** | Modèle ML | fabrique un faux dataset fidèle | la vraie data | **TEE** | Sirius |

Ne sont **pas** de l'IA (juste du code) : chiffrement, differential privacy, canal de feedback sanitisé, escrows.

### Règle d'or (gouverne toute la couche IA)

> Les **LLM** ([2], [3]) ne voient que des **métadonnées / du synthétique**. Les **modèles ML** ([1], [4]) touchent la vraie data mais sont **enfermés dans le TEE**. La donnée brute ne sort jamais.

Conséquence directe : utiliser une API LLM externe pour [2]/[3] ne fait fuiter **aucune** donnée sensible — elle ne voit que le catalogue public et du synthétique.

### Enchaînement

```
Borrower : "je veux X"
   └─► [2] découverte ──► propose un dataset du catalogue
Dataset choisi :
   └─► [4] générateur (TEE) ──► synthétique (faux, visible librement)
Borrower prépare :
   └─► [3] data-prep ──► écrit le pipeline (testé sur le synthétique)
                          │ le pipeline part dans le TEE
   └─► [1] son modèle ──► s'entraîne sur la VRAIE data dans le TEE
                          │ ressort : modèle + métriques agrégées
```

### Travail confidentiel du data scientist : synthétique + éval réelle

Tension irréductible : préparer la data **comme on veut** vs **ne jamais la voir**. Résolution :

1. Le **générateur [4]** produit un **synthétique fidèle** (mêmes distributions ET corrélations) → le data scientist itère dessus en pleine liberté (c'est du faux, zéro fuite).
2. Le pipeline validé s'exécute sur le **vrai** dans le TEE.
3. Le TEE renvoie un **signal réel agrégé** (accuracy, F1, loss, matrice de confusion, feature importance) sanitisé par **differential privacy** → le DS pilote au signal réel sans voir les lignes.

Liberté réelle :
- **Non entravé** : ingénierie (code, pipeline, archi, debug), performance finale (vrai training dans le TEE).
- **Partiellement contraint** : feature engineering fin, error analysis ligne-par-ligne, exploration des cas rares.

Le facteur décisif = **la qualité du générateur [4]** (un synthétique naïf détruit les corrélations et bloque le DS ; un générateur de structure jointe + DP le libère à ~80%). C'est *là* qu'est le seul vrai effort R&D, pas dans les LLM. Compromis identique à celui déjà accepté par le marché (clean rooms, compute-to-data).

### Point de vigilance sécurité

[1] et [3] feront tourner du **code apporté par le borrower** sur la vraie data → risque d'exfiltration (mémorisation dans le modèle, logs). Ce n'est pas encore supporté. Parades requises : sandbox sans réseau sortant, taille de sortie bornée, DP sur les retours et budget de requêtes contre la reconstruction par accumulation.

## Couches du code (nouveau repo)

```
src/
  app/                  # Next.js — landing, shell app et API routes
  components/           # UI (3d/Blob, ui/, wallet/)
  runner/               # service HTTP autonome déployé dans la CVM
  lib/
    xrpl/               # client, MPT, Credentials, Domains, escrow, paiements
    crypto/             # AES-256-GCM, Merkle, wrap/unwrap des DEK
    sirius/             # orchestration datasets, loans, règlement et self-train
    runner/             # grants wallet, capabilities transport, reçus et preuves XRPL
    tee/                # cœur DB-free, dstack, attestation, quote et client runner
    ipfs/               # Pinata
    db.ts               # client Prisma
  generated/prisma/     # client Prisma généré
  stores/               # Zustand UI uniquement, jamais source d'autorité métier
prisma/                 # schema + migrations (SQLite)
docs/                   # ARCHITECTURE / ROADMAP / DECISIONS
```

## Réutilisation depuis le POC (`PBW26/Sirius2.0`)

La reprise est terminée. Les briques XRPL, crypto, wallet Otsu et UI utiles ont été assainies dans la structure actuelle. Ne plus recopier de modules du POC. `lending`, `vault`, escrow Wasm, `patch-codec`, ZK mock, watermark et persistance JSON restent explicitement abandonnés.

## Différences clés vs POC

1. **Mainnet-only** : escrow conditionnel P2P (TokenEscrow) au lieu de Vault + Lending + Smart Escrow wasm.
2. **TEE remplace le watermark** : confidentialité réelle au lieu d'une perturbation fragile.
3. **Pas de ZK au MVP** : métriques en clair (ZK = roadmap).
4. **Fair-exchange atomique** : capsule persistée avant paiement ; le même `EscrowFinish` paie le provider et publie le fulfillment qui l'ouvre.
5. **Persistance réelle** : SQLite + Prisma.
