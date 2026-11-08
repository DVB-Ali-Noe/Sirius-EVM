import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { borrowDataset } from "@/lib/loans/client";
import { useWalletStore } from "@/stores/wallet";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { siriusescrowv7Abi } from "@/lib/evm/abi/siriusescrowv7";
import { trainInWorker } from "@/lib/tee/bounded-training";
import type { DatasetRef } from "@/lib/tee/contract";
import { computeQuoteHash, failureFee, parseComputeQuote, quoteAuthorizationTypedData, quoteTermsHash, requireRentalQuote, verifyComputeQuote, type ComputeQuote } from "./quote";
import { assertQuoteDataset, computeQuoteAmounts } from "./runner";
import type { BillingPolicy } from "./config";
import { AppError } from "@/lib/app-error";
import { datasetAmountFor, isValidRentalDays } from "./rental";

const runner = privateKeyToAccount(`0x${"31".repeat(32)}`);
const address = (n: string) => `0x${n.repeat(40)}` as Hex;
function quote(): ComputeQuote {
  return {
    version: 7, chainId: 46630, escrow: address("1"), usdc: address("2"), usdcDecimals: 6,
    runner: runner.address.toLowerCase() as Hex, loanId: "loan", datasetId: "dataset",
    onChainDatasetId: `0x${"11".repeat(32)}`, datasetReceiptHash: `0x${"22".repeat(32)}`,
    borrower: address("3"), provider: address("4"), computeRecipient: address("5"),
    datasetAmount: "1000000", computeAmount: "500000", maxFailureFee: "10000", executionRateAtomicPerMs: "2",
    maxExecutionMs: 10000, maxDatasetBytes: 3 * 1024 * 1024, hashlock: `0x${"33".repeat(32)}`,
    challengeDays: 1, modelId: "linear_regression", modelVersion: "1.0.0", tariffVersion: "synthetic-v1",
    expiresAt: Math.floor(Date.now() / 1000) + 240, failurePolicy: "consumed-execution-only", rentalDays: 1,
  };
}
async function sign(q = quote()) {
  return { quote: q, authorization: { deadline: q.expiresAt, signature: await runner.signTypedData(quoteAuthorizationTypedData(q)) } };
}

test("le devis canonique signe aussi le barème, les plafonds et la politique de remboursement", async () => {
  const signed = await sign();
  const expected = { chainId: 46630, escrow: signed.quote.escrow, runner: runner.address };
  await verifyComputeQuote(signed, expected, true);
  const reversed = Object.fromEntries(Object.entries(signed.quote).reverse()) as ComputeQuote;
  assert.equal(computeQuoteHash(reversed), computeQuoteHash(signed.quote));
  for (const changes of [
    { computeAmount: "600000" }, { maxFailureFee: "9999" }, { executionRateAtomicPerMs: "3" },
    { maxExecutionMs: 5000 }, { maxDatasetBytes: 1000 }, { tariffVersion: "other" },
    { provider: address("6") }, { computeRecipient: address("6") }, { borrower: address("6") },
    { loanId: "other" }, { datasetReceiptHash: `0x${"44".repeat(32)}` as Hex },
    { rentalDays: 2 }, { extendsLoanId: "loan-origin" }, { callPack: 100 as const, packForLoanId: "loan-origin" },
  ]) {
    const changed = { ...signed.quote, ...changes };
    assert.notEqual(quoteTermsHash(changed), quoteTermsHash(signed.quote));
    await assert.rejects(verifyComputeQuote({ ...signed, quote: changed }, expected), /Signature/);
  }
  await assert.rejects(verifyComputeQuote(signed, { ...expected, chainId: 4663 }), /scope/);
  await assert.rejects(verifyComputeQuote(signed, { ...expected, escrow: address("7") }), /scope/);
});

test("un devis expiré ne permet plus de payer mais reste vérifiable pour clôturer un prêt", async () => {
  const signed = await sign({ ...quote(), expiresAt: Math.floor(Date.now() / 1000) - 1 });
  const expected = { chainId: 46630, escrow: signed.quote.escrow, runner: runner.address };
  await assert.rejects(verifyComputeQuote(signed, expected, true), /expiré/);
  await verifyComputeQuote(signed, expected);
});

