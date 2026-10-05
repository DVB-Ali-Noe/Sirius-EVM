import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "@/lib/app-error";
import * as addresses from "@/lib/evm/address";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import * as exposureLimits from "./exposure-limits";

// Audit du 5 octobre, A-06 / A-18 : un prêt PENDING jamais payé réserve de l'exposition gratuitement ;
// A-33 : le second contrôle d'exposition (total du devis) s'exécutait hors transaction.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, console, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const usdc = (value: string) => priceUsdcToAtomic(value) as string;
const provider = addresses.normalizeAddress(`0x${"11".repeat(20)}`);
const borrower = addresses.normalizeAddress(`0x${"22".repeat(20)}`);
const otherBorrower = addresses.normalizeAddress(`0x${"33".repeat(20)}`);
const thirdBorrower = addresses.normalizeAddress(`0x${"44".repeat(20)}`);
const runner = { runnerKind: "PHALA" as const, runnerDeploymentId: `phala:${"55".repeat(32)}` };
const model = { modelId: "linear_regression", modelVersion: "1.0.0" };
const dataset = {
  id: "dataset", provider, status: "LISTED", ...runner, ipfsCid: "bafyDataset", merkleRoot: "66".repeat(32),
  wrappedKey: "wrapped", runnerReceipt: "receipt", priceUsdcAtomic: usdc("50"), evmDatasetId: `0x${"77".repeat(32)}`,
  ...model, challengeDays: 7, listingExpiresAt: null,
};

interface LoanRow {
  id: string;
  borrower: string;
  datasetId: string;
  status: string;
  evmLockTxHash: string | null;
  amountUsdcAtomic: string;
  createdAt: Date;
  updatedAt: Date;
}

type Where = Record<string, unknown>;

function matches(row: LoanRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof LoanRow];
    if (condition && typeof condition === "object") {
      const clause = condition as { in?: unknown[]; not?: unknown; gte?: Date };
      if ("in" in clause) return clause.in!.includes(value);
      if ("not" in clause) return value !== clause.not;
      if ("gte" in clause) return (value as Date).getTime() >= clause.gte!.getTime();
    }
    return value === condition;
  });
}

function pendingLoan(owner: string, datasetId: string, overrides: Partial<LoanRow> = {}): LoanRow {
  return {
    id: `loan-${owner.slice(2, 6)}-${datasetId}`, borrower: owner, datasetId, status: "PENDING", evmLockTxHash: null,
    amountUsdcAtomic: usdc("50"), createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function fixture(rows: LoanRow[]) {
  const loans = [...rows];
  const calls = { signatures: 0, txFindMany: 0, outsideFindMany: 0, txUpdates: 0, outsideUpdates: 0 };
  const loanStore = (scope: "tx" | "outside") => ({
    count: async ({ where }: { where: Where }) => loans.filter((row) => matches(row, where)).length,
    findMany: async ({ where }: { where: Where }) => {
      calls[scope === "tx" ? "txFindMany" : "outsideFindMany"]++;
      return loans.filter((row) => matches(row, where)).map((row) => ({ amountUsdcAtomic: row.amountUsdcAtomic }));
    },
    create: async ({ data }: { data: Partial<LoanRow> }) => {
      const row = { id: `loan-${loans.length + 1}`, evmLockTxHash: null, createdAt: new Date(), updatedAt: new Date(), ...data } as LoanRow;
      loans.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<LoanRow> }) => {
      calls[scope === "tx" ? "txUpdates" : "outsideUpdates"]++;
      const row = loans.find((candidate) => candidate.id === where.id);
      assert.ok(row, "le prêt mis à jour doit exister");
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = loans.length;
      for (let index = loans.length - 1; index >= 0; index--) if (matches(loans[index], where)) loans.splice(index, 1);
      return { count: before - loans.length };
    },
  });
  const tx = { dataset: { updateMany: async () => ({ count: 1 }) }, loan: loanStore("tx") };
  const api = load<typeof import("./borrower")>("src/lib/sirius/borrower.ts", {
    "server-only": {}, "@/lib/errors": { AppError },
    "@/lib/db": {
      serializableTransaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
      prisma: { dataset: { findUnique: async () => dataset }, loan: loanStore("outside") },
    },
    "@/lib/evm/address": addresses,
    "@/lib/evm/addresses": { datasetRegistryAddress: () => provider, escrowAddress: () => provider },
    "@/lib/evm/abi/siriusdatasetregistry": {},
    "@/lib/evm/client": { getPublicClient: () => ({ readContract: async () => true, getBlockNumber: async () => BigInt(10) }) },
    "@/lib/evm/deployment": { requireCurrentEvmDeployment: async () => {} },
    "@/lib/evm/loan-key": { loanKeyFor: () => `0x${"88".repeat(32)}` },
    "@/lib/evm/escrow": {},
    "@/lib/evm/transaction": { approveUsdcTransaction: () => ({}), lockUsdcTransaction: () => ({}), lockQuotedUsdcTransaction: () => ({}) },
    "@/lib/billing/config": { billingEnabled: () => false },
    "@/lib/billing/quote": {}, "@/lib/billing/loan": {},
    "@/lib/tee/runner-client": { prepareEscrowLockInRunner: async () => {
      calls.signatures++;
      return { hashlock: `0x${"99".repeat(32)}`, authorization: {} };
    } },
    "./lock-policy": { lockAuthorizationDeadline: () => 1 },
    "@/lib/models/registry": { modelSelection: () => model, trainingProfileHash: () => `0x${"aa".repeat(32)}` },
    "./access": { requireAcceptedKyb: async () => {}, requireCounterpartyKyb: async () => {} },
    "./provider": { BORROWABLE_STATUSES: ["LISTED", "UNLISTED"], isBorrowableDatasetStatus: () => true },
    "@/lib/datasets/manage": { isListingExpired: () => false },
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: 46630, escrow: provider }) },
    "./recover-loan": {}, "@/lib/evm/history": {},
    "@/lib/runner/provenance": { assertCurrentRunner: async () => runner },
    // Module réel : les plafonds viennent de l'environnement posé par chaque test.
    "./exposure-limits": exposureLimits,
  });
  return { api, loans, calls };
}

