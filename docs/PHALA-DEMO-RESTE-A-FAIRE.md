# Reste à faire — espace Phala puis runner VPS

État documentaire du **26 septembre 2026**, sans attribution nominative des tâches. Cette liste reprend le reste à faire communiqué dans la conversation. Elle complète le [plan](PLAN-VPS-PHALA.md), le [journal avant/après](PHALA-DEMO-IMPLEMENTATION.md) et le [runbook technique](PHALA-DEMO-RUNBOOK.md).

## Point de départ

Le parcours `/phala`, le panneau `/phala/operator`, les sessions manuelles, les quotas, le financement sponsorisé et la livraison chiffrée après arrêt sont implémentés localement. Les tests locaux, le typage, le lint et le build passent. La migration de livraison est préparée, pas appliquée à distance. **Cette nouvelle version n’est ni publiée ni validée sur Phala réel.**

Les reapers staging et production ont été transférés sur le nouveau VPS. Le calcul habituel n’a pas encore été déplacé sur ce VPS. La CVM était arrêtée au dernier contrôle distant documenté ; aucune lecture distante nouvelle n’a été faite pour rédiger cette checklist. La bascule globale v7 de staging et le nettoyage Neon de l’ancien lot B sont différés.

Les validations locales enregistrées sont : 366 tests au dernier passage applicatif complet, puis 20 tests ciblés après les derniers ajouts (15 Phala et 5 provenance), 3 scénarios navigateur simulés. Ces nombres se recouvrent ; ne pas les additionner ni les présenter comme un parcours matériel attesté.

## P08 — Configurer, déployer et valider l’espace Phala

### 1. Choisir les domaines

- [ ] Confirmer le sous-domaine de l’espace Phala, par exemple `confidential.sirius-data.tech` ; cet exemple n’est pas encore une cible validée.
- [ ] Choisir l’origine HTTPS du contrôleur extérieur.
- [ ] Configurer DNS, certificats valides et renouvellement TLS.

### 2. Configurer les opérateurs

- [ ] Choisir explicitement les deux wallets autorisés à activer, désactiver et arrêter Phala.
- [ ] Renseigner la même allowlist `SIRIUS_DEMO_OPERATORS` dans Next et le contrôleur.
- [ ] Ne pas promouvoir automatiquement les anciens wallets provider/borrower de test.

### 3. Affecter le financement

- [ ] Relever les crédits Phala réellement utilisables et dater ce relevé.
- [ ] Choisir crédits seuls, budget Sirius ou financement mixte.
- [ ] Affecter explicitement le complément payé éventuel et le plafond cumulé.
- [ ] Prévoir la réserve de disponibilité de la machine, de stockage et d’arrêt ; calibrer les coûts des opérations.
- [ ] Préparer les politiques privées sans assimiler crédits ou apports à une marge acquise. Aucun montant n’est approuvé par cette checklist.

### 4. Fixer les quotas

- [ ] Définir les limites globales, par wallet et de concurrence.
- [ ] Compter le scellement et l’entraînement comme deux opérations distinctes.
- [ ] Tenir compte des limites Next existantes : 3 entraînements par wallet et par heure, 30 globaux par heure, un calcul simultané.
- [ ] Vérifier que les coûts et le budget couvrent aussi les requêtes d’ingestion et de contrôle métier.

### 5. Base et migrations — staging (D-26)

- [ ] Conserver la base Neon staging existante avec ses accès actuels ; aucune base dédiée n’est créée.
- [ ] Laisser la pipeline appliquer `20260926000000_add_self_train_delivery` lors de la fusion vers `staging`, avant tout service du nouveau code.
- [ ] Vérifier après fusion, par l’inventaire de base en lecture seule, que la migration est présente et que les lignes historiques sont intactes.
- [ ] Vérifier le stockage des capsules de livraison et les accès réservés au propriétaire.

### 6. Instance Vercel — staging (D-26)