test("les montants atomiques, limites et bénéficiaires sont stricts", () => {
  for (const changes of [
    { computeAmount: 1 }, { computeAmount: "1e6" }, { computeAmount: "-1" }, { computeAmount: "0" },
    { datasetAmount: "01" }, { maxFailureFee: "500001" }, { maxExecutionMs: 30001 },
    { computeRecipient: quote().borrower }, { computeRecipient: quote().runner },
    { computeAmount: String(BigInt(2) ** BigInt(96)) }, { unknown: 1 },
  ]) assert.throws(() => parseComputeQuote({ ...quote(), ...changes }), /invalide/);
  for (const usdcDecimals of [6, 18]) {
    const q = { ...quote(), usdcDecimals, datasetAmount: String(BigInt(10) ** BigInt(usdcDecimals)) };
    assert.deepEqual(parseComputeQuote(q), q);
  }
});

test("la durée de location est signée, bornée de 1 à 365 jours, et une prolongation désigne un autre prêt", () => {
  for (const rentalDays of [1, 30, 365]) assert.equal(parseComputeQuote({ ...quote(), rentalDays }).rentalDays, rentalDays);
  for (const rentalDays of [0, -1, 366, 1.5, "1", Number.NaN]) {
    assert.throws(() => parseComputeQuote({ ...quote(), rentalDays }), /Durée de location du devis invalide/);
  }
  assert.notEqual(computeQuoteHash({ ...quote(), rentalDays: 7 }), computeQuoteHash({ ...quote(), rentalDays: 8 }));
  const extension = parseComputeQuote({ ...quote(), extendsLoanId: "loan-origin" });
  assert.equal(extension.extendsLoanId, "loan-origin");
  assert.equal("extendsLoanId" in parseComputeQuote(quote()), false, "absent hors prolongation");
  for (const extendsLoanId of ["", "loan", 1, null, "x".repeat(129)]) {
    assert.throws(() => parseComputeQuote({ ...quote(), extendsLoanId }), /Durée de location du devis invalide/);
  }
  assert.throws(() => parseComputeQuote({ ...quote(), rentalDays: null, extendsLoanId: "loan-origin" }), /invalide/);
});

test("un devis hérité (sans durée) reste lisible, sans expiration, et garde son empreinte d'origine", () => {
  const { rentalDays: _rental, ...legacy } = quote();
  void _rental;
  const parsed = parseComputeQuote(legacy);
  assert.equal(parsed.rentalDays, null);
  // Empreinte calculée avant D-29 : JSON des seules clés historiques, dans leur ordre.
  assert.equal(computeQuoteHash(parsed), keccak256(toHex(JSON.stringify(legacy))));
  assert.equal(computeQuoteHash({ ...legacy, rentalDays: null }), computeQuoteHash(parsed), "relu depuis la base avec rentalDays nul");
  assert.equal(computeQuoteHash(parseComputeQuote(JSON.parse(JSON.stringify(parsed)))), computeQuoteHash(parsed));
  assert.throws(() => requireRentalQuote(parsed), /sans durée de location/);
  assert.equal(requireRentalQuote(parseComputeQuote(quote())).rentalDays, 1);
});