const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "test", EVM_NETWORK: "testnet", SIRIUS_MAX_LOAN_USDC: "50", SIRIUS_MAX_EXPOSURE_USDC: "100" });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("un seul prêt PENDING non payé est admis par emprunteur, avant tout appel au runner", async () => {
  const { api, loans, calls } = fixture([pendingLoan(borrower, "other-dataset")]);
  await assert.rejects(api.prepareLoan(dataset.id, borrower), (error: unknown) =>
    error instanceof AppError && error.status === 429 && /déjà en attente de paiement/.test(error.message));
  assert.equal(loans.length, 1, "aucun second prêt non payé ne doit être créé");
  assert.equal(calls.signatures, 0, "le runner ne doit pas signer de devis pour un prêt refusé");
});

test("un PENDING déjà payé (hash de lock) ou le PENDING d'un autre compte ne bloque pas l'emprunteur", async () => {
  process.env.SIRIUS_MAX_EXPOSURE_USDC = "200";
  const { api, loans } = fixture([
    pendingLoan(borrower, "other-dataset", { evmLockTxHash: `0x${"bb".repeat(32)}` }),
    pendingLoan(otherBorrower, "other-dataset"),
  ]);
  await api.prepareLoan(dataset.id, borrower);
  assert.equal(loans.length, 3);
  assert.equal(loans[2].borrower, borrower);
});

test("un PENDING non payé d'un autre compte reste compté dans l'exposition totale", async () => {
  // Son autorisation de lock peut encore être renouvelée : le retirer du décompte permettrait de dépasser le plafond.
  const { api, loans, calls } = fixture([pendingLoan(otherBorrower, "other-dataset"), pendingLoan(thirdBorrower, "third-dataset")]);
  await assert.rejects(api.prepareLoan(dataset.id, borrower), /exposition totale/);
  assert.equal(loans.length, 2);
  assert.equal(calls.signatures, 0);
});

test("le contrôle sur le total du devis et son enregistrement partagent une transaction sérialisable", async () => {
  const { api, loans, calls } = fixture([]);
  const { loan } = await api.prepareLoan(dataset.id, borrower);
  assert.equal(loans.length, 1);
  assert.equal(loan.evmHashlock, `0x${"99".repeat(32)}`);
  assert.equal(calls.txFindMany, 2, "les deux contrôles d'exposition lisent les prêts dans une transaction");
  assert.equal(calls.txUpdates, 1, "le total du devis est enregistré dans la même transaction que son contrôle");
  assert.equal(calls.outsideFindMany, 0);
  assert.equal(calls.outsideUpdates, 0);
});
