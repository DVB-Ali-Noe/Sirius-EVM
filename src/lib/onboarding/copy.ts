import type { ActiveLoanPhase, OnboardingStepId } from "./steps";

/**
 * Textes du parcours d'accueil rangés hors des composants, pour que le test de traduction
 * vérifie chacune de ces clés (le test global ne voit que les littéraux passés à `t()`).
 * `{token}` est le jeton de règlement du réseau (`stablecoinSymbol`), jamais écrit en dur.
 */

/** Titre et explication de chaque étape de la carte « Get started ». */
export const STEP_COPY: Record<OnboardingStepId, { title: string; body: string }> = {
  verify: { title: "Vérifie ton wallet", body: "Obligatoire pour prêter et emprunter sur mainnet. Une seule transaction à confirmer." },
  fund: { title: "Ajoute de l’ETH et des {token}", body: "L’ETH paie le gas de chaque transaction ; les {token} paient l’emprunt." },
  pick: { title: "Choisis un dataset", body: "Parcours la marketplace et ouvre la fiche d’un dataset." },
  borrow: { title: "Emprunte-le", body: "Sur la fiche, clique sur Emprunter : le prix du dataset et le compute sont bloqués en escrow." },
  model: { title: "Récupère ton modèle", body: "L’entraînement tourne dans une enclave TEE ; ton modèle t’attend sur la page Entraîner." },
};

/** Phrase d'introduction de la fenêtre de vérification, selon l'action qui l'a ouverte. */
export const VERIFICATION_INTRO = {
  prompt: "Avant de prêter ou d’emprunter un dataset sur mainnet, ton wallet doit être vérifié (KYB). Ça prend une seule transaction.",
  checklist: "Avant de prêter ou d’emprunter un dataset sur mainnet, ton wallet doit être vérifié (KYB). Ça prend une seule transaction.",
  borrow: "Pour emprunter ce dataset, ton wallet doit d’abord être vérifié (KYB). Une fois fait, l’emprunt reprend tout seul.",
  publish: "Pour publier un dataset, ton wallet doit d’abord être vérifié (KYB). Une fois fait, la publication reprend toute seule.",
} as const;

/** Les trois temps d'un emprunt dans l'indicateur global, dans l'ordre. */
export const LOAN_PHASES = [
  { id: "payment", label: "paiement en cours de finalisation" },
  { id: "training", label: "entraînement" },
  { id: "settling", label: "terminé" },
] as const;

/** Rang de la phase mise en avant ; un prêt échu reste au milieu, avec son propre message. */
export const LOAN_PHASE_INDEX: Record<ActiveLoanPhase, number> = { payment: 0, training: 1, settling: 2, attention: 1 };

/** Toutes les clés ci-dessus, pour le test de traduction. */
export function onboardingCopyKeys(): string[] {
  return [
    ...Object.values(STEP_COPY).flatMap((copy) => [copy.title, copy.body]),
    ...Object.values(VERIFICATION_INTRO),
    ...LOAN_PHASES.map((phase) => phase.label),
  ];
}
