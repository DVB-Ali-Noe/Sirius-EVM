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

  // Remboursement, réservé aux échecs sans modèle livré
  "Rembourser": "Refund",
  "L’échéance est dépassée et le règlement ne peut plus être finalisé : aucun modèle n’a été livré.":
    "The deadline has passed and the settlement can no longer be completed: no model was delivered.",
  "Entraînement échoué : aucun modèle n’a été livré.": "Training failed: no model was delivered.",
  "Le remboursement te rend tout ce que tu as payé, sauf, le cas échéant, le calcul réellement consommé et mesuré par l’enclave. Il est confirmé dans ton wallet ; les frais réseau ETH sont payés séparément.":
    "The refund returns everything you paid except, where applicable, the compute actually consumed, as measured by the enclave. You confirm it in your wallet; ETH network fees are paid separately.",
};