test("le montant dataset vaut prix par jour × jours, dans la durée maximale du reçu", () => {
  assert.equal(datasetAmountFor("1000000", 7), "7000000");
  assert.equal(datasetAmountFor("1", 365), "365");
  for (const days of [0, 366, 1.5]) assert.throws(() => datasetAmountFor("1000000", days), RangeError);
  assert.throws(() => datasetAmountFor("01", 1), RangeError);
  assert.equal(isValidRentalDays(30, 30), true);
  assert.equal(isValidRentalDays(31, 30), false);
  assert.equal(isValidRentalDays(365, 1000), true);
  assert.equal(isValidRentalDays(366, 1000), false);

  const receipt = "dataset-receipt";
  const dataset: DatasetRef = { datasetId: "dataset", cid: "cid", wrappedKey: "key", merkleRoot: "root",
    priceUsdcAtomic: "1000000", challengeDays: 1, maxRentalDays: 10, modelId: "linear_regression", modelVersion: "1.0.0" };
  const scoped = (changes: Partial<ComputeQuote>) => parseComputeQuote({ ...quote(), datasetReceiptHash: keccak256(toHex(receipt)), ...changes });
  const check = (q: ComputeQuote) => assertQuoteDataset(q, dataset, receipt, q.borrower, q.loanId);
  check(scoped({ rentalDays: 7, datasetAmount: "7000000" }));
  check(scoped({ rentalDays: 10, datasetAmount: "10000000" }));
  for (const changes of [
    { rentalDays: 7, datasetAmount: "1000000" }, { rentalDays: 7, datasetAmount: "7000001" },
    { rentalDays: 11, datasetAmount: "11000000" },
  ]) assert.throws(() => check(scoped(changes)), /hors scope/, JSON.stringify(changes));
  // Devis hérité : le prix forfaitaire de l'époque, sans multiplication.
  const { rentalDays: _rental, ...legacy } = scoped({});
  void _rental;
  check(parseComputeQuote(legacy));
});

test("un pack d'appels désigne un autre prêt, une taille autorisée, une durée, et jamais une prolongation", () => {
  const pack = parseComputeQuote({ ...quote(), callPack: 1000, packForLoanId: "loan-origin" });
  assert.deepEqual([pack.callPack, pack.packForLoanId], [1000, "loan-origin"]);
  const plain = parseComputeQuote(quote());
  assert.equal("callPack" in plain || "packForLoanId" in plain, false, "absents hors pack");
  for (const changes of [
    { callPack: 100 }, { packForLoanId: "loan-origin" },
    { callPack: 500, packForLoanId: "loan-origin" }, { callPack: "100", packForLoanId: "loan-origin" },
    { callPack: 100, packForLoanId: "loan" }, { callPack: 100, packForLoanId: "" }, { callPack: 100, packForLoanId: "x".repeat(129) },
    { callPack: 100, packForLoanId: "loan-origin", extendsLoanId: "loan-origin" },
    { callPack: 100, packForLoanId: "loan-origin", rentalDays: null },
  ]) assert.throws(() => parseComputeQuote({ ...quote(), ...changes }), /invalide/, JSON.stringify(changes));
  assert.equal(requireRentalQuote(pack).rentalDays, 1, "durée du prêt d'origine recopiée");
});

test("les empreintes des devis sans pack sont inchangées ; le pack entre dans l'empreinte", () => {
  // Empreinte d'avant D-30 : JSON des clés historiques puis `rentalDays`, `extendsLoanId`, dans cet ordre.
  const q = quote();
  assert.equal(computeQuoteHash(q), keccak256(toHex(JSON.stringify(q))));
  const extension = { ...q, extendsLoanId: "loan-origin" };
  assert.equal(computeQuoteHash(extension), keccak256(toHex(JSON.stringify(extension))));
  const pack = { ...q, callPack: 100 as const, packForLoanId: "loan-origin" };
  assert.equal(computeQuoteHash(pack), keccak256(toHex(JSON.stringify(pack))));
  assert.notEqual(computeQuoteHash(pack), computeQuoteHash(q));
  assert.notEqual(computeQuoteHash(pack), computeQuoteHash({ ...pack, callPack: 1000 }));
  assert.equal(computeQuoteHash(parseComputeQuote(JSON.parse(JSON.stringify(pack)))), computeQuoteHash(pack));
});

const billing = (changes: Partial<BillingPolicy> = {}): BillingPolicy => ({
  version: 1, tariffVersion: "synthetic-v1", costReference: "synthetic", validUntil: Date.now() + 86_400_000,
  chainId: 46630, usdc: address("2"), usdcDecimals: 6, computeRecipient: address("5"),
  minimumComputeAmount: "7000000", noTrainingComputeAmount: "100000",
  apiCallsPerDay: { logistic_regression: 50, gradient_boosted_trees: 100 },
  profiles: {
    linear_regression: { computeAmount: "8000000", maxFailureFee: "10000", executionRateAtomicPerMs: "2", maxExecutionMs: 10000 },
    logistic_regression: { computeAmount: "1000", maxFailureFee: "10000", executionRateAtomicPerMs: "2", maxExecutionMs: 10000 },
  },
  ...changes,
});

