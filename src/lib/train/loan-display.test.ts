import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import {
  LOAN_DISPLAY_STATES,
  LOAN_STATE_LABEL_KEY,
  LOAN_STATE_VARIANT,
  canRefund,
  canRetrain,
  hasOtherActiveLoan,
  isFailedWithoutModel,
  loanDisplayState,
  parseAdminResponse,
  type LoanDisplayInput,
} from "./loan-display";

const ME = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const KEY = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

function loan(overrides: Partial<LoanDisplayInput> = {}): LoanDisplayInput {
  return {
    id: "loan-1",
    datasetId: "dataset-1",
    borrower: ME,
    status: "ESCROWED",
    evmLockTxHash: TX,
    evmLoanKey: KEY,
    settleTxHash: null,
    cancelTxHash: null,
    modelCid: null,
    refundable: false,
    ...overrides,
  };
}

const failed = () => loan({ refundable: true });
const completed = () => loan({ status: "SETTLED", settleTxHash: TX, modelCid: "bafy" });

test("états lisibles : un état par statut de prêt", () => {
  assert.equal(loanDisplayState(loan({ status: "PENDING" })), "awaiting-finality");
  // Prêt créé avant le devis, rien n'a été payé : jamais présenté comme un paiement envoyé.
  assert.equal(loanDisplayState(loan({ status: "PENDING", evmLockTxHash: null, evmLoanKey: null })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "SUBMITTING" })), "awaiting-finality");
  assert.equal(loanDisplayState(loan({ status: "ESCROWED" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "TRAINING" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "TRAINING", modelCid: "bafy" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "SETTLING", modelCid: "bafy", settleTxHash: TX })), "awaiting-finality");
  assert.equal(loanDisplayState(completed()), "completed");
  assert.equal(loanDisplayState(loan({ status: "CANCELLED", cancelTxHash: TX })), "refunded");
  assert.equal(loanDisplayState(loan({ status: "CANCELLED" })), "failed");
  assert.equal(loanDisplayState(failed()), "failed");
  assert.equal(loanDisplayState(loan({ status: "TRAINING", refundable: true })), "failed");
});

test("un statut inconnu ou absent n'est jamais présenté comme réussi ni échoué", () => {
  assert.equal(loanDisplayState(loan({ status: "BIZARRE" })), "unknown");
  assert.equal(loanDisplayState(loan({ status: "" })), "unknown");
  assert.equal(loanDisplayState(loan({ status: undefined as unknown as string })), "unknown");
  assert.equal(loanDisplayState(loan({ status: "settled" })), "unknown");
});

test("chaque état a un libellé et une variante", () => {
  for (const state of LOAN_DISPLAY_STATES) {
    assert.ok(LOAN_STATE_LABEL_KEY[state], state);
    assert.ok(LOAN_STATE_VARIANT[state], state);
  }
  assert.deepEqual(
    Object.values(LOAN_STATE_LABEL_KEY).filter((key) => key !== "État inconnu"),
    ["Paiement en attente de finalité", "En cours", "Terminé", "Échoué", "Remboursé"],
  );
});

test("Rembourser : proposé pour un échec sans modèle, à l'emprunteur seulement", () => {
  assert.equal(canRefund(failed(), ME), true);
  assert.equal(canRefund(failed(), ME.toUpperCase().replace("0X", "0x")), true);
  assert.equal(canRefund(loan({ status: "TRAINING", refundable: true }), ME), true);
  assert.equal(canRefund(loan({ status: "SETTLING", refundable: true }), ME), true);
});

test("Rembourser : jamais proposé à un tiers, au fournisseur ou sans wallet", () => {
  assert.equal(canRefund(failed(), OTHER), false);
  assert.equal(canRefund(failed(), null), false);
  assert.equal(canRefund(failed(), undefined), false);
  assert.equal(canRefund(failed(), ""), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: undefined }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: null }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: "pas-une-adresse" }), "pas-une-adresse"), false);
});

test("Rembourser : jamais avant l'échéance, jamais si le serveur ne le dit pas", () => {
  assert.equal(canRefund(loan({ refundable: false }), ME), false);
  assert.equal(canRefund(loan({ refundable: undefined }), ME), false);
  assert.equal(canRefund({ ...failed(), refundable: "true" as unknown as boolean }, ME), false);
  assert.equal(canRefund({ ...failed(), refundable: 1 as unknown as boolean }, ME), false);
});

