# Facturation du compute au borrower

Point de reprise du 23 septembre 2026. **Priorité avant tout nouveau déploiement de contrats pour Phala.** [Escrow v7](ESCROW-V7.md), les [budgets durables](RUNNER-BUDGETS.md) et le [parcours devis → prépaiement → calcul → règlement/remboursement](BILLING-INTEGRATION.md) sont implémentés localement. Les tarifs réels, la comptabilité et les plafonds fournisseurs restent à valider ; aucun tarif commercial ni nouvel escrow de facturation n’est déployé.

**Activation bloquée après l’[audit du 23 septembre 2026](AUDIT-2026-09-23.md).** Les défauts confirmés restent **non corrigés** : une confirmation RPC perdue après remboursement peut bloquer le wallet runner ; un borrower peut abandonner après calcul réussi puis récupérer tout son prépaiement ; l’omission du devis dans les réponses API contourne sa confirmation et réactive les transactions fournies par le serveur. En outre, le cache d’ingestion conserve une copie de `wrappedKey` après suppression Prisma : le crypto-shredding n’est pas garanti. Voir les [déclencheurs et effets constatés](BILLING-INTEGRATION.md#défauts-confirmés-avant-activation). Phala reste arrêté ; cette mise à jour ne modifie aucun comportement métier ni environnement distant.

## Objectif et orientation

Le borrower doit connaître et accepter le prix du dataset et celui de l’entraînement avant tout calcul. Pour le MVP, retenir un **devis fixe garanti en USDC**, bloqué en escrow avant démarrage. Aucun supplément automatique ni prélèvement supplémentaire pendant un job. Une erreur d’estimation doit rester dans un budget préalablement réservé ; elle ne donne jamais droit à des dépenses ou reprises illimitées.

**Orientation demandée par Noé le 23 septembre :** augmenter le tarif minimum pour tous les emprunts afin de couvrir une faible fréquentation, et empêcher qu’erreurs ou abus puissent vider les wallets ou créer des dépenses non couvertes. L’objectif est un PnL non négatif. Les protections ci-dessous restent à compléter et intégrer ; un tarif élevé, une réserve de trésorerie ou un seuil d’alerte ne prouvent pas à eux seuls cet objectif.

Le devis distingue le prix du provider, le prix du compute et leur total. Les frais réseau en ETH sont affichés séparément et restent des estimations du wallet. Les USDC versés à Sirius rémunèrent son service ; ils ne rechargent pas automatiquement le compte Phala, dont la facture reste payée par l’opérateur.

Le périmètre initial concerne les prêts borrower/provider. La facturation des entraînements personnels et le choix VPS/Phala ne sont pas ajoutés implicitement à ce chantier.

## État actuel à prendre en compte

- Le mode par défaut reste v6 : prix dataset seul et crédit provider. Le mode explicite `SIRIUS_BILLING_VERSION=7` exige le nouveau contrat et le devis signé avec ses deux montants.
- La [nouvelle intégration](BILLING-INTEGRATION.md) réserve le budget de clôture avant émission du devis, demande son acceptation lorsqu’il est présent, vérifie les conditions avant calcul et mesure les échecs. Les défauts de confirmation et de reprise empêchent encore de garantir le parcours complet. Une migration Prisma additive est préparée, sans modification distante.
- Le contrat crédite un forfait compute par profil, avec minimum commun, lors du `release`. Le calcul réussi ne déclenche pas seul ce règlement : le grant ultérieur du borrower reste nécessaire. Le temps actif mesuré en échec comprend les transferts ; son taux doit être justifié par les coûts engagés et rester sans marge commerciale.
- L’ingestion impose 20 millions d’opérations au maximum. Le job v7 ajoute un délai global de 1 à 30 secondes et un worker terminable, sans remplacer les plafonds fournisseur et le superviseur d’infrastructure.
- Aucun budget réel, tarif commercial, compte de trésorerie choisi ou plafond fournisseur actif n’est introduit par les fixtures de tests.

## Parcours cible

1. À l’ingestion, le runner valide le profil et les caractéristiques nécessaires à l’estimation, puis les lie au dataset dans son reçu, sans exposer les données brutes.
2. Avant l’emprunt, produire un devis signé à durée de validité courte. Il lie au minimum le borrower, le provider, le dataset, le profil et ses paramètres, l’identité du runner, le réseau/contrat, les deux prix, le bénéficiaire compute, les limites d’exécution, la version du tarif et la règle de retenue en cas d’échec avec son plafond et son barème de coûts.
3. Afficher le devis puis faire accepter et verrouiller exactement le total en USDC. Lire les décimales du token ; persister et signer les montants en unités atomiques entières.
4. Le runner vérifie le paiement confirmé, toutes les conditions signées et la réservation durable du budget maximal avant de déchiffrer pour l’entraînement ou de calculer. Un devis seul ne déclenche aucun job. L’admission financière est atomique entre toutes les instances ; une comptabilité indisponible ou incertaine bloque les nouveaux jobs.
5. À la réussite, publier le préimage et créditer atomiquement le provider pour le dataset et la trésorerie Sirius pour le compute. Conserver les retraits pull-only et la protection de la livraison du modèle jusqu’au règlement.
6. **Politique MVP choisie par Noé :** en cas d’échec, rembourser le dataset et le compute non consommé ; retenir uniquement les frais d’exécution engagés, vérifiables, plafonnés et annoncés dans le devis. Sans démarrage, aucun frais de calcul n’est acquis. Les frais réseau payés directement par le wallet ne sont pas remboursés par le protocole ni comptés une seconde fois dans la retenue. Définir la procédure anticipée et une récupération à échéance utilisable même si le runner est indisponible ; un message d’erreur HTTP ne suffit pas à autoriser un remboursement ou une retenue.

```text
retenue en échec = min(frais d’exécution justifiés,
                      plafond de retenue accepté,
                      montant compute déposé)
remboursement en échec = prix dataset + prix compute - retenue
```

Le prix fixe complet s’applique à la réussite. En échec, la marge commerciale et les provisions non consommées ne deviennent pas des frais d’exécution. La mesure doit être authentifiée par le runner et exploitable par la procédure contractuelle sans exposer le dataset. L’absence de preuve ne vaut pas consommation de la totalité du devis.

**Évolution éventuelle, non retenue pour le MVP :** rembourser intégralement et absorber les coûts avec une réserve limitée, alimentée par la marge déjà acquise, en bloquant les nouveaux jobs avant son épuisement. Noé souhaite seulement garder cette possibilité pour plus tard.

Les reprises doivent être idempotentes : aucun double prélèvement, double crédit ou double remboursement. Une perte de réponse après règlement doit permettre de retrouver le modèle sans facturer un nouvel entraînement.

## Estimer et fixer le prix

Construire une grille par profil à partir du nombre de lignes, du nombre de variables, des paramètres et de benchmarks sur la même classe de CVM. Couvrir aussi les coûts de préparation et de livraison, puis figer le prix dans le devis accepté.

```text
prix compute = max(tarif minimum prudent,
                   coût du job couvert par son budget
                   + contribution aux frais fixes
                   + marge de sécurité et marge commerciale)
```

Phala facture la machine pendant qu’elle est allumée, même sans entraînement, et le disque tant qu’il est conservé. Le dernier relevé consigné pour la CVM Sirius indiquait `0.058000` USD/h de calcul et `0.002780` USD/h de disque ; ces montants n’ont pas été revalidés pendant l’audit local du 23 septembre. Facturer uniquement les secondes actives d’un job ne couvre pas nécessairement les périodes d’inactivité. Vérifier la [tarification Phala](https://cloud.phala.com/about/pricing) avant activation.

Le minimum doit être calculé avec une hypothèse de fréquentation basse, puis appliqué à tous les emprunts. Les frais fixes déjà affectés aux jobs ne sont pas comptés une deuxième fois. Aucun volume minimal de clients n’est garanti : même un tarif élevé ne couvre pas une période sans vente. Aucun supplément rétroactif ne corrige cette période.

Le minimum facturé, les marges, la répartition des frais fixes et la convention USD/USDC restent à définir. Les `0,01 USDC` évoqués dans la conversation étaient un exemple d’affichage, pas un tarif validé. Aucun coefficient de performance Phala n’a encore été mesuré pour ce devis. La mesure du temps moyen ou du percentile 95 sert à fixer le prix ; elle ne remplace pas un plafond de dépense effectivement imposé.

## Admission financière et protection des fonds — intégration en cours

Le [registre runner local](RUNNER-BUDGETS.md) implémente les allocations atomiques, plafonds de gas, tentatives uniques, cache des résultats et coupe-circuit. Les devis v7 et la réservation du budget de clôture sont raccordés localement, sans garantir que la reprise puisse atteindre le règlement. Les exigences ci-dessous restent la cible complète : outre les défauts de l’audit, la comptabilité réconciliée, les coûts réels et les contrôles fournisseurs restent à raccorder.

### PnL et trésorerie

Suivre séparément les revenus Sirius définitivement acquis, les charges engagées même non encore facturées, les fonds dus aux clients/providers et la trésorerie réellement disponible dans chaque monnaie. Un dépôt remboursable en escrow, un prêt de trésorerie, un apport personnel ou des USDC testnet ne constituent pas un bénéfice. La marge du dataset appartient au provider et ne couvre pas les dépenses Sirius.

Avant toute nouvelle dépense, réserver atomiquement sa perte maximale dans le cas défavorable, y compris si le job échoue et doit être remboursé :

```text
marge disponible = revenus Sirius définitivement acquis
                 - charges déjà engagées
                 - coûts maximaux restant réservés aux opérations en cours
                 - réserve de frais fixes et d’arrêt
                 - coussin de sécurité

admission seulement si marge disponible >= nouvelle exposition maximale
```

Chaque coût figure une seule fois : quand une dépense devient engagée, elle remplace sa réservation. Une réservation ne disparaît pas simplement à l’expiration d’un verrou ou à la réception d’un timeout HTTP. Conserver les engagements incertains jusqu’à réconciliation. Le budget global cumulé ne se réinitialise pas chaque jour ; les plafonds quotidiens sont des restrictions supplémentaires.

Le contrôle doit aussi confirmer les liquidités nécessaires : recevoir des USDC ne paie pas automatiquement les factures Phala en USD ou le gas en ETH. Les taux de conversion, frais et variations doivent avoir une borne prudente ; une donnée de prix absente ou périmée bloque l’admission.

**Limite à expliciter avant activation :** sans revenu acquis initial, le mode strict peut refuser le premier job et le démarrage de l’infrastructure. Un apport finance cette dépense mais ne rend pas le PnL positif. Définir la période comptable et inclure les coûts déjà engagés dans son périmètre ; ne pas masquer une perte en la reclassant en réserve. Une garantie absolue contre toute panne, compromission ou dépense fournisseur non bornée ne peut pas être affirmée. Si une charge ne peut être bornée et couverte, ce mode doit refuser l’exploitation concernée.

### Budgets et arrêt

- Imposer des plafonds par job et globaux pour CPU, mémoire, durée réelle, entrées/sorties, stockage, appels payants, concurrence et gas. Le job v7 ajoute un délai global et un worker terminable. Un contrôle extérieur au processus parent et des bornes réelles fournisseur restent nécessaires.
- Réserver aussi les tentatives de règlement autorisées, le traitement d’un échec et la fermeture des opérations en cours. À l’approche du seuil, arrêter les admissions assez tôt pour conserver ce budget ; ne pas épuiser la réserve avant de pouvoir régler ou rembourser.
- Utiliser un coupe-circuit persistant sur les échecs répétés, les consommations anormales ou un coût incertain. Aucun redémarrage ne remet les compteurs à zéro. La reprise exige une réconciliation et un budget disponible.
- Couvrir les coûts avant paiement : challenges, devis, ingestion, RPC, API publiques, téléchargements et entraînements personnels. Leur éventuelle gratuité est soumise à un budget explicite ; elle ne permet pas de contourner les plafonds des emprunts.
- Ajouter des limites globales en plus des quotas par compte/IP. Le KYB ouvert de démonstration ne bloque pas un attaquant qui crée plusieurs wallets.
- Borner l’uptime et prévoir un superviseur d’infrastructure indépendant. Configurer des offres prépayées ou des plafonds fournisseur vérifiés, sans recharge ni dépassement automatiques. Une alerte seule ne bloque aucune facture. Les frais de stockage et les abonnements persistants restent à couvrir après l’arrêt du compute ; ne pas supprimer la CVM ni les modèles historiques sans décision explicite.

La [documentation Phala](https://cloud.phala.com/about/pricing) confirme que le disque reste facturé quand la machine est arrêtée. Le [contrôle de dépenses Vercel](https://vercel.com/docs/spend-management) peut suspendre les déploiements, mais avec plusieurs minutes de délai et sans couvrir tous les postes facturés. Ces mécanismes imposent une réserve d’arrêt et une vérification de leurs limites ; ils ne constituent pas un plafond global instantané de Sirius. Les autres fournisseurs et offres réellement utilisés restent à vérifier avant activation.

### Wallets, reprises et remboursement

- Séparer la trésorerie des revenus du compte opérationnel qui signe les règlements. Celui-ci ne porte qu’un montant de gas limité, sans accès à la trésorerie ni recharge automatique. Le faucet et le parrainage KYB ont des budgets distincts ; aucun faucet de fonds réels n’est introduit.
- Avant une signature, contrôler contrat, réseau, méthode, prêt, plafond de gas et coût total du rollup. Réserver ce coût durablement. La simulation est un contrôle complémentaire, pas une garantie d’absence de frais en cas de revert.
- Enregistrer l’intention, le nonce et la transaction de manière à permettre une reprise après crash. Une réponse RPC perdue ne justifie pas un nouvel envoi avec un nouveau nonce. Les remplacements éventuels partagent le budget et un nombre maximal de tentatives. Ne jamais recalculer ni refacturer un modèle déjà produit pour retrouver une réponse.
- Conserver les remboursements et crédits dans l’escrow, plafonnés aux sommes déposées et retirables une seule fois. Ne pas indemniser automatiquement depuis la trésorerie Sirius. Le borrower doit pouvoir réclamer son remboursement à échéance même si l’application ou le runner est arrêté.
- Implémenter la retenue de frais après démarrage dans les conditions signées et la machine d’états du contrat, avec preuve du travail facturable et traitement d’une panne avant persistance. Aucune retenue fondée sur une erreur déclarée par Next ou sur un démarrage non vérifiable. Le scénario de remboursement maximal reste réservé tant que le droit à retenir ces frais n’est pas établi.

Le prix minimum et ces plafonds répondent à deux problèmes différents : la rentabilité attendue et la limitation des pertes possibles. Leur présence dans cette spécification ne prouve ni leur implémentation ni l’impossibilité de vider un compte opérationnel en cas de compromission.

## Travail à reprendre

1. Corriger les bloqueurs de l’[audit](AUDIT-2026-09-23.md) : réconcilier une intention même après clôture du prêt, traiter la consommation d’un calcul réussi abandonné, refuser un devis absent en v7 et coordonner la suppression des clés enveloppées conservées dans le registre et ses copies. Ajouter les scénarios reproduits aux tests avant toute activation.
2. Calibrer le minimum commun, les prix par profil, le barème de durée active sans marge en échec et les coûts maximaux réservés. Choisir la trésorerie compute et justifier la marge déjà acquise ; aucune valeur de test ne vaut approbation.
3. Vérifier et imposer les plafonds des fournisseurs, la réserve de frais fixes/arrêt et un superviseur d’uptime indépendant. Raccorder la comptabilité réconciliée et préparer une procédure de reprise du registre sans remise à zéro. Ces limites déjà connues sont distinctes des défauts confirmés par l’audit.
4. Valider migration PostgreSQL, sauvegardes et parcours navigateur complet. Les **289 tests applicatifs, 78 tests contrats et le parcours EVM local** réussissaient, mais ne couvraient pas les trois scénarios de facturation des PoC supplémentaires. Les tests [locaux](BILLING-INTEGRATION.md#validation-locale-et-limites) ne prouvent donc pas encore la reprise et la facturation complètes.
5. Avant les benchmarks réels, annoncer à Noé quand Phala sera utilisé, pour combien de temps et à quel coût estimé. Calibrer ensuite la grille et vérifier l’identité de la même CVM.
6. Après correction des bloqueurs et validation de cette fonctionnalité, reprendre la sauvegarde, la préservation des 13 références de modèles historiques et la migration décrite dans [PHALA.md](PHALA.md). Préparer le déploiement de la version retenue avec facturation, puis la validation du parcours complet à deux wallets ; aucune de ces opérations distantes n’est effectuée par ce travail documentaire.

## Contraintes de reprise

- La CVM est **arrêtée à la demande de Noé** ; préparer le chantier localement. Ne pas la redémarrer pour coder ou tester localement, ni lancer un benchmark Phala sans l’avoir prévenu du moment et du budget.
- Aucun nouveau déploiement Solidity, changement de base distante ou activation de Phala n’a été effectué pour cette facturation.
- Les identités restent distinctes : le déployeur paie la création des contrats ; le compte EVM dérivé dans Phala autorise les prêts et paie le gas des règlements ; la trésorerie reçoit les revenus compute. L’adresse de trésorerie doit être choisie explicitement.
- Conserver le KYB ouvert pour la démonstration testnet actuelle. Le mode VPS reste une [spécification différée](RUNNER-MULTI-BACKEND.md).
- Conserver les accès privés et les historiques existants ; ne publier aucun secret dans ces documents. Aucune commande Git sans demande explicite de Noé.