test("emprunt : compute du profil relevé au minimum ; prolongation et pack : frais sans entraînement, aucune retenue", () => {
  const logistic = { modelId: "logistic_regression" as const, priceUsdcAtomic: "1000001" };
  assert.deepEqual(computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7 }),
    { datasetAmount: "7000007", computeAmount: "7000000", maxFailureFee: "10000" });
  assert.deepEqual(computeQuoteAmounts(billing(), { dataset: { ...logistic, modelId: "linear_regression" }, rentalDays: 1 }),
    { datasetAmount: "1000001", computeAmount: "8000000", maxFailureFee: "10000" });
  assert.deepEqual(computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7, extendsLoanId: "loan-origin" }),
    { datasetAmount: "7000007", computeAmount: "100000", maxFailureFee: "0" });
  // Pack : 100 × ceil(1 000 001 / 50) = 100 × 20 001 ; les jours du prêt d'origine ne sont pas facturés.
  assert.deepEqual(computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7, callPack: 100 }),
    { datasetAmount: "2000100", computeAmount: "100000", maxFailureFee: "0" });
  assert.equal(computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7, callPack: 10000 }).datasetAmount, "200010000");
});

test("API incluse : jours × tarif journalier ajoutés au compute d'un emprunt ou d'une prolongation, retenue et part fournisseur inchangées", () => {
  const logistic = { modelId: "logistic_regression" as const, priceUsdcAtomic: "1000001" };
  const priced = billing({ apiAccessDailyComputeAmount: "1500000" });
  assert.deepEqual(computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 7, apiAccessIncluded: true }),
    { datasetAmount: "7000007", computeAmount: "17500000", maxFailureFee: "10000", apiAccessIncluded: true, apiAccessAmount: "10500000" });
  assert.deepEqual(computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 2, extendsLoanId: "loan-origin", apiAccessIncluded: true }),
    { datasetAmount: "2000002", computeAmount: "3100000", maxFailureFee: "0", apiAccessIncluded: true, apiAccessAmount: "3000000" });
  assert.deepEqual(computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 7 }),
    { datasetAmount: "7000007", computeAmount: "7000000", maxFailureFee: "10000" }, "sans l'option : inchangé");
  assert.throws(() => computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7, apiAccessIncluded: true }),
    (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "api_access_not_for_sale");
  assert.throws(() => computeQuoteAmounts(priced, { dataset: { ...logistic, modelId: "linear_regression" }, rentalDays: 1, apiAccessIncluded: true }),
    /API indisponible/);
  assert.throws(() => computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 7, callPack: 100, apiAccessIncluded: true }), /inclus/);
  // Devis : drapeau et montant ensemble, montant couvert par le compute au-delà de la retenue maximale.
  const included = { ...quote(), computeAmount: "1500000", apiAccessIncluded: true, apiAccessAmount: "1000000" };
  assert.equal(parseComputeQuote(included).apiAccessAmount, "1000000");
  for (const changes of [{ apiAccessAmount: undefined }, { apiAccessIncluded: undefined }, { apiAccessAmount: "0" },
    { apiAccessAmount: "1495000" }, { apiAccessIncluded: "true" }, { rentalDays: null }]) {
    const value: Record<string, unknown> = { ...included, ...changes };
    for (const [key, field] of Object.entries(value)) if (field === undefined) delete value[key];
    assert.throws(() => parseComputeQuote(value), /invalide/, JSON.stringify(changes));
  }
  assert.notEqual(computeQuoteHash(parseComputeQuote(included)), computeQuoteHash({ ...quote(), computeAmount: "1500000" }));
});