- [ ] Ajouter le domaine `phala.sirius-data.tech` au projet Vercel staging et le rendre origine principale ; garder `sirius-evm-staging.vercel.app` en alias.
- [ ] Aligner `SIRIUS_APP_ORIGIN`, `NEXT_PUBLIC_SIRIUS_APP_ORIGIN`, les alias et les domaines autorisés de connexion wallet ; la pipeline réécrit ces origines depuis le sélecteur de cible, qui doit connaître le nouveau domaine.
- [ ] Renseigner `SIRIUS_PHALA_DEMO=true`, `SIRIUS_DEMO_OPERATORS`, `PHALA_DEMO_CONTROLLER_URL` et `PHALA_DEMO_CONTROLLER_SECRET` ; aucune master key d’enclave dans Next.
- [ ] Ajouter `SIRIUS_LEGACY_ESCROW_ADDRESSES` avec les escrows historiques de staging pour les crédits anciens.
- [ ] Configurer le lien `/phala` du site principal vers `phala.sirius-data.tech`.
- [ ] Vérifier le faucet et les soldes ETH testnet nécessaires au KYB et au titre du dataset ; le self-train ne demande pas de paiement client.

### 7. Configuration staging héritée de l’ancienne bascule

- [x] Inventorier les variables Vercel et GitHub préparées pour l’ancienne bascule v7/Phala : elles sont conservées telles quelles et deviennent la configuration de l’instance de démonstration (D-26).
- [ ] Recapturer et remplacer les mesures attendues et l’empreinte d’ingestion après publication de la nouvelle image ; ne pas réutiliser celles de l’ancienne image.
- [ ] Garder le nettoyage Neon différé ; ne pas reprendre ses commandes.

### 8. Livrer les modifications sur GitHub

- [ ] Relire le code, les migrations, les fichiers d’exploitation et la documentation ; coordonner les modifications concurrentes.
- [ ] Une fois les opérations Git explicitement demandées, commiter/pousser les fichiers utiles, préparer la PR et valider la CI sur la cible choisie.
- [ ] Exclure secrets, fichiers privés, sauvegardes, `CLAUDE.md` et `AGENTS.md`. Le dépôt partage le contexte via `docs/` ; les deux fichiers de contexte agent restent locaux et se transmettent hors Git.
- [ ] Ne pas déduire l’état GitHub de ces changements locaux : aucun commit/push n’a été exécuté pendant leur implémentation.

### 9. Publier et installer le nouveau runner

- [ ] Construire et publier l’image contenant cette implémentation ; conserver son digest immuable.
- [ ] Préparer les Compose `demo-init` et `demo-active`, avec des volumes dédiés au budget et à l’anti-rejeu.
- [ ] Initialiser les nouveaux volumes et politiques une seule fois, sans supprimer les registres historiques ni recréer des crédits consommés.
- [ ] Vérifier la cohérence testnet/contrats/signataire/politiques. Si les contrats du 25 septembre sont conservés, garder la configuration v7 attendue.

### 10. Installer le contrôleur sur le VPS

- [ ] Installer le service préparé sous `sirius-ops` sur le nouveau VPS, en préservant les reapers.
- [ ] Configurer le profil Phala, les secrets, le fichier de financement et l’état persistant avec des permissions privées.
- [ ] Rendre son HTTPS accessible depuis Vercel et vérifier pare-feu, certificat et renouvellement.
- [ ] Vérifier qu’un redémarrage du contrôleur ne déclenche pas de démarrage CVM.
- [ ] Garder les watchdogs de fermeture temporisée désactivés. Les lectures et alertes de supervision ne commandent pas d’arrêt.

### 11. Valider l’attestation et les liaisons réelles

- [ ] Annoncer le créneau et l’estimation de coût avant la prochaine utilisation Phala.
- [ ] Démarrer la nouvelle configuration pour sa validation, puis vérifier la quote matérielle `UpToDate`, son lien au certificat et les mesures.
- [ ] Épingler MRTD, RTMR3, hash Compose, chaîne KMS et empreinte d’ingestion dans les composants concernés.
- [ ] Vérifier que le signataire correspond aux contrats. Un changement d’identité peut nécessiter de nouveaux contrats ; ne pas partager la clé Phala avec le VPS.
- [ ] Ne pas réutiliser aveuglément les mesures de l’ancienne image et ne pas substituer un runner VPS/Next en cas d’échec.

### 12. Finaliser la présentation

- [ ] Harmoniser les libellés de la nouvelle page avec le site anglais ; les traductions des erreurs sont déjà ajoutées.
- [ ] Relire les étapes wallet, les limites CSV/profils, les états fermé/indisponible et les exemples.
- [ ] Expliquer la conservation du modèle et la nécessité du même navigateur, de la même origine et du même wallet pour sa livraison enregistrée.
- [ ] Décrire exactement les capacités et la preuve disponibles dans les messages de lancement.

### 13. Préparer l’exploitation et la reprise

