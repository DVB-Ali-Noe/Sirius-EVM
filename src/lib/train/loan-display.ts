import { addressesEqual } from "@/lib/evm/address";

/**
 * Logique d'affichage de la page Train pour les emprunts (docs/passage-mainnet/09-train-et-certificat.md,
 * « Avant le 6 »). Fonctions pures : aucune décision d'argent ne se prend ici. Le serveur reste
 * l'autorité (`POST /api/loans/[id]/cancel` vérifie l'emprunteur, l'échéance et l'état on-chain) ;
 * ces règles ne décident que de ce que l'interface propose, et penchent toujours vers « ne rien
 * proposer » en cas de doute.
 */

export type LoanStatus = "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";

/** Champs de la réponse `GET /api/loans` utiles à l'affichage. */
export interface LoanDisplayInput {
  id: string;
  datasetId: string;
  /** Adresse de l'emprunteur. `GET /api/loans` renvoie aussi les prêts où l'on est fournisseur. */
  borrower?: string | null;
  status: string;
  evmLockTxHash?: string | null;
  evmLoanKey?: string | null;
  settleTxHash?: string | null;
  cancelTxHash?: string | null;
  modelCid?: string | null;
  runnerReceipt?: string | null;
  /** Calculé par le serveur : prêt actif dont l'échéance est dépassée. */
  refundable?: boolean;
}

export const LOAN_DISPLAY_STATES = [
  "awaiting-finality",
  "in-progress",
  "completed",
  "failed",
  "refunded",
  "unknown",
] as const;

export type LoanDisplayState = (typeof LOAN_DISPLAY_STATES)[number];

/** Statuts pendant lesquels des fonds sont engagés et le prêt n'est pas terminé. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"]);

/** Statuts où l'escrow est verrouillé on-chain et peut être remboursé après l'échéance. */
const ESCROWED_STATUSES: ReadonlySet<string> = new Set(["ESCROWED", "TRAINING", "SETTLING"]);

function addressesEqualSafe(left: string, right: string): boolean {
  try {
    return addressesEqual(left, right);
  } catch {
    return false;
  }
}

function isBorrower(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    typeof loan.borrower === "string" &&
    typeof viewer === "string" &&
    viewer !== "" &&
    addressesEqualSafe(loan.borrower, viewer)
  );
}

/**
 * Échec sans modèle livré : escrow verrouillé, échéance dépassée selon le serveur, et aucune trace
 * de modèle ni de règlement (`modelCid` : capsule préparée que le règlement peut encore livrer ;
 * `settleTxHash` : release soumis, la clé peut déjà être livrable ; `cancelTxHash` : déjà remboursé).
 */
export function isFailedWithoutModel(loan: LoanDisplayInput): boolean {
  return (
    ESCROWED_STATUSES.has(loan.status) &&
    loan.refundable === true &&
    !loan.modelCid &&
    !loan.settleTxHash &&
    !loan.cancelTxHash &&
    Boolean(loan.evmLoanKey)
  );
}

/**
 * Échu avec une capsule de modèle mais sans reçu enclave : « Finaliser le règlement » exige le
 * reçu, aucune action de règlement n'est possible et le réaper ne fait que resynchroniser la base
 * avec la chaîne (jamais de remboursement ni de règlement). Sans secours, les fonds resteraient
 * bloqués : le remboursement est donc proposé, même si `modelCid` est posé. Aucun modèle n'a été
 * livré (`settleTxHash` vide, clé jamais libérée).
 */
export function isOverdueWithoutReceipt(loan: LoanDisplayInput): boolean {
  return (
    ESCROWED_STATUSES.has(loan.status) &&
    loan.refundable === true &&
    Boolean(loan.modelCid) &&
    !loan.runnerReceipt &&
    !loan.settleTxHash &&
    !loan.cancelTxHash &&
    Boolean(loan.evmLoanKey)
  );
}