test("pas de pack pour un profil sans quota d'API, la régression linéaire, une taille invalide ou une prolongation", () => {
  const logistic = { modelId: "logistic_regression" as const, priceUsdcAtomic: "1000000" };
  assert.throws(() => computeQuoteAmounts(billing({ apiCallsPerDay: {} }), { dataset: logistic, rentalDays: 1, callPack: 100 }), /API indisponible/);
  assert.throws(() => computeQuoteAmounts(billing({ apiCallsPerDay: { linear_regression: 10 } }),
    { dataset: { ...logistic, modelId: "linear_regression" }, rentalDays: 1, callPack: 100 }), /API indisponible/);
  assert.throws(() => computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 1, callPack: 500 as unknown as 100 }),
    (error: unknown) => error instanceof AppError && error.status === 400 && /Taille de pack/.test(error.message));
  assert.throws(() => computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 1, callPack: 100, extendsLoanId: "loan-origin" }), /Pack/);
  assert.throws(() => computeQuoteAmounts(billing(), { dataset: { ...logistic, modelId: "gradient_boosted_trees" }, rentalDays: 1, callPack: 100 }),
    /Tarif compute absent/, "profil quoté mais non tarifé");
});

test("le devis d'un pack se vérifie contre le dataset : montant du pack, aucune retenue, profil avec quota", () => {
  const receipt = "dataset-receipt";
  const dataset: DatasetRef = { datasetId: "dataset", cid: "cid", wrappedKey: "key", merkleRoot: "root",
    priceUsdcAtomic: "1000001", challengeDays: 1, maxRentalDays: 10, modelId: "logistic_regression", modelVersion: "1.0.0" };
  const calls = billing().apiCallsPerDay;
  const pack = (changes: Partial<ComputeQuote>) => parseComputeQuote({ ...quote(), modelId: "logistic_regression", modelVersion: "1.0.0",
    datasetReceiptHash: keccak256(toHex(receipt)), rentalDays: 7, callPack: 100, packForLoanId: "loan-origin",
    datasetAmount: "2000100", maxFailureFee: "0", ...changes });
  const check = (q: ComputeQuote, quotas = calls) => assertQuoteDataset(q, dataset, receipt, q.borrower, q.loanId, quotas);
  check(pack({}));
  check(pack({ callPack: 1000, datasetAmount: "20001000" }));
  for (const changes of [
    { datasetAmount: "2000000" }, { datasetAmount: "7000007" }, { callPack: 1000 as const },
    { maxFailureFee: "1" }, { rentalDays: 11 },
  ]) assert.throws(() => check(pack(changes)), /hors scope/, JSON.stringify(changes));
  assert.throws(() => check(pack({}), {}), /API indisponible/);
  // Prolongation : jamais de retenue non plus.
  const extension = (changes: Partial<ComputeQuote>) => parseComputeQuote({ ...quote(), modelId: "logistic_regression", modelVersion: "1.0.0",
    datasetReceiptHash: keccak256(toHex(receipt)), rentalDays: 7, extendsLoanId: "loan-origin", datasetAmount: "7000007", maxFailureFee: "0", ...changes });
  check(extension({}));
  assert.throws(() => check(extension({ maxFailureFee: "1" })), /hors scope/);
});

test("pass d'accès API : jours × tarif journalier à Sirius, minimum du contrat au fournisseur, aucune retenue", () => {
  const logistic = { modelId: "logistic_regression" as const, priceUsdcAtomic: "1000001" };
  const priced = billing({ apiAccessDailyComputeAmount: "1500000" });
  assert.deepEqual(computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 7, apiAccessDays: 3 }),
    { datasetAmount: "1000", computeAmount: "4500000", maxFailureFee: "0" });
  assert.equal(computeQuoteAmounts({ ...priced, usdcDecimals: 18 }, { dataset: logistic, rentalDays: 7, apiAccessDays: 1 }).datasetAmount,
    "1000000000000000", "0,001 jeton à 18 décimales");
  // Tarif sans champ d'accès API : pas en vente, jamais gratuit.
  assert.throws(() => computeQuoteAmounts(billing(), { dataset: logistic, rentalDays: 7, apiAccessDays: 3 }),
    (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "api_access_not_for_sale");
  for (const input of [{ apiAccessDays: 0 }, { apiAccessDays: 3, callPack: 100 as const }, { apiAccessDays: 3, extendsLoanId: "loan-origin" }]) {
    assert.throws(() => computeQuoteAmounts(priced, { dataset: logistic, rentalDays: 7, ...input }), JSON.stringify(input));
  }
});

