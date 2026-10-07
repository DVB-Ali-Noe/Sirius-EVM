import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import { onboardingCopyKeys, STEP_COPY } from "./copy";
import {
  ONBOARDING_STEP_IDS,
  activeLoanSummary,
  deriveOnboardingProgress,
  gateDecision,
  isPaidLoan,
  parseChecklistDismissed,
  parseKybGate,
  shouldPromptVerification,
  showsChecklist,
  verificationMode,
  type OnboardingInput,
  type OnboardingLoan,
} from "./steps";

const ME = `0x${"ab".repeat(20)}`;
const ME_UPPER = `0x${"AB".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const TX = `0x${"22".repeat(32)}`;

function input(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return { kyb: "missing", gasWei: "0", stableAtomic: "0", loans: [], viewer: ME, ...overrides };
}

function loan(status: string, overrides: Partial<OnboardingLoan> = {}): OnboardingLoan {
  return { borrower: ME, status, evmLockTxHash: null, cancelTxHash: null, ...overrides };
}

function done(progress: ReturnType<typeof deriveOnboardingProgress>) {
  return Object.fromEntries(progress.steps.map((step) => [step.id, step.done]));
}

test("compte neuf : rien n'est fait, la première étape est la vérification", () => {
  const progress = deriveOnboardingProgress(input());
  assert.deepEqual(progress.steps.map((step) => step.id), [...ONBOARDING_STEP_IDS]);
  assert.equal(progress.current, "verify");
  assert.equal(progress.completed, 0);
  assert.equal(progress.total, 5);
  assert.deepEqual(progress.funding, { gas: true, token: true });
});

test("statut KYB inconnu ou pas encore lu : l'étape reste à faire", () => {
  assert.equal(deriveOnboardingProgress(input({ kyb: "unknown" })).current, "verify");
  assert.equal(deriveOnboardingProgress(input({ kyb: null })).current, "verify");
});

test("fonds : il faut à la fois de l'ETH pour le gas et le jeton pour emprunter", () => {
  const onlyGas = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1000" }));
  assert.equal(onlyGas.current, "fund");
  assert.deepEqual(onlyGas.funding, { gas: false, token: true });
  const onlyToken = deriveOnboardingProgress(input({ kyb: "valid", stableAtomic: "5" }));
  assert.equal(onlyToken.current, "fund");
  assert.deepEqual(onlyToken.funding, { gas: true, token: false });
  const both = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1000", stableAtomic: "5" }));
  assert.equal(both.current, "pick");
  // Solde illisible : jamais compté comme disponible.
  for (const unreadable of [null, "", "-1", "0x10", "abc"]) {
    assert.equal(deriveOnboardingProgress(input({ kyb: "valid", gasWei: unreadable, stableAtomic: "5" })).funding.gas, true);
  }
});

test("emprunt payé : les étapes amont sont validées même si le solde est retombé à zéro", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("ESCROWED", { evmLockTxHash: TX })] }));
  assert.deepEqual(done(progress), { verify: true, fund: true, pick: true, borrow: true, model: false });
  assert.equal(progress.current, "model");
});

test("un devis abandonné compte comme dataset choisi, pas comme emprunt", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1", stableAtomic: "1", loans: [loan("PENDING")] }));
  assert.deepEqual(done(progress), { verify: true, fund: true, pick: true, borrow: false, model: false });
  assert.equal(progress.current, "borrow");
});

test("modèle livré : tout est fait, la carte n'a plus d'étape courante", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED")] }));
  assert.equal(progress.current, null);
  assert.equal(progress.completed, 5);
});

test("seuls les prêts où le wallet est emprunteur comptent, quelle que soit la casse", () => {
  const asProvider = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED", { borrower: OTHER })] }));
  assert.equal(asProvider.current, "fund");
  const mixedCase = deriveOnboardingProgress(input({ kyb: "valid", viewer: ME_UPPER, loans: [loan("SETTLED")] }));
  assert.equal(mixedCase.current, null);
  const malformed = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED", { borrower: "pas une adresse" })] }));
  assert.equal(malformed.current, "fund");
  assert.equal(deriveOnboardingProgress(input({ kyb: "valid", viewer: null, loans: [loan("SETTLED")] })).current, "fund");
});

test("emprunt payé : lock envoyé, confirmé, réglé ou remboursé ; jamais un devis ou une annulation sans remboursement", () => {
  for (const status of ["SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED"]) assert.equal(isPaidLoan(loan(status)), true, status);
  assert.equal(isPaidLoan(loan("PENDING")), false);
  assert.equal(isPaidLoan(loan("PENDING", { evmLockTxHash: TX })), true);
  assert.equal(isPaidLoan(loan("CANCELLED")), false);
  assert.equal(isPaidLoan(loan("CANCELLED", { cancelTxHash: TX })), true);
  assert.equal(isPaidLoan(loan("INCONNU")), false);
});

test("affichage de la carte : préférence lue, non fermée, parcours inachevé — ou rouverte à la main", () => {
  assert.equal(showsChecklist({ dismissed: null, complete: false, reopened: false }), false);
  assert.equal(showsChecklist({ dismissed: true, complete: false, reopened: false }), false);
  assert.equal(showsChecklist({ dismissed: false, complete: false, reopened: false }), true);
  assert.equal(showsChecklist({ dismissed: false, complete: true, reopened: false }), false);
  assert.equal(showsChecklist({ dismissed: true, complete: true, reopened: true }), true);
});

test("fenêtre de vérification : invitation si l'accès instantané est coupé, explication du gas sans ETH", () => {
  assert.equal(verificationMode({ instantAccess: false, gasWei: "100" }), "invitation");
  assert.equal(verificationMode({ instantAccess: false, gasWei: "0" }), "invitation");
  assert.equal(verificationMode({ instantAccess: true, gasWei: "0" }), "needs-gas");
  assert.equal(verificationMode({ instantAccess: true, gasWei: "1" }), "instant");
  // Solde illisible : on laisse essayer, le wallet dira s'il manque de quoi payer.
  assert.equal(verificationMode({ instantAccess: true, gasWei: null }), "instant");
});

test("garde Emprunter / Publier : seul un « non vérifié » lu sur le registre ouvre la vérification", () => {
  assert.equal(gateDecision("missing"), "verify");
  assert.equal(gateDecision("valid"), "proceed");
  assert.equal(gateDecision("unknown"), "proceed");
  assert.equal(gateDecision(null), "proceed");
});

test("proposition après connexion : une fois, jamais par-dessus une autre fenêtre ou un tuto à venir", () => {
  const base = { authenticated: true, kyb: "missing" as const, instantAccess: true, shownThisSession: false, overlayOpen: false, tourPending: false };
  assert.equal(shouldPromptVerification(base), true);
  assert.equal(shouldPromptVerification({ ...base, authenticated: false }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: "valid" }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: "unknown" }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: null }), false);
  assert.equal(shouldPromptVerification({ ...base, instantAccess: false }), false);
  assert.equal(shouldPromptVerification({ ...base, shownThisSession: true }), false);
  assert.equal(shouldPromptVerification({ ...base, overlayOpen: true }), false);
  assert.equal(shouldPromptVerification({ ...base, tourPending: true }), false);
});

test("statut KYB : seule une réponse bien formée donne « vérifié » ou « non vérifié »", () => {
  assert.deepEqual(parseKybGate({ valid: true, revoked: false, expiresAt: 1, instantAccess: true }), { kyb: "valid", instantAccess: true });
  assert.deepEqual(parseKybGate({ valid: false, revoked: false, expiresAt: null }), { kyb: "missing", instantAccess: false });
  assert.deepEqual(parseKybGate({ valid: false, revoked: true, expiresAt: 1 }), { kyb: "missing", instantAccess: false });
  // Incohérent (valide et révoqué) ou mal formé : inconnu, rien n'est bloqué.
  assert.equal(parseKybGate({ valid: true, revoked: true }).kyb, "unknown");
  for (const body of [null, undefined, [], "x", {}, { known: true }, { valid: "true", revoked: false }]) {
    assert.equal(parseKybGate(body).kyb, "unknown");
  }
  assert.equal(parseKybGate({ valid: false, revoked: false, instantAccess: "true" }).instantAccess, false);
});

test("préférence de la carte : lue seulement dans le profil du wallet attendu", () => {
  assert.equal(parseChecklistDismissed({ address: ME, settings: { onboardingDismissed: true } }, ME_UPPER), true);
  assert.equal(parseChecklistDismissed({ address: ME, settings: {} }, ME), false);
  assert.equal(parseChecklistDismissed({ address: ME, settings: { onboardingDismissed: "true" } }, ME), false);
  assert.equal(parseChecklistDismissed({ address: OTHER, settings: { onboardingDismissed: false } }, ME), null);
  for (const body of [null, [], {}, { address: ME }, { address: ME, settings: null }]) {
    assert.equal(parseChecklistDismissed(body, ME), null);
  }
});

test("indicateur global : prêts actifs de l'emprunteur et phase la plus avancée", () => {
  assert.equal(activeLoanSummary(null, ME), null);
  assert.equal(activeLoanSummary([loan("PENDING"), loan("SETTLED"), loan("CANCELLED"), loan("SUBMITTING")], ME), null);
  assert.deepEqual(activeLoanSummary([loan("ESCROWED")], ME), { count: 1, phase: "payment" });
  assert.deepEqual(activeLoanSummary([loan("ESCROWED"), loan("TRAINING")], ME), { count: 2, phase: "training" });
  assert.deepEqual(activeLoanSummary([loan("SETTLING"), loan("ESCROWED")], ME), { count: 2, phase: "settling" });
  assert.deepEqual(activeLoanSummary([loan("TRAINING", { refundable: true }), loan("SETTLING")], ME), { count: 2, phase: "attention" });
  // Prêts où l'on est fournisseur : jamais affichés.
  assert.equal(activeLoanSummary([loan("TRAINING", { borrower: OTHER })], ME), null);
  assert.equal(activeLoanSummary([loan("TRAINING")], null), null);
});

test("tous les textes du parcours ont une traduction anglaise sans « USDC » écrit en dur", () => {
  for (const key of onboardingCopyKeys()) {
    assert.ok(Object.hasOwn(EN_MESSAGES, key), key);
    assert.doesNotMatch(EN_MESSAGES[key], /USDC/, key);
  }
  assert.match(EN_MESSAGES[STEP_COPY.fund.title], /\{token\}/);
});
