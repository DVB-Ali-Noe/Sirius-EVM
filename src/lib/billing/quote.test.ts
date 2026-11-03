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
import { assertQuoteDataset } from "./runner";
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
    { rentalDays: 2 }, { extendsLoanId: "loan-origin" },
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