test("le devis d'un pass désigne le prêt d'origine, des jours bornés, exclusif d'un pack et d'une prolongation", () => {
  const receipt = "dataset-receipt";
  const dataset: DatasetRef = { datasetId: "dataset", cid: "cid", wrappedKey: "key", merkleRoot: "root",
    priceUsdcAtomic: "1000001", challengeDays: 1, maxRentalDays: 10, modelId: "logistic_regression", modelVersion: "1.0.0" };
  const pass = (changes: Record<string, unknown>) => ({ ...quote(), modelId: "logistic_regression", modelVersion: "1.0.0",
    datasetReceiptHash: keccak256(toHex(receipt)), rentalDays: 7, apiAccessDays: 3, packForLoanId: "loan-origin",
    apiAccessRentalEnd: 2_000_000_000_000, apiAccessCoveredUntil: 1_999_000_000_000,
    datasetAmount: "1000", computeAmount: "4500000", maxFailureFee: "0", ...changes });
  const parsed = parseComputeQuote(pass({}));
  assert.deepEqual([parsed.apiAccessDays, parsed.packForLoanId, parsed.callPack], [3, "loan-origin", undefined]);
  assertQuoteDataset(parsed, dataset, receipt, parsed.borrower, parsed.loanId, billing().apiCallsPerDay);
  for (const changes of [{ datasetAmount: "2000100" }, { maxFailureFee: "1" }]) {
    assert.throws(() => assertQuoteDataset(parseComputeQuote(pass(changes)), dataset, receipt, parsed.borrower, parsed.loanId), /hors scope/);
  }
  for (const changes of [{ apiAccessDays: 0 }, { apiAccessDays: 3651 }, { apiAccessDays: "3" }, { packForLoanId: undefined },
    { callPack: 100 }, { extendsLoanId: "loan-origin" }, { rentalDays: null },
    // Base du prix : échéance obligatoire, couverture antérieure strictement avant l'échéance.
    { apiAccessRentalEnd: undefined }, { apiAccessRentalEnd: 0 }, { apiAccessRentalEnd: "2000000000000" },
    { apiAccessCoveredUntil: 2_000_000_000_000 }, { apiAccessCoveredUntil: 0 }]) {
    const value = pass(changes) as Record<string, unknown>;
    for (const [key, field] of Object.entries(value)) if (field === undefined) delete value[key];
    assert.throws(() => parseComputeQuote(value), /invalide/, JSON.stringify(changes));
  }
  assert.throws(() => parseComputeQuote({ ...quote(), apiAccessRentalEnd: 2_000_000_000_000 }), /invalide/, "base sans pass");
  const firstPass = pass({}) as Record<string, unknown>;
  delete firstPass.apiAccessCoveredUntil;
  assert.equal(parseComputeQuote(firstPass).apiAccessCoveredUntil, undefined, "premier pass : aucune couverture antérieure");
  const hashed = parseComputeQuote(pass({}));
  assert.deepEqual([hashed.apiAccessRentalEnd, hashed.apiAccessCoveredUntil], [2_000_000_000_000, 1_999_000_000_000]);
  assert.notEqual(computeQuoteHash(hashed), computeQuoteHash({ ...hashed, apiAccessDays: 4 }), "les jours entrent dans l'empreinte");
  assert.notEqual(computeQuoteHash(hashed), computeQuoteHash({ ...hashed, apiAccessRentalEnd: 2_000_000_000_001 }), "l'échéance de base aussi");
  assert.notEqual(computeQuoteHash(hashed), computeQuoteHash(parseComputeQuote(firstPass)), "la couverture de base aussi");
});

test("la retenue vient de la durée mesurée et reste plafonnée, jamais du forfait de réussite", () => {
  const q = quote();
  assert.equal(failureFee(q, 0), "0");
  assert.equal(failureFee(q, 25), "50");
  assert.equal(failureFee(q, 10000), q.maxFailureFee);
  assert.equal(failureFee({ ...q, maxFailureFee: "0" }, 10000), "0");
  for (const elapsed of [-1, 1.5, 10001, NaN]) assert.throws(() => failureFee(q, elapsed), /invalide/);
});

