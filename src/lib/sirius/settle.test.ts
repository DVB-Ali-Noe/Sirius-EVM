import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "@/lib/app-error";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { isRecordedQuoteHardwareValid } from "@/lib/tee/quote";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "settle.ts"), "utf8");

test("une release EVM réconciliée devient SETTLED après une réponse runner perdue", () => {
  const recovery = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(recovery, /resolution\?\.state === "settled"[\s\S]*?status: "SETTLED"[\s\S]*?settleTxHash: resolution\.txHash/);
});

test("le résultat runner est attesté avant sa persistance", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.match(preparation, /await verifyLoanAttestation\(/);
  assert.match(preparation, /attestationPayload: result\.attestation\.payload/);
  assert.match(preparation, /attestationQuote: result\.attestation\.evidence\?\.quote \?\? null/);
  assert.match(preparation, /auditReceipt: result\.attestation\.signature/);
});

test("le règlement refuse un résultat sans preuve d’attestation", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /!loan\.attestationHash/);
  assert.match(settlement, /!loan\.attestationPayload/);
  assert.match(settlement, /TEE_MODE === "phala"/);
});

test("le règlement reprend avec le hash attesté, pas une capsule navigateur", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /payload\.releaseEnvelopeHash/);
  assert.doesNotMatch(settlement, /releaseEnvelopeHash: string/);
});

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("un règlement en attente de finalité reste SETTLING avec son hash, sans réconciliation ni retour arrière", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));
  const pending = settlement.slice(settlement.indexOf("if (error instanceof RunnerFinalityPending)"));

  assert.match(pending, /^if \(error instanceof RunnerFinalityPending\) \{[\s\S]*?status: "SETTLING"[\s\S]*?settleTxHash: error\.transactionHash[\s\S]*?throw error;\s*\}/);
  assert.ok(settlement.indexOf("RunnerFinalityPending") < settlement.indexOf("reconcileLoanEscrow"), "l’attente passe avant toute réconciliation");
});

test("l’entraînement n’est demandé au runner qu’après finalité du lock", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.ok(preparation.indexOf("assertBlockStable") < preparation.indexOf('status: "TRAINING"'), "garde avant la prise du lease");
  assert.ok(preparation.indexOf("assertBlockStable") < preparation.indexOf("runLoanJobInRunner("));
});

test("l’attente de finalité traverse le runner distant comme en processus", () => {
  const server = read("src", "runner", "server.ts");
  const client = read("src", "lib", "tee", "runner-client.ts");
  const route = read("src", "app", "api", "loans", "[id]", "settle", "route.ts");

  assert.match(server, /err instanceof RunnerFinalityPending[\s\S]*?send\(202, \{ state: "pending-finality", transactionHash: err\.transactionHash/);
  assert.match(client, /response\.status === 202 && body\.state === "pending-finality"[\s\S]*?throw new RunnerFinalityPending/);
  assert.match(client, /!response\.ok \|\| response\.status !== 200/, "aucune autre réponse 2xx n’est prise pour un succès");
  assert.match(route, /err instanceof RunnerFinalityPending[\s\S]*?pending: true[\s\S]*?status: 202/);
});

// --- Règlement devenu impossible après l'échéance (audit A-05) : exécution réelle de
// `settlePreparedLoan` avec ses dépendances remplacées, comme dans runner-provenance.test.ts.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(process.cwd(), file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, console, process, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const KEY = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;
const OTHER_TX = `0x${"23".repeat(32)}`;
const ESCROW = `0x${"33".repeat(20)}`;
const savedTeeMode = process.env.TEE_MODE;
beforeEach(() => { process.env.TEE_MODE = "development"; });
afterEach(() => {
  if (savedTeeMode === undefined) delete process.env.TEE_MODE;
  else process.env.TEE_MODE = savedTeeMode;
});

type Resolution = { state: "active" } | { state: "settled"; txHash: string };

function settlementFixture(
  evmDeadline: Date | undefined,
  runner: () => Promise<never>,
  resolution: Resolution = { state: "active" },
  quote: Record<string, unknown> = {},
) {
  const loan = {
    id: "loan", datasetId: "dataset", borrower: `0x${"44".repeat(20)}`, provider: `0x${"55".repeat(20)}`,
    status: "TRAINING", amountUsdcAtomic: "100", modelId: "linear_regression", modelVersion: "1.0.0",
    modelCid: "bafyModel", runnerReceipt: "receipt", evmLoanKey: KEY, evmLockBlock: "10", evmDeadline,
    settleTxHash: TX, billingQuoteHash: `0x${"66".repeat(32)}`, attestationHash: "attestation-hash",
    attestationPayload: "attestation-payload", updatedAt: new Date(0), runnerKind: "PHALA", runnerDeploymentId: "phala:runner",
    attestationQuote: "aa", attestationEventLog: "[]", attestationComposeHash: "88".repeat(32),
    dataset: { ipfsCid: "bafyDataset", merkleRoot: "77".repeat(32), challengeDays: 7 },
  };
  const payload = {
    chainId: 46630, escrow: ESCROW, loanId: loan.id, loanKey: KEY, datasetId: loan.datasetId, datasetCid: loan.dataset.ipfsCid,
    provider: loan.provider, borrower: loan.borrower, amountUsdcAtomic: loan.amountUsdcAtomic, billingQuoteHash: loan.billingQuoteHash,
    challengeDays: 7, merkleRoot: loan.dataset.merkleRoot, modelId: loan.modelId, modelVersion: loan.modelVersion,
    modelCid: loan.modelCid, releaseEnvelopeHash: "envelope-hash",
  };
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const api = load<typeof import("./settle")>("src/lib/sirius/settle.ts", {
    "server-only": {}, "@/lib/errors": { AppError },
    "@/lib/runner/provenance": { assertCurrentRunner: async () => ({}) },
    "@/lib/db": { prisma: { loan: {
      findUnique: async () => loan,
      updateMany: async (args: (typeof updates)[number]) => { updates.push(args); return { count: 1 }; },
    } } },
    "@/lib/evm/escrow": { reconcileLoanEscrow: async () => resolution },
    "@/lib/evm/client": {}, "@/lib/evm/finality": {},
    "@/lib/runner/failure-policy": { RunnerFinalityPending },
    "@/lib/tee/runner-client": { settleLoanInRunner: runner },
    "./model-storage": {}, "@/lib/models/registry": {}, "@/lib/runner/delivery": {},
    "@/lib/tee/attestation": {
      hashLoanAttestationPayload: () => loan.attestationHash,
      parseLoanAttestationPayload: () => payload,
      serializeLoanAttestationPayload: () => "",
    },
    "@/lib/tee/quote": quote,
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: 46630, escrow: ESCROW }) },
    "@/lib/billing/loan": { loanBillingQuote: () => ({ quote: {} }) },
    "@/lib/loans/settlement-status": { LOCK_FINALITY_PENDING: "attente" },
  });
  return { api, updates };
}

