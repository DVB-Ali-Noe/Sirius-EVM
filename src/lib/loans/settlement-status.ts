/**
 * Message partagé entre la route de règlement et l'interface : la transaction est partie,
 * le réseau ne l'a pas encore finalisée. Sur mainnet, compter de quinze à trente minutes.
 */
export const SETTLEMENT_FINALITY_PENDING = "Règlement envoyé : le réseau le confirme en général sous 15 à 30 minutes. Reviens ensuite pour récupérer ton modèle.";