- [ ] Définir le suivi des dépenses réelles, y compris machine allumée sans calcul et disque après arrêt.
- [ ] Préparer la sauvegarde et la restauration des nouveaux registres, de l’état du contrôleur et des métadonnées de livraison.
- [ ] Définir la procédure de réconciliation après interruption avant de rouvrir une session.
- [ ] Intégrer l’estimation automatique des frais d’hébergement et les notifications externes au panneau ; elles ne sont pas encore livrées. Pour une première session supervisée, documenter et assurer un suivi manuel explicite.
- [ ] Vérifier qu’aucun dépassement de quota ne ferme automatiquement la session : l’arrêt reste une décision opérateur. Un quota logiciel ne plafonne pas à lui seul la facture fournisseur.

### 14. Répéter le parcours sur les vrais services

- [ ] Une visite ou un utilisateur non opérateur ne démarre rien ; les commandes lui sont refusées.
- [ ] Activer manuellement ; n’ouvrir qu’après attestation vérifiée ; refuser un mauvais pin.
- [ ] Entraîner les deux exemples et un CSV personnel ; vérifier titre PRIVATE, métriques, fichier de modèle et budget consommé.
- [ ] Fermer pendant un calcul : refuser les nouvelles admissions et conserver le résultat engagé avant l’arrêt confirmé.
- [ ] Recharger le navigateur et télécharger le modèle alors que la CVM est arrêtée ; vérifier le refus pour un autre wallet ou une clé locale absente.
- [ ] Réouvrir : conserver les dépenses, refuser un grant de session ancienne, tester quotas et budget insuffisant sans fermeture automatique.
- [ ] Tester l’arrêt d’urgence pendant l’ouverture puis pendant le calcul ; vérifier l’état réel du fournisseur et la réconciliation avant reprise.
- [ ] Redémarrer seulement le contrôleur : aucune commande automatique à Phala ; intervention explicite si une commande a été interrompue.

**Porte de publication :** configuration dédiée cohérente, nouvelle attestation vérifiée, parcours réel et fermeture/récupération validés, financement affecté et exploitation supervisée. Les tests locaux avec API simulées ne suffisent pas. L’ouverture publique reste manuelle ; aucune durée de deux heures n’est imposée.

## Fiabilisation technique encore ouverte

Ces limites doivent rester explicites pendant les premiers essais ; les tests locaux verts ne les résolvent pas.

- [ ] Automatiser ou outiller la réconciliation self-train après arrêt brutal : les réservations restent engagées, il ne faut ni fabriquer un succès ni effacer le budget.
- [ ] Fiabiliser la récupération si Next perd la réponse avant de persister la capsule ; un résultat calculé peut alors rester inaccessible depuis la base.
- [ ] Concevoir une récupération facultative après perte de la clé IndexedDB ou changement de navigateur. En l’état, seul le modèle déjà exporté est conservable ailleurs sans cette clé locale.
- [ ] Compléter les alertes et estimations d’hébergement décrites au point 13.

## P09 — Déplacer les entraînements habituels sur VPS

Ce chantier est différé après la première livraison Phala. Le VPS héberge déjà les reapers, pas le runner d’entraînement.

- [ ] Déployer un vrai service runner VPS séparé du reaper.
- [ ] Ajouter une destination VPS explicite et un transport HTTPS authentifié distinct de la RA-TLS Phala.
- [ ] Prévoir identité, clés, provenance et stockage persistants propres au VPS.
- [ ] Fixer les limites CPU/RAM/temps et les quotas ; vérifier sauvegarde/restauration.
- [ ] Adapter la configuration applicative et inventorier les liaisons de contrats/datasets avant la bascule.
- [ ] Tester un entraînement complet, la livraison du modèle et la reprise après redémarrage.
- [ ] Afficher honnêtement les garanties du calcul VPS ; ne jamais présenter ce parcours comme exécuté en enclave Phala.

## Suites produit différées

- [ ] Uploads plus volumineux et reprise d’envoi.
- [ ] Entraînement asynchrone.
- [ ] Modèles à arbres.
- [ ] Pilote réel de data lending avec des données externes.
- [ ] Reprendre ensuite la checklist mainnet : audit externe corrigé, KYB réel, trésorerie/commission, plafonds, monitoring et procédures d’incident.

La démonstration de self-train ne clôt ni le pilote de data lending ni les portes mainnet. Les obligations historiques restent documentées dans leurs runbooks ; elles ne réactivent pas la remise à zéro de staging ou une fermeture Phala programmée.
