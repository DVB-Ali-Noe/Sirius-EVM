# Facturation du compute au borrower

Point de reprise du 23 septembre 2026. **Priorité avant tout nouveau déploiement de contrats pour Phala.** Cette fonctionnalité est à concevoir et implémenter ; aucun tarif commercial ni nouvel escrow de facturation n’est déployé.

## Objectif et orientation

Le borrower doit connaître et accepter le prix du dataset et celui de l’entraînement avant tout calcul. Pour le MVP, retenir un **devis fixe garanti en USDC**, bloqué en escrow avant démarrage. Sirius assume une erreur d’estimation ; aucun supplément automatique ni prélèvement supplémentaire pendant un job.

Le devis distingue le prix du provider, le prix du compute et leur total. Les frais réseau en ETH sont affichés séparément et restent des estimations du wallet. Les USDC versés à Sirius rémunèrent son service ; ils ne rechargent pas automatiquement le compte Phala, dont la facture reste payée par l’opérateur.

Le périmètre initial concerne les prêts borrower/provider. La facturation des entraînements personnels et le choix VPS/Phala ne sont pas ajoutés implicitement à ce chantier.

## État actuel à prendre en compte

- `src/lib/sirius/borrower.ts` prépare le prêt avec `amountUsdcAtomic = dataset.priceUsdcAtomic`.
- `contracts/src/SiriusEscrow.sol` v6 crédite tout le montant au provider lors de `release`. Ajouter un supplément au montant actuel ne rémunérerait donc pas Sirius.
- Le permis EIP-712 autorise déjà les conditions du lock ; il ne contient pas de prix compute distinct ni de bénéficiaire de ces frais.
- Le runner prend en charge les régressions linéaire et logistique. L’ingestion impose 20 millions d’opérations au maximum ; le délai de calcul configuré est de 15 secondes. Ce délai ne borne pas à lui seul les transferts, le stockage et le parcours complet.
- Les dimensions nécessaires au devis devront être liées à un reçu authentifié du dataset. Ne pas faire confiance à une taille ou à un nombre de lignes déclarés par le navigateur.

## Parcours cible

1. À l’ingestion, le runner valide le profil et les caractéristiques nécessaires à l’estimation, puis les lie au dataset dans son reçu, sans exposer les données brutes.
2. Avant l’emprunt, produire un devis signé à durée de validité courte. Il lie au minimum le borrower, le provider, le dataset, le profil et ses paramètres, l’identité du runner, le réseau/contrat, les deux prix, le bénéficiaire compute, les limites d’exécution et la version du tarif.
3. Afficher le devis puis faire accepter et verrouiller exactement le total en USDC. Lire les décimales du token ; persister et signer les montants en unités atomiques entières.
4. Le runner vérifie le paiement confirmé et toutes les conditions signées avant de déchiffrer pour l’entraînement ou de calculer. Un devis seul ne déclenche aucun job.
5. À la réussite, publier le préimage et créditer atomiquement le provider pour le dataset et la trésorerie Sirius pour le compute. Conserver les retraits pull-only et la protection de la livraison du modèle jusqu’au règlement.
6. Politique proposée pour le MVP : échec ou dépassement de budget sans livraison, remboursement intégral des deux postes USDC. Les frais réseau déjà dépensés ne sont pas inclus. Définir la procédure anticipée et une récupération à échéance utilisable même si le runner est indisponible ; un message d’erreur HTTP ne suffit pas à autoriser un remboursement.

Les reprises doivent être idempotentes : aucun double prélèvement, double crédit ou double remboursement. Une perte de réponse après règlement doit permettre de retrouver le modèle sans facturer un nouvel entraînement.

## Estimer et fixer le prix

Construire une grille par profil à partir du nombre de lignes, du nombre de variables, des paramètres et de benchmarks sur la même classe de CVM. Couvrir aussi les coûts de préparation et de livraison, puis figer le prix dans le devis accepté.

```text
prix compute = coût estimé du calcul
             + contribution aux frais de disponibilité et de stockage
             + marge de sécurité
```

Phala facture la machine pendant qu’elle est allumée, même sans entraînement, et le disque tant qu’il est conservé. Au dernier contrôle, la CVM Sirius coûte `0.058000` USD/h de calcul et `0.002780` USD/h de disque. Facturer uniquement les secondes actives d’un job ne couvre pas nécessairement les périodes d’inactivité. Voir la [tarification Phala](https://cloud.phala.com/about/pricing).

Le minimum facturé, les marges, la répartition des frais fixes et la convention USD/USDC restent à définir. Les `0,01 USDC` évoqués dans la conversation étaient un exemple d’affichage, pas un tarif validé. Aucun coefficient de performance Phala n’a encore été mesuré pour ce devis.

## Travail à reprendre

1. Formaliser le devis, le destinataire des frais, le traitement des échecs et les règles d’expiration/reprise. Préparer les fixtures synthétiques et le protocole de benchmark localement.
2. Concevoir l’évolution de l’escrow et du domaine signé. **V7 est la version pressentie**, à figer pendant l’implémentation ; le code et les contrats publics restent en v6. Ne pas changer seulement une adresse ni réinterpréter les anciens prêts avec la nouvelle répartition.
3. Implémenter les deux montants et leurs bénéficiaires dans le contrat, les autorisations, les reçus, le runner, la base, les routes, le reaper, les écrans wallet et les preuves d’audit. Mettre à jour ABI, contrôles de version, scripts et préflights.
4. Tester localement : somme exacte transférée, substitution des prix/bénéficiaires/domaines, devis expiré ou rejoué, refus de démarrer sans paiement, répartition atomique, remboursements, panne runner, reprises et compatibilité des retraits/modèles historiques.
5. Avant les benchmarks réels, annoncer à Noé quand Phala sera utilisé, pour combien de temps et à quel coût estimé. Calibrer ensuite la grille et vérifier l’identité de la même CVM.
6. Après validation de cette fonctionnalité, reprendre la sauvegarde, la préservation des 13 références de modèles historiques et la migration décrite dans [PHALA.md](PHALA.md). Déployer directement la version retenue avec facturation, puis valider le parcours complet à deux wallets.

## Contraintes de reprise

- La CVM est **arrêtée à la demande de Noé** ; préparer le chantier localement. Ne pas la redémarrer pour coder ou tester localement, ni lancer un benchmark Phala sans l’avoir prévenu du moment et du budget.
- Aucun nouveau déploiement Solidity, changement de base distante ou activation de Phala n’a été effectué pour cette facturation.
- Les identités restent distinctes : le déployeur paie la création des contrats ; le compte EVM dérivé dans Phala autorise les prêts et paie le gas des règlements ; la trésorerie reçoit les revenus compute. L’adresse de trésorerie doit être choisie explicitement.
- Conserver le KYB ouvert pour la démonstration testnet actuelle. Le mode VPS reste une [spécification différée](RUNNER-MULTI-BACKEND.md).
- Conserver les accès privés et les historiques existants ; ne publier aucun secret dans ces documents. Aucune commande Git sans demande explicite de Noé.
