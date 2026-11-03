/**
 * Traductions de la page Train (slice N4) : états des emprunts, ré-entraînement, remboursement des
 * échecs et encart de contact. Fichier séparé, comme `shared-en.ts` et `marketplace-en.ts`, pour ne
 * pas entrer en conflit avec les autres slices ; il est fusionné dans `EN_MESSAGES`.
 * « Échoué », « Remboursé » et « État inconnu » existent déjà dans `shared-en.ts`.
 */
export const TRAIN_MESSAGES_EN: Record<string, string> = {
  // Lien vers la page publique du certificat (slice N6)
  "Certificat d’exécution": "Execution certificate",
  // États d'un emprunt (src/lib/train/loan-display.ts)
  "Paiement en attente de finalité": "Payment awaiting finality",
  "En cours": "In progress",
  "Terminé": "Completed",

  // Attente de finalité du lock avant « Lancer le job » (GET /api/loans/[id]/finality)
  "Finalité du paiement : ~{minutes} min": "Payment finality: ~{minutes} min",
  "Finalité imminente…": "Finality imminent…",
  "L’entraînement pourra démarrer dans ~{minutes} min — tu peux fermer cette page, ton paiement est en sécurité dans l’escrow.":
    "Training can start in ~{minutes} min — you can close this page, your payment is safe in escrow.",
  "Le réseau finalise ton paiement : l’entraînement pourra démarrer d’une minute à l’autre. Ton paiement est en sécurité dans l’escrow.":
    "The network is finalizing your payment: training can start any minute now. Your payment is safe in escrow.",
  "Si cette page reste ouverte, l’entraînement démarre automatiquement dès la finalité. Sinon, reviens lancer le job : inutile d’emprunter à nouveau.":
    "If this page stays open, training starts automatically once finality is reached. Otherwise, come back and run the job: no need to borrow again.",
  "Le réseau met plus de temps que prévu à finaliser ton paiement. Reviens plus tard lancer le job : ton paiement est en sécurité dans l’escrow.":
    "The network is taking longer than expected to finalize your payment. Come back later to run the job: your payment is safe in escrow.",
  // Palier rapide (petits prêts, src/lib/evm/fast-finality.ts) : l'attente se compte en secondes
  "Confirmation du paiement : ~{seconds} s": "Payment confirmation: ~{seconds} s",
  "Confirmation imminente…": "Confirmation imminent…",
  "L’entraînement pourra démarrer dans ~{seconds} s — ton paiement est en sécurité dans l’escrow.":
    "Training can start in ~{seconds} s — your payment is safe in escrow.",
  "Le réseau confirme ton paiement : l’entraînement pourra démarrer d’une seconde à l’autre. Ton paiement est en sécurité dans l’escrow.":
    "The network is confirming your payment: training can start any second now. Your payment is safe in escrow.",
  "Si cette page reste ouverte, l’entraînement démarre automatiquement dès la confirmation. Sinon, reviens lancer le job : inutile d’emprunter à nouveau.":
    "If this page stays open, training starts automatically once confirmed. Otherwise, come back and run the job: no need to borrow again.",

  // Confirmation avant un second emprunt du même dataset (marketplace et ré-entraînement)
  "Emprunt déjà en cours": "Loan already in progress",
  "Tu as déjà un emprunt payé sur ce dataset, en attente d’entraînement. Emprunter à nouveau te fait payer une seconde fois.":
    "You already have a paid loan on this dataset waiting to train. Borrowing again charges you again.",
  "Un entraînement est déjà en cours sur ce dataset pour ton emprunt précédent. Emprunter à nouveau te fait payer une seconde fois.":
    "Training is already in progress on this dataset for your previous loan. Borrowing again charges you again.",
  "Voir mes entraînements": "See my training runs",
  "Emprunter quand même": "Borrow anyway",

  // Self training réservé à l'équipe : encart de contact pour les autres comptes
  "Envie d’entraîner sur vos propres données ? Contactez-nous à": "Want to train on your own data? Contact us at",
  "Parcourir la marketplace": "Browse the marketplace",

  // Ré-entraînement = nouvel emprunt complet
  "Réentraîner": "Retrain",
  "Réentraîne uniquement si le dataset a changé.": "Retrain only if the dataset has changed.",
  "Un réentraînement est un nouvel emprunt complet : la donnée et le calcul sont payés à nouveau.":
    "A retrain is a new, full loan: you pay again for the data and the compute.",
  "Voir le devis et réentraîner": "View the quote and retrain",
  "Ce dataset n’est plus disponible à l’emprunt : le réentraînement est impossible.":
    "This dataset is no longer available to borrow: retraining is not possible.",

  // Remboursement, réservé aux échecs sans modèle utilisable
  "Rembourser": "Refund",
  "Le remboursement te rend tout ce que tu as payé, sauf, le cas échéant, le calcul réellement consommé et mesuré par l’enclave. Il est confirmé dans ton wallet ; les frais réseau ETH sont payés séparément.":
    "The refund returns everything you paid except, where applicable, the compute actually consumed, as measured by the enclave. You confirm it in your wallet; ETH network fees are paid separately.",
  "L’échéance est dépassée et le règlement ne peut plus être finalisé : le modèle reste inutilisable.":
    "The deadline has passed and the settlement can no longer be completed: the model remains unusable.",
  "Entraînement échoué : aucun modèle n’a été produit.": "Training failed: no model was produced.",

  // Modèle scellé dans le runner : prédictions signées seulement
  "Le calcul tourne dans un TEE — le modèle y reste scellé : tu obtiens des prédictions signées, jamais le modèle ni la donnée brute.":
    "Computing runs in a TEE — the model stays sealed there: you get signed predictions, never the model or the raw data.",
  "Modèle privé": "Private model",
  "Empreinte du modèle": "Model fingerprint",
  "Modèle indisponible : entraîné avant la prédiction privée.": "Model unavailable: trained before private prediction.",
  "Reçu runner manquant": "Runner receipt is missing",
  "Demander une prédiction": "Request a prediction",
  "Prédiction…": "Predicting…",
  "Valeur : {value} · appel n° {count}": "Value: {value} · call #{count}",
  "Prédiction refusée": "Prediction refused",

  // Location (D-29) : échéance et prolongation
  "Prolongation": "Extension",
  "Location expirée": "Rental expired",
  "Jours ajoutés": "Days added",
  "Durée de location": "Rental duration",
  "Durée louée": "Rented for",
  "1 jour": "1 day",
  "Accès jusqu’au": "Access until",
  "Accès terminé le": "Access ended on",
  "Accès aux prédictions jusqu’au {date}.": "Access to predictions until {date}.",
  "Prolongation réglée : les jours payés s’ajoutent à l’emprunt d’origine.": "Extension settled: the paid days are added to the original loan.",
  "Le délai de grâce est écoulé : le modèle a été supprimé de l’enclave et la location est close.":
    "The grace period is over: the model was deleted from the enclave and the rental is closed.",
  "Les prédictions sont arrêtées. Le modèle reste scellé {grace} jours après l’échéance : prolonge pour retrouver l’accès, sans réentraîner.":
    "Predictions are stopped. The model stays sealed for {grace} days after expiry: extend to get access back, without retraining.",
  "Prolonger": "Extend",
  "Jours à ajouter": "Days to add",
  "Prolongation…": "Extending…",
  "Voir le devis et prolonger": "See the quote and extend",
  "Chaque jour ajouté est payé au prix par jour du dataset, plus le calcul minimal d’un emprunt. Le total exact est affiché dans le devis, avant tout paiement.":
    "Each added day is paid at the dataset’s daily price, plus the minimum compute fee of a loan. The exact total is shown in the quote, before any payment.",
};