const overdue = () => new Date(Date.now() - 60_000);
const inTime = () => new Date(Date.now() + 60_000);
const rejected = (message: string, status: number) => async () => { throw new AppError(message, status); };

test("A-05 : release rejetée après l'échéance, escrow encore verrouillé : le hash mort est effacé et le prêt redevient remboursable", async () => {
  // Le runner a diffusé un release avant l'échéance (hash persisté en attente de finalité), puis la
  // transaction a été rejetée : « Règlement on-chain rejeté » à la confirmation, « Tentative de
  // règlement épuisée » à chaque reprise. Après l'échéance, le contrat refuse tout nouveau release.
  for (const [message, status] of [["Règlement on-chain rejeté : aucune relance automatique", 502], ["Tentative de règlement épuisée", 503]] as const) {
    const { api, updates } = settlementFixture(overdue(), rejected(message, status));
    await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) => error instanceof AppError && error.message === message && error.status === status);
    assert.equal(updates.length, 2, message);
    assert.equal(updates[0].data.status, "SETTLING");
    assert.equal(updates[1].where.status, "SETTLING");
    // Sans hash, `isOverdueUnsettled` propose « Rembourser », masque « Finaliser » et le reaper ne relance plus.
    assert.deepEqual({ ...updates[1].data }, { status: "TRAINING", settleTxHash: null });
  }
});

test("avant l'échéance, ou sans échéance connue, un release rejeté garde son hash : aucun remboursement n'est encore possible", async () => {
  for (const evmDeadline of [inTime(), undefined]) {
    const { api, updates } = settlementFixture(evmDeadline, rejected("Tentative de règlement épuisée", 503));
    await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
    assert.deepEqual({ ...updates[1].data }, { status: "TRAINING" }, String(evmDeadline));
  }
});

test("échu mais en attente de finalité : le hash du release diffusé est conservé, jamais de remboursement", async () => {
  const { api, updates } = settlementFixture(overdue(), async () => { throw new RunnerFinalityPending(OTHER_TX); });
  await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) => error instanceof RunnerFinalityPending);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].data.settleTxHash, OTHER_TX);
  assert.equal(updates[1].data.status, undefined);
});

test("échu mais réglé on-chain : le prêt est clôturé SETTLED avec le hash de la chaîne, jamais remboursé", async () => {
  const { api, updates } = settlementFixture(overdue(), rejected("Tentative de règlement épuisée", 503), { state: "settled", txHash: OTHER_TX });
  await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
  assert.equal(updates[1].data.status, "SETTLED");
  assert.equal(updates[1].data.settleTxHash, OTHER_TX);
});

// --- Quote enregistrée à l'entraînement, revérifiée au règlement (audit A-01) : le TCB d'Intel
// peut avoir été déclassé entre-temps ; seule une révocation ou une signature refusée bloque.

const recordedQuote = (verification: Record<string, unknown>) => ({
  isRecordedQuoteHardwareValid,
  verifyTdxQuote: async () => ({ reportDataMatches: true, codeIdentityMatches: true, ...verification }),
});

test("A-01 : une quote enregistrée dont le TCB est passé OutOfDate depuis l'entraînement se règle encore", async () => {
  process.env.TEE_MODE = "phala";
  const { api, updates } = settlementFixture(inTime(), rejected("Tentative de règlement épuisée", 503), { state: "active" },
    recordedQuote({ hardwareVerified: false, tcbStatus: "OutOfDate" }));
  // Le runner est atteint : la vérification de la quote a laissé passer le règlement.
  await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
  assert.equal(updates[0].data.status, "SETTLING");
});

test("A-01 : une quote enregistrée révoquée par Intel, ou dont la signature échoue, ne se règle pas", async () => {
  process.env.TEE_MODE = "phala";
  for (const verification of [{ hardwareVerified: false, tcbStatus: "Revoked" }, { hardwareVerified: false }]) {
    const { api, updates } = settlementFixture(inTime(), rejected("Tentative de règlement épuisée", 503), { state: "active" },
      recordedQuote(verification));
    await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) =>
      error instanceof AppError && error.message === "Quote TDX runner non authentifiée" && error.status === 502);
    assert.equal(updates.length, 0, JSON.stringify(verification));
  }
});