/**
 * État lisible d'un emprunt.
 *  - `awaiting-finality` : paiement envoyé mais pas finalisé (verrouillage SUBMITTING, ou PENDING avec
 *    un hash de lock, ou règlement SETTLING en cours de confirmation) ;
 *  - `in-progress` : emprunt en préparation (PENDING sans paiement envoyé : devis refusé ou approbation
 *    en cours), ou fonds verrouillés, entraînement à lancer ou en cours ;
 *  - `completed` : règlement validé, modèle livrable ;
 *  - `failed` : abandonné avant le verrouillage (CANCELLED sans remboursement), ou échéance dépassée
 *    sans modèle ;
 *  - `refunded` : remboursement confirmé on-chain.
 */
export function loanDisplayState(loan: LoanDisplayInput): LoanDisplayState {
  switch (loan.status) {
    case "SETTLED":
      return "completed";
    case "CANCELLED":
      return loan.cancelTxHash ? "refunded" : "failed";
    case "PENDING":
      // `borrowDataset` crée le prêt avant le devis : sans hash de lock, rien n'a été payé.
      return loan.evmLockTxHash ? "awaiting-finality" : "in-progress";
    case "SUBMITTING":
      return "awaiting-finality";
    case "ESCROWED":
    case "TRAINING":
    case "SETTLING":
      if (isFailedWithoutModel(loan) || isOverdueWithoutReceipt(loan)) return "failed";
      return loan.status === "SETTLING" ? "awaiting-finality" : "in-progress";
    default:
      return "unknown";
  }
}

/**
 * « Ré-entraîner » : seulement sur un emprunt terminé et réglé, par son emprunteur. Un fournisseur
 * qui voit le prêt de quelqu'un d'autre ne l'obtient pas ; un prêt remboursé ou échoué non plus.
 */
export function canRetrain(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    loan.status === "SETTLED" &&
    Boolean(loan.settleTxHash) &&
    !loan.cancelTxHash &&
    Boolean(loan.datasetId) &&
    isBorrower(loan, viewer)
  );
}

/**
 * « Rembourser » : échec sans modèle livré, ou prêt échu dont la capsule ne peut plus être réglée
 * (sans reçu), par son emprunteur. Jamais sur un emprunt réglé, déjà remboursé, avec un règlement
 * encore possible (capsule et reçu) ou encore dans son délai.
 */
export function canRefund(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (isFailedWithoutModel(loan) || isOverdueWithoutReceipt(loan)) && isBorrower(loan, viewer);
}

/** Remboursement de secours (échu, capsule sans reçu) : sert à choisir l'explication affichée. */
export function canRescueRefund(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return isOverdueWithoutReceipt(loan) && isBorrower(loan, viewer);
}

/** Un autre emprunt actif du même emprunteur sur ce dataset (confirmation avant d'en ouvrir un nouveau). */
export function hasOtherActiveLoan(
  loans: readonly LoanDisplayInput[],
  loan: LoanDisplayInput,
  viewer: string | null | undefined,
): boolean {
  return loans.some(
    (other) =>
      other.id !== loan.id &&
      other.datasetId === loan.datasetId &&
      ACTIVE_STATUSES.has(other.status) &&
      // Un prêt PENDING sans lock est un devis refusé ou abandonné, pas un emprunt en cours.
      (other.status !== "PENDING" || Boolean(other.evmLockTxHash)) &&
      isBorrower(other, viewer),
  );
}

/** Clé de traduction du libellé d'un état (phrases françaises, voir `train-en.ts`). */
export const LOAN_STATE_LABEL_KEY: Readonly<Record<LoanDisplayState, string>> = {
  "awaiting-finality": "Paiement en attente de finalité",
  "in-progress": "En cours",
  completed: "Terminé",
  failed: "Échoué",
  refunded: "Remboursé",
  unknown: "État inconnu",
};

export type LoanStateVariant = "default" | "accent" | "positive" | "negative" | "muted" | "warning";

export const LOAN_STATE_VARIANT: Readonly<Record<LoanDisplayState, LoanStateVariant>> = {
  "awaiting-finality": "warning",
  "in-progress": "accent",
  completed: "positive",
  failed: "negative",
  refunded: "default",
  unknown: "muted",
};

/** Le self training n'est affiché qu'à un administrateur confirmé : toute autre valeur le masque. */
export function parseAdminResponse(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { admin?: unknown }).admin === true;
}
