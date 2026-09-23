# Préparation de l’exploitation — 23 septembre 2026

## Périmètre demandé par Noé

Préparer coûts, sauvegarde/restauration, images et migration, sans démarrer Phala. Les identifiants PostgreSQL existants sont conservés explicitement : leur rotation est hors périmètre. L’ancienne note évoquant un partage dans une conversation n’a pas été étayée par le message d’origine ; elle ne constitue pas une compromission établie.

La préparation a utilisé la base de production en **lecture seule**, des lectures de blobs chiffrés Pinata, le RPC testnet en lecture et l’API de gestion Phala. Aucune migration distante, transaction, publication d’image ou activation de service n’a été effectuée. Aucun entraînement n’a été envoyé à Phala.

Dernier contrôle Phala le **23 septembre à 13:13:42 UTC (15:13:42 à Paris)** : `stopped: true`, `stopRequested: false`, `dryRun: true`. La CVM existante et son disque sont conservés. Ce relevé ponctuel ne constitue pas une surveillance permanente.

## Coûts préparés

Le [plan chiffré](../deploy/operations/testnet-plan.json) reste un brouillon, sans plafond de dépense approuvé, sans marge acquise inventée et sans politique de facturation active. `pnpm ops:costs` reproduit les calculs en entiers.

Le tarif `tdx.small` vérifié dans l’API de la CVM et la [grille Phala](https://cloud.phala.com/about/instance-types) est de **0,058 USD/h** pour le calcul. Le [stockage](https://cloud.phala.com/about/pricing) coûte **0,000139 USD/Go/h**, y compris à l’arrêt : **0,002780 USD/h pour les 20 Go existants**.

| Hypothèse sur 30 jours | Calcul | Disque conservé 30 jours | Total Phala |
|---|---:|---:|---:|
| Une session de 2 h | 0,116 USD | 2,0016 USD | 2,1176 USD |
| Dix sessions de 2 h | 1,16 USD | 2,0016 USD | 3,1616 USD |
| CVM allumée en permanence | 41,76 USD | 2,0016 USD | 43,7616 USD |

Ces valeurs excluent Pinata, Vercel, Neon, VPS, RPC, taxes et conversion USD/USDC. Les crédits prépayés éventuels n’ont pas été assimilés à une marge acquise. Les tokens faucet ne règlent pas ces fournisseurs.

Exemple de fréquentation, sans promesse de vente : à un emprunt réussi par jour avec CVM allumée en permanence, Phala seul revient à **1,45872 USD par réussite**, ou **1,83 USD** après arrondi au centime avec un coussin illustratif de 25 %. Ce n’est pas le tarif commercial complet. Sans vente, aucun prix par emprunt ne couvre les frais fixes. La retenue en échec doit rester fondée sur les coûts mesurés et justifiés, sans y appliquer cette marge.

Restent à fixer avant activation : durée des sessions, plafond de pertes financées pour les essais, coûts/limites des autres fournisseurs et tarif validé. Le mode strict actuel du registre refuse les dépenses sans marge acquise ; un apport ou des crédits de test ne doivent pas être déclarés comme des bénéfices pour contourner ce contrôle.

### Benchmarks locaux

`pnpm ops:benchmark` utilise uniquement des CSV synthétiques déterministes, le vrai worker avec ses limites de mémoire et les limites d’ingestion. Dix mesures par jeu ; aucune requête IPFS/RPC.

| Profil | Lignes / variables | Taille CSV | Médiane locale | Maximum observé |
|---|---:|---:|---:|---:|
| Linéaire | 1 000 / 4 | 27 509 octets | 175 ms | 261 ms |
| Linéaire | 17 000 / 31 | 2 990 864 octets | 317 ms | 333 ms |
| Logistique | 1 000 / 4 | 24 058 octets | 186 ms | 201 ms |
| Logistique | 3 100 / 31 | 534 988 octets | 275 ms | 282 ms |

Mesures Apple M2/arm64, Node 26.8.1. Elles valident le banc synthétique, pas la vitesse de la CVM ni le coût des transferts. La calibration Phala reste à effectuer lors d’un créneau annoncé à Noé.

## Sauvegarde et restauration réalisées

Snapshot cohérent du **23 septembre à 12:52:55 UTC**, sous transaction PostgreSQL `REPEATABLE READ READ ONLY` ; `pg_dump` importe exactement ce snapshot. La source est PostgreSQL **18**, distincte du PostgreSQL 17 de la suite de concurrence existante.

- 10 tables sauvegardées, dont 30 datasets, 10 prêts et 8 entraînements personnels.
- Export au format PostgreSQL custom, immédiatement scellé sous AES-256-GCM ; aucun dump en clair écrit sur disque.
- Dossier `.ops/snapshot-2026-09-23T12-52-55.821Z-4e7dea69`, en `0700`, fichiers en `0600` ; exclu du contexte Docker et des règles de suivi Git.
- Clé distincte dans `~/.local/share/sirius/backup-keys/`, jamais dans le dépôt ni dans une image. Le manifeste privé donne son chemin exact.
- Restauration dans un conteneur PostgreSQL 18 jetable, **sans réseau**, sur mémoire temporaire. Aucune URL distante n’est acceptée comme cible de restauration par l’outil.
- Comparaison par empreintes de toutes les lignes des 10 tables : identiques après restauration.
- Migrations `20260919000000_track_runner_provenance` et `20260923000000_add_compute_billing` appliquées sur cette copie : toutes les colonnes historiques et leurs valeurs sont conservées. La base distante n’a pas été migrée.
- Le conteneur et ses données temporaires sont détruits après vérification.

Commandes reproductibles :

```bash
pnpm ops:postgres backup .env.phala-production-secrets
pnpm ops:postgres verify /chemin/snapshot /chemin/separe/snapshot.key
pnpm ops:models /chemin/snapshot /chemin/separe/snapshot.key .env.phala
```

Les fichiers d’environnement sont lus explicitement, sans fusion avec `.env` ni affichage de leurs valeurs. Le dump couvre le schéma applicatif `public` ; rôles PostgreSQL, permissions fournisseur, autres schémas et sauvegardes du fournisseur ne sont pas restaurés par cet exercice. L’outil vérifie la compatibilité des migrations avec leurs empreintes avant de les appliquer localement.

Les **13 blobs de modèles historiques** ont été téléchargés, sauvegardés sous chiffrement supplémentaire et relus avec empreintes identiques. Leurs clés de chiffrement d’origine n’ont pas été récupérées : leur déchiffrement et leur re-livraison restent à prouver avec le parcours historique autorisé. Préserver cet accès pendant la bascule. La sauvegarde locale doit également recevoir une copie hors de cette machine dans un emplacement choisi, avec conservation séparée de sa clé.

La sauvegarde est une observation ponctuelle ; refaire un snapshot pendant la maintenance. Elle n’autorise pas à restaurer un ancien registre de budget pour récupérer artificiellement des allocations.

## Historiques et fonds testnet

Lecture au bloc **123205412**, sans transaction envoyée :

| Escrow historique | Version | USDC verrouillés | Crédits dus / solde |
|---|---|---:|---:|
| `0x805a2c2deaa3a8926e85fed6b341dacb54cacba0` | v6 | 0 | 20 / 20 USDC testnet |
| `0xede81141d007593d4bfce2de4778f753d167700e` | v5 | 0 | 100 / 100 USDC testnet |

Conserver ces deux adresses dans les escrows historiques autorisés. Le déployeur/trésorerie choisi possède `0,007914660088247486` ETH testnet ; Phala possède 0 ETH. Le compte Phala devra être financé avant ses règlements ; prévenir Noé du besoin de faucet au moment de l’opération. Aucun financement n’a été déclenché ici.

## Déploiement préparé

Le Compose VPS transmet désormais le mode de facturation, le runner distant, son secret de transport, les mesures attendues, les contrats et la finalité au reaper. En v7, le reaper refuse de démarrer sans configuration distante complète. Son délai d’arrêt passe à 90 secondes pour laisser terminer un appel runner de 60 secondes.

`pnpm ops:check-release <next.env> <reaper.env> <runner.env>` compare les trois configurations privées : réseau testnet, contrats publics/privés, version, finalité, mesures, transport et base. Il refuse les secrets d’enclave/déploiement dans les services et n’affiche que les noms des champs problématiques. Ce contrôle hors ligne ne certifie ni l’attestation active, ni les contrats publics, ni le financement des politiques.

Images locales de préparation : `sirius-runner:ops-v7-20260923` et `sirius-worker:ops-v7-20260923`, plateforme `linux/amd64`. Leur manifeste de construction est conservé dans `.ops/release-preparation/`. Les tags locaux servent à la préparation ; avant publication, relever le digest du registre publié et le figer dans le Compose final. Le digest de l’ancienne image Phala reste inchangé dans le Compose d’amorçage.

`.dockerignore` exclut désormais aussi `.vercel`, `.keys`, `.ops` et les artefacts navigateur. Ces répertoires privés et sauvegardes restent hors du contexte de construction.

### Superviseur extérieur préparé

`pnpm ops:watchdog <session.json>` contrôle une session bornée par des timestamps absolus et l’app ID attendu. Par défaut, il lit l’état et signale le besoin d’arrêt. `--apply-stop` autorise uniquement une demande d’arrêt après échéance ; aucun chemin ne démarre ni ne supprime de CVM. Un redémarrage du superviseur ne remet pas l’échéance à zéro.

Les unités `deploy/operations/sirius-phala-watchdog.{service,timer}` sont préparées, **non installées et non activées**. Avant utilisation : installer Node/pnpm et la CLI épinglée, créer l’utilisateur `sirius-ops` avec son répertoire privé `/var/lib/sirius-ops`, configurer le profil Phala autorisé, puis écrire `/etc/sirius/operations/session.json` en `0600`, lisible par cet utilisateur. Sa structure contient `version: 1`, `profile`, `cvmId`, `appId`, `startedAt` et `stopAt` en millisecondes UTC ; la fenêtre doit être positive et inférieure ou égale à 24 h. Ne pas régénérer ce fichier au démarrage du service.

Le timer contrôle chaque minute ; prévoir le délai de contrôle et les pannes API dans la réserve d’arrêt. Une API inaccessible produit un échec visible au superviseur et exige une intervention. Le timer doit être actif avant tout futur démarrage manuel et surveillé extérieurement. Cet arrêt ne purge pas le disque et ne plafonne pas les autres factures. Les plafonds réels des comptes fournisseurs restent à vérifier ; [Vercel](https://vercel.com/docs/spend-management) documente des délais et exclusions à son contrôle de dépenses.

## Validation et prochaines décisions

- 302 tests applicatifs et 8 tests des outils d’exploitation réussis ; ces derniers sont ajoutés à la CI.
- Lint, typage et build Next réussis.
- Sauvegarde réelle, restauration locale PostgreSQL 18 et migrations avec historiques vérifiées.
- Banc de calcul synthétique exécuté ; 13 copies de blobs relues et vérifiées.
- Images runner et worker construites localement pour `linux/amd64`, puis chargement de leurs modules vérifié sans réseau sur un système de fichiers en lecture seule ; Compose VPS rendu avec une configuration synthétique.

Restent avant toute activation : plafond financé des essais et tarifs complets, limites des fournisseurs, copie externe de sauvegarde et accès historique aux clés, calibration/finalité sur la cible, publication des images, déploiements/migrations et parcours complet à deux wallets. La préparation locale ne constitue pas une autorisation de redémarrer Phala.