for (const scenario of ["accept", "decline", "changed", "wallet", "missing", "omitted"] as const) {
  test(`pré paiement navigateur : ${scenario}`, async (t) => {
    const signed = await sign();
    const env = { ...process.env };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const sent: Array<{ to: string; data: Hex }> = [];
    let accepted = false;
    Object.assign(process.env, { SIRIUS_ESCROW_ADDRESS: signed.quote.escrow, SIRIUS_USDC_ADDRESS: signed.quote.usdc, NEXT_PUBLIC_EVM_NETWORK: "testnet" });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      ethereum: { request: async ({ method, params }: { method: string; params?: Array<{ to: string; data: Hex }> }) => {
        if (method === "eth_chainId") return "0xb626";
        if (method === "eth_call") return params![0].to === signed.quote.usdc
          ? encodeAbiParameters([{ type: "uint8" }], [6])
          : params![0].data === encodeFunctionData({ abi: siriusescrowv7Abi, functionName: "VERSION" })
            ? encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v7"])
            : encodeAbiParameters([{ type: "address" }], [runner.address]);
        if (method === "eth_getTransactionReceipt") return { status: "0x1" };
        if (method === "eth_sendTransaction") {
          assert.equal(accepted, true, "aucune transaction avant acceptation");
          sent.push(params![0]);
          return `0x${"11".repeat(32)}`;
        }
        throw new Error(method);
      } },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    } });
    useWalletStore.getState().setConnected(signed.quote.borrower, "testnet", "external");
    useWalletStore.getState().setAuthenticated(true);
    mock.method(globalThis, "fetch", async (input: string) => {
      if (input === "/api/loans") return Response.json({ loanId: "loan", ...(scenario === "omitted" ? {} : { billingQuote: signed }),
        approveTransaction: { data: "untrusted" }, lockTransaction: { data: "untrusted" } });
      if (input.endsWith("/authorize")) return Response.json({
        lockTransaction: { data: "untrusted" }, authorizationDeadline: signed.quote.expiresAt,
        billingQuote: scenario === "changed" ? { ...signed, quote: { ...signed.quote, computeAmount: "700000" } } : signed,
      });
      if (input.endsWith("/submit")) return Response.json({});
      throw new Error(input);
    });
    t.after(() => {
      mock.restoreAll();
      useWalletStore.getState().setDisconnected();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
    });
    const result = borrowDataset({ datasetId: "dataset", priceUsdcAtomic: signed.quote.datasetAmount, rentalDays: 1, confirmQuote: scenario === "missing" ? undefined : async (q) => {
      assert.deepEqual(q, signed.quote);
      if (scenario === "decline") return false;
      if (scenario === "wallet") useWalletStore.getState().setDisconnected();
      accepted = true;
      return true;
    } });
    if (scenario === "changed") await assert.rejects(result, /scope/);
    else if (scenario === "wallet") await assert.rejects(result, /wallet/);
    else if (scenario === "missing") await assert.rejects(result, /Acceptation/);
    else if (scenario === "omitted") await assert.rejects(result, /Devis compute absent/);
    else assert.equal(await result, scenario === "accept");
    assert.equal(sent.length, scenario === "accept" ? 2 : scenario === "changed" ? 1 : 0);
    if (sent[0]) {
      const approval = decodeFunctionData({ abi: erc20Abi, data: sent[0].data });
      assert.equal(approval.functionName, "approve");
      assert.deepEqual(approval.args, [signed.quote.escrow, BigInt(1500000)]);
    }
    if (sent[1]) {
      const lock = decodeFunctionData({ abi: siriusescrowv7Abi, data: sent[1].data });
      assert.equal(lock.functionName, "lock");
      if (lock.functionName === "lock") assert.equal(lock.args[0].quoteHash, computeQuoteHash(signed.quote));
    }
  });
}

test("un délai interrompu termine effectivement le worker de calcul", async () => {
  const controller = new AbortController();
  const result = trainInWorker(quote(), Buffer.from("x,y\n" + Array.from({ length: 100 }, (_, i) => `${i},${i}`).join("\n")), controller.signal);
  controller.abort();
  await assert.rejects(result, /interrompue/);
});