test("Rembourser : jamais si un modèle est livrable ou livré", () => {
  assert.equal(canRefund(loan({ refundable: true, modelCid: "bafy" }), ME), false);
  assert.equal(canRefund(loan({ status: "SETTLING", refundable: true, settleTxHash: TX }), ME), false);
  assert.equal(canRefund({ ...completed(), refundable: true }, ME), false);
  assert.equal(canRefund(completed(), ME), false);
});

test("Rembourser : jamais sur un emprunt déjà remboursé, abandonné ou pas encore verrouillé", () => {
  assert.equal(canRefund(loan({ status: "CANCELLED", cancelTxHash: TX, refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "CANCELLED", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "PENDING", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "SUBMITTING", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "INCONNU", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, evmLoanKey: null }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, cancelTxHash: TX }), ME), false);
});

test("Rembourser et état échoué restent cohérents", () => {
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED", "CANCELLED", "X"]) {
    for (const refundable of [true, false]) {
      for (const modelCid of [null, "bafy"]) {
        for (const settleTxHash of [null, TX]) {
          for (const cancelTxHash of [null, TX]) {
            const candidate = loan({ status, refundable, modelCid, settleTxHash, cancelTxHash });
            if (canRefund(candidate, ME)) {
              assert.equal(loanDisplayState(candidate), "failed");
              assert.equal(isFailedWithoutModel(candidate), true);
              assert.equal(candidate.modelCid, null);
              assert.equal(candidate.settleTxHash, null);
              assert.equal(candidate.cancelTxHash, null);
              assert.ok(["ESCROWED", "TRAINING", "SETTLING"].includes(status));
              assert.equal(refundable, true);
            }
          }
        }
      }
    }
  }
});

test("Ré-entraîner : proposé sur un emprunt terminé et réglé, à son emprunteur", () => {
  assert.equal(canRetrain(completed(), ME), true);
  assert.equal(canRetrain(completed(), ME.toUpperCase().replace("0X", "0x")), true);
});

test("Ré-entraîner : jamais sur un autre état, un tiers ou le fournisseur", () => {
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "CANCELLED", "X"]) {
    assert.equal(canRetrain(loan({ status, settleTxHash: TX, modelCid: "bafy" }), ME), false, status);
  }
  assert.equal(canRetrain(failed(), ME), false);
  assert.equal(canRetrain(loan({ status: "CANCELLED", cancelTxHash: TX }), ME), false);
  assert.equal(canRetrain(completed(), OTHER), false);
  assert.equal(canRetrain(completed(), null), false);
  assert.equal(canRetrain({ ...completed(), borrower: undefined }, ME), false);
  assert.equal(canRetrain({ ...completed(), settleTxHash: null }, ME), false);
  assert.equal(canRetrain({ ...completed(), cancelTxHash: TX }, ME), false);
  assert.equal(canRetrain({ ...completed(), datasetId: "" }, ME), false);
});

test("un emprunt actif du même emprunteur sur le même dataset est détecté", () => {
  const current = completed();
  assert.equal(hasOtherActiveLoan([current], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "TRAINING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "PENDING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "PENDING", evmLockTxHash: null })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "SUBMITTING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "SETTLED" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "CANCELLED" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", datasetId: "dataset-2" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", borrower: OTHER })], current, ME), false);
});

test("chaque libellé d'état est traduit en anglais", () => {
  const english = new Map<string, string>([
    ["Paiement en attente de finalité", "Payment awaiting finality"],
    ["En cours", "In progress"],
    ["Terminé", "Completed"],
    ["Échoué", "Failed"],
    ["Remboursé", "Refunded"],
    ["État inconnu", "Unknown status"],
  ]);
  for (const key of Object.values(LOAN_STATE_LABEL_KEY)) assert.equal(EN_MESSAGES[key], english.get(key), key);
});

test("le self training n'est montré que si le serveur répond exactement admin: true", () => {
  assert.equal(parseAdminResponse({ admin: true }), true);
  for (const body of [{ admin: false }, {}, null, undefined, "true", 1, [], { admin: "true" }, { admin: 1 }, { error: "x" }]) {
    assert.equal(parseAdminResponse(body), false);
  }
});
