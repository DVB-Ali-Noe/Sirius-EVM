import * as viem from "viem";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/app-error";
import * as profileAdmission from "@/lib/runner/profile-admission";
import { errorResponse } from "@/lib/errors";
import { readBody, readJson } from "@/lib/http/body";
import * as rateLimit from "@/lib/http/rate-limit";
import * as addresses from "@/lib/evm/address";
import * as fastFinality from "@/lib/evm/fast-finality";
import * as models from "@/lib/models/registry";
import * as contract from "@/lib/tee/contract";
import * as rentalRules from "@/lib/billing/rental";
import * as apiPricing from "@/lib/billing/api-pricing";
import * as settlementStatus from "@/lib/loans/settlement-status";
import * as failurePolicy from "@/lib/runner/failure-policy";
import { isApiHost, apiHostPath } from "@/lib/http/api-host";
import * as createRequest from "@/lib/datasets/create-request";
import * as publication from "@/lib/datasets/publication";
import { proxy } from "@/proxy";
import * as reaperPolicy from "./reaper-policy";
import * as reaperErrors from "./reaper-errors";
import { settlementQueuedError } from "./settlement-queued";

// D-30 : API développeurs côté Next. Exécution réelle des routes publiques et de gestion, de
// `public-api.ts`, `api-keys.ts`, `availability.ts`, `calls.ts`, `borrower.ts`, `extend.ts`,
// `release-tier.ts`, `finality-tier.ts` et du reaper ; base, chaîne et runner remplacés en mémoire.
// Réveil de la CVM par le devis (`POST /api/loans`) et la publication (`POST /api/datasets`,
// `draft.ts`, `pipeline.ts`) : mêmes doubles.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, BigInt, Buffer, TextDecoder, TextEncoder, URL, console, process, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name} (${file})`);
    return dependencies[name];
  } });
  return exports as T;
}

const DAY = 86_400_000;
const DECIMALS = 6;
const usdc = (value: string) => (BigInt(value) * BigInt(10) ** BigInt(DECIMALS)).toString();
const CHAIN_ID = 46630;
const BORROWER = addresses.normalizeAddress(`0x${"22".repeat(20)}`);
const PROVIDER = addresses.normalizeAddress(`0x${"33".repeat(20)}`);
const OTHER = addresses.normalizeAddress(`0x${"44".repeat(20)}`);
const SETTLE_TX = `0x${"55".repeat(32)}`;
const PACK_TX = `0x${"66".repeat(32)}`;
const LOCK_TX = `0x${"77".repeat(32)}`;
const FINGERPRINT = `sm1${"ab".repeat(32)}`;
const KEY_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY_ID = "BBBBBBBBBBBBBBBBBBBBBB";
const runnerKey = privateKeyToAccount(`0x${"42".repeat(32)}`);
const features = { income: 45000, debt: 12 };
/** Prix par jour : 1,000001 USDC ; 50 appels par jour ⇒ ceil(1 000 001 / 50) = 20 001 atomes par appel. */
const PRICE_PER_DAY = "1000001";
const API_CALLS_PER_DAY = { logistic_regression: 50, gradient_boosted_trees: 100 };
const NO_TRAINING_COMPUTE = "100000";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
const OPERATORS = ["in", "not", "lt", "lte", "gt", "gte"];

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (condition === null || typeof condition !== "object") return (value ?? null) === condition;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    const ops = Object.entries(condition as Where);
    if (!ops.some(([op]) => OPERATORS.includes(op))) return Boolean(value) && typeof value === "object" && matches(value as Row, condition as Where);
    return ops.every(([op, expected]) => {
      if (op === "in") return (expected as unknown[]).includes(value);
      if (op === "not") return (value ?? null) !== expected;
      if (value === null || value === undefined) return false;
      const a = value instanceof Date ? value.getTime() : value as number | string;
      const b = expected instanceof Date ? expected.getTime() : expected as number | string;
      return op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b;
    });
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value ? Number(row[key] ?? 0) + (value as { increment: number }).increment : value;
  }
}

/** Table en mémoire au sous-ensemble Prisma utilisé ; `touch` : `@updatedAt` des prêts. */
function table(rows: Row[], options: { touch?: boolean; unique?: (where: Where) => Where; view?: (row: Row) => Row } = {}) {
  const view = options.view ?? ((row: Row) => row);
  const unique = options.unique ?? ((where: Where) => where);
  const touch = (row: Row, data: Row) => {
    apply(row, data);
    if (options.touch && !("updatedAt" in data)) row.updatedAt = new Date(Math.max(Date.now(), (row.updatedAt as Date).getTime() + 1));
  };
  let created = 0;
  return {
    rows,
    findUnique: async ({ where }: { where: Where }) => { const row = rows.find((r) => matches(r, unique(where))); return row ? { ...row } : null; },
    findUniqueOrThrow: async ({ where }: { where: Where }) => ({ ...rows.find((r) => matches(r, unique(where)))! }),
    findMany: async ({ where = {} }: { where?: Where } = {}) => rows.filter((r) => matches(view(r), where)).map((r) => ({ ...r })),
    count: async ({ where = {} }: { where?: Where } = {}) => rows.filter((r) => matches(view(r), where)).length,
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const hits = rows.filter((r) => matches(r, where));
      for (const row of hits) touch(row, data);
      return { count: hits.length };
    },
    update: async ({ where, data }: { where: Where; data: Row }) => {
      const row = rows.find((r) => matches(r, unique(where)))!;
      touch(row, data);
      return { ...row };
    },
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `pack-${++created}`, status: "PENDING", finalityTier: "FULL", createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    upsert: async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
      const row = rows.find((r) => matches(r, unique(where)));
      if (row) { touch(row, update); return { ...row }; }
      const fresh = { createdAt: new Date(), ...create };
      rows.push(fresh);
      return { ...fresh };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
}

function origin(overrides: Row = {}): Row {
  return {
    id: "loan-1", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "SETTLED",
    modelId: "logistic_regression", modelVersion: "1.0.0", modelCid: FINGERPRINT, runnerReceipt: "loan-receipt",
    settleTxHash: SETTLE_TX, finalityReview: null, finalityTier: "FULL", rentalDays: 7, rentalExpiresAt: new Date(Date.now() + DAY),
    extendsLoanId: null, packForLoanId: null, callPack: null, amountUsdcAtomic: usdc("7"), updatedAt: new Date(0), createdAt: new Date(0),
    runnerKind: "PHALA", runnerDeploymentId: "phala:1", ...overrides,
  };
}

function quoteFor(loan: Row): string {
  return JSON.stringify({ quote: {
    loanId: loan.id, datasetId: loan.datasetId, borrower: String(loan.borrower).toLowerCase(), rentalDays: 7,
    datasetAmount: loan.datasetAmountUsdcAtomic, computeAmount: NO_TRAINING_COMPUTE, maxFailureFee: "0",
    ...(loan.packForLoanId ? { callPack: loan.callPack, packForLoanId: loan.packForLoanId } : {}),
    ...(loan.extendsLoanId ? { extendsLoanId: loan.extendsLoanId } : {}),
  }, authorization: { deadline: 1, signature: "0x" } });
}

/** Prêt rattaché verrouillé (ESCROWED, lock finalisé) : pack d'appels ou prolongation. */
function attached(kind: "pack" | "extension", overrides: Row = {}): Row {
  const row: Row = {
    id: kind === "pack" ? "pack-9" : "ext-9", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "ESCROWED",
    modelId: "logistic_regression", modelVersion: "1.0.0", modelCid: null, runnerReceipt: null, settleTxHash: null,
    finalityReview: null, finalityTier: "FULL", rentalDays: kind === "pack" ? 7 : 5, rentalExpiresAt: null,
    extendsLoanId: kind === "extension" ? "loan-1" : null, packForLoanId: kind === "pack" ? "loan-1" : null,
    callPack: kind === "pack" ? 100 : null, datasetAmountUsdcAtomic: "2000100", amountUsdcAtomic: usdc("5"),
    evmLoanKey: `0x${(kind === "pack" ? "99" : "98").repeat(32)}`, evmLockTxHash: LOCK_TX, evmLockBlock: "12",
    evmDeadline: new Date(Date.now() + 3 * DAY), updatedAt: new Date(0), createdAt: new Date(0), ...overrides,
  };
  row.billingQuote = quoteFor(row);
  return row;
}

async function signPrediction(loanId: string, subject: string = BORROWER) {
  const modelRef = `loan:${loanId}`;
  const outputKind = contract.predictionOutputKind("logistic_regression");
  const domain = { name: contract.PREDICTION_DOMAIN_NAME, version: contract.PREDICTION_DOMAIN_VERSION, chainId: CHAIN_ID };
  const signedMessage = {
    modelRef, modelId: "logistic_regression", modelVersion: "1.0.0", subject: subject.toLowerCase(),
    featuresHash: keccak256(stringToHex(JSON.stringify(features))), outputKind, output: "1", counter: 3, sessionRevision: 0,
  };
  const signature = await runnerKey.signTypedData({
    domain, types: contract.PREDICTION_EIP712_TYPES, primaryType: "Prediction",
    message: { ...signedMessage, counter: BigInt(3), sessionRevision: BigInt(0) },
  } as never);
  return { modelRef, modelId: "logistic_regression", modelVersion: "1.0.0", outputKind, output: "1", counter: 3,
    signer: runnerKey.address, signature, domain, signedMessage };
}

interface SystemOptions {
  loans?: Row[];
  apiKeys?: Row[];
  /** Ligne `RunnerAvailability` ; `null` : pas de contrôleur (réputé allumé). */
  phase?: string | null;
  fast?: boolean;
  runner?: Partial<Record<"apiPredict" | "apiInfo" | "register" | "revoke" | "buyCalls" | "extend", (input: Row) => Promise<unknown>>>;
  /** `false` : aucune politique de facturation lisible côté Next (conteneur reaper). */
  policy?: false;
}

function system(options: SystemOptions = {}) {
  const loans = table(options.loans ?? [origin()], { touch: true });
  const apiKeys = table(options.apiKeys ?? []);
  const apiUsageDay = table([], {
    unique: (where) => (where.keyId_day ?? where) as Where,
    view: (row) => ({ ...row, key: apiKeys.rows.find((key) => key.id === row.keyId) ?? {} }),
  });
  const availability: Row[] = options.phase === null || options.phase === undefined ? [] : [{ id: 1, phase: options.phase, since: new Date(0), requestedUntil: null }];
  const runnerAvailability = table(availability);
  const datasets = table([{
    id: "dataset-1", status: "LISTED", provider: PROVIDER, evmDatasetId: `0x${"cd".repeat(32)}`, priceUsdcAtomic: PRICE_PER_DAY,
    ipfsCid: "bafy", wrappedKey: "wrapped", merkleRoot: `0x${"ee".repeat(32)}`, runnerReceipt: "dataset-receipt",
    modelId: "logistic_regression", modelVersion: "1.0.0", maxRentalDays: 30, challengeDays: 7, listingExpiresAt: null,
    runnerKind: "PHALA", runnerDeploymentId: "phala:1",
  }]);
  const prisma = { loan: loans, apiKey: apiKeys, apiUsageDay, runnerAvailability, dataset: datasets };
  const db = { prisma, serializableTransaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma) };
  const calls = { runner: [] as [string, Row][], stable: [] as string[], evidence: [] as string[], lockRequests: [] as Row[] };
  const record = (op: string, fallback: (input: Row) => Promise<unknown>) => async (input: Row) => {
    calls.runner.push([op, input]);
    const handler = options.runner?.[op as keyof NonNullable<SystemOptions["runner"]>];
    return handler ? handler(input) : fallback(input);
  };
  const runnerClient = {
    apiPredictInRunner: record("apiPredict", async (input) => ({
      ...(await signPrediction(String(input.loanId))), remaining: { today: 49, credits: 0 }, expiresAt: Date.now() + DAY,
    })),
    apiInfoInRunner: record("apiInfo", async (input) => ({
      loanId: input.loanId, modelId: "logistic_regression", modelVersion: "1.0.0", features: ["income", "debt"],
      expiresAt: Date.now() + DAY, remaining: { today: 50, credits: 0 },
    })),
    registerApiKeyInRunner: record("register", async (input) => ({ keyId: input.keyId, createdAt: Date.now() })),
    revokeApiKeyInRunner: record("revoke", async (input) => ({ keyId: input.keyId, revokedAt: Date.now() })),
    buyCallsInRunner: record("buyCalls", async () => ({ settleTxHash: PACK_TX, credits: 100 })),
    extendLoanInRunner: record("extend", async () => ({ settleTxHash: PACK_TX, expiresAt: Date.now() + 6 * DAY })),
    datasetIngressKeyInRunner: async () => ({ version: 1, publicKey: "ingress", origin: "runner" }),
    // Ce que signerait l'enclave : pack = taille × ceil(prix par jour / appels par jour), compute sans entraînement.
    prepareEscrowLockInRunner: async (dataset: Row, _receipt: string, loanId: string, borrower: string, _deadline: number, rental: Row) => {
      calls.lockRequests.push(rental);
      const perCall = (BigInt(String(dataset.priceUsdcAtomic)) + BigInt(49)) / BigInt(50);
      const datasetAmount = rental.callPack ? (BigInt(Number(rental.callPack)) * perCall).toString() : rentalRules.datasetAmountFor(String(dataset.priceUsdcAtomic), Number(rental.rentalDays));
      const hashlock = `0x${"ab".repeat(32)}`;
      return { hashlock, authorization: { deadline: 1 }, billingQuote: { quote: {
        loanId, datasetId: dataset.datasetId, borrower: borrower.toLowerCase(), onChainDatasetId: `0x${"cd".repeat(32)}`, hashlock,
        rentalDays: rental.rentalDays, datasetAmount, computeAmount: NO_TRAINING_COMPUTE, maxFailureFee: "0", usdcDecimals: DECIMALS, expiresAt: 1,
        ...(rental.callPack ? { callPack: rental.callPack, packForLoanId: rental.packForLoanId } : {}),
      }, authorization: { deadline: 1, signature: "0x" } } };
    },
  };
  const client = {
    getTransactionReceipt: async () => ({ status: "success", blockNumber: BigInt(10) }),
    getBlock: async () => ({ timestamp: BigInt(0) }),
    readContract: async () => true,
    getBlockNumber: async () => BigInt(20),
  };
  const config = fastFinality.fastFinalityConfig(options.fast ? { SIRIUS_FAST_FINALITY: "true" } : {}, DECIMALS);
  const errors = { AppError, errorResponse };
  const provenance = { assertCurrentRunner: async () => ({ runnerKind: "PHALA", runnerDeploymentId: "phala:1" }) };
  const billingLoan = { loanBillingQuote: (loan: Row) => loan.billingQuote ? JSON.parse(String(loan.billingQuote)) : undefined };

  const rental = load<typeof import("./rental")>("src/lib/sirius/rental.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/evm/client": { getPublicClient: () => client }, "@/lib/billing/rental": rentalRules,
  });
  const availabilityModule = load<typeof import("./availability")>("src/lib/sirius/availability.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": errors,
  });
  const finalityTier = load<typeof import("./finality-tier")>("src/lib/sirius/finality-tier.ts", {
    "server-only": {}, "@/lib/errors": errors, "@/lib/db": db,
    "@/lib/evm/finality": { fastFinalityPolicy: () => config }, "@/lib/evm/fast-finality": fastFinality,
  });
  const releaseTier = load<typeof import("./release-tier")>("src/lib/sirius/release-tier.ts", {
    "server-only": {}, "@/lib/evm/client": { getPublicClient: () => client },
    "@/lib/evm/escrow": { readLoan: async (key: string) => {
      const row = loans.rows.find((loan) => loan.evmLoanKey === key);
      return row ? { amountUsdcAtomic: row.amountUsdcAtomic } : null;
    } },
    "@/lib/evm/finality": { assertLockStable: async (_client: unknown, _ref: unknown, tier: string) => { calls.stable.push(tier); } },
    "./finality-tier": finalityTier,
  });
  const apiKeysModule = load<typeof import("./api-keys")>("src/lib/sirius/api-keys.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/billing/config": { billingEnabled: () => true, billingPolicy: () => {
      if (options.policy === false) throw new Error("Politique de facturation absente");
      return { apiCallsPerDay: API_CALLS_PER_DAY, noTrainingComputeAmount: NO_TRAINING_COMPUTE };
    } },
    "@/lib/billing/api-pricing": apiPricing, "@/lib/models/registry": models, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": provenance,
    "@/lib/tee/contract": contract, "@/lib/tee/runner-client": runnerClient, "./access": { requireAcceptedKyb: async () => {} },
    "./availability": availabilityModule, "./finality-tier": finalityTier, "./rental": rental,
  });
  const prediction = load<typeof import("./prediction")>("src/lib/sirius/prediction.ts", {
    "server-only": {}, viem, "@/lib/errors": errors, "@/lib/tee/contract": contract,
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: CHAIN_ID, escrow: OTHER }) },
    "@/lib/phala-demo/controller-client": { requestDemoController: async () => { throw new Error("démo inattendue"); } },
    "@/lib/sirius/self-training-access": { phalaDemoInstance: () => false },
  });
  const publicApi = load<typeof import("./public-api")>("src/lib/sirius/public-api.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": errors, "@/lib/http/body": { readBody },
    "@/lib/http/rate-limit": rateLimit, "@/lib/models/registry": models, "@/lib/tee/contract": contract,
    "@/lib/tee/runner-client": runnerClient, "./api-keys": apiKeysModule, "./availability": availabilityModule,
    "./finality-tier": finalityTier, "./prediction": prediction, "./self-training-access": { phalaDemoInstance: () => false },
  });
  const noLimit = { FixedWindowRateLimiter: class {}, enforceRateLimit: () => {} };
  const session: { address: string } = { address: BORROWER };
  const auth = {
    // Adresse vide : requête sans session, refusée avant tout contrôle comme par la vraie garde.
    requireAuth: () => {
      if (!session.address) throw new AppError("Authentification requise", 401);
      return session;
    },
    assertAuthenticGrant: async () => {},
    assertOwner: (current: typeof session, owner: string) => {
      if (!addresses.addressesEqual(current.address, owner)) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
    },
  };
  const borrower = load<typeof import("./borrower")>("src/lib/sirius/borrower.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/evm/addresses": { datasetRegistryAddress: () => PROVIDER, escrowAddress: () => PROVIDER },
    "@/lib/evm/abi/siriusdatasetregistry": {}, "@/lib/evm/client": { getPublicClient: () => client },
    "@/lib/evm/deployment": { requireCurrentEvmDeployment: async () => {} },
    "@/lib/evm/loan-key": { loanKeyFor: () => `0x${"88".repeat(32)}` }, "@/lib/evm/escrow": { readLoan: async () => null },
    "@/lib/evm/transaction": { approveUsdcTransaction: (amount: string) => ({ amount }), lockUsdcTransaction: () => ({}), lockQuotedUsdcTransaction: () => ({ lock: true }) },
    "@/lib/billing/config": { billingEnabled: () => true },
    "@/lib/billing/quote": {
      computeQuoteHash: () => `0x${"bb".repeat(32)}`, requireRentalQuote: (quote: Row) => quote,
      totalQuoteAmount: (quote: { datasetAmount: string; computeAmount: string }) => (BigInt(quote.datasetAmount) + BigInt(quote.computeAmount)).toString(),
    },
    "@/lib/billing/loan": { ...billingLoan, verifyPreparedComputeQuote: async (signed: unknown) => signed, assertBilledLock: () => {} },
    "@/lib/tee/runner-client": runnerClient, "./lock-policy": { lockAuthorizationDeadline: () => 1 },
    "@/lib/models/registry": models, "./access": { requireAcceptedKyb: async () => {}, requireCounterpartyKyb: async () => {} },
    "./provider": { BORROWABLE_STATUSES: ["LISTED"], isBorrowableDatasetStatus: () => true },
    "@/lib/datasets/manage": { isListingExpired: () => false },
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: CHAIN_ID, escrow: PROVIDER }) },
    "./recover-loan": {}, "@/lib/evm/history": {}, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": provenance,
    "./exposure-limits": { assertAdmissionsOpen: () => {}, assertExposureWithinCap: () => {}, assertLoanWithinCap: () => {}, EXPOSED_LOAN_STATUSES: [], exposureLimits: () => null },
    "@/lib/billing/rental": rentalRules, "./rental": rental, "@/lib/billing/api-pricing": apiPricing, "./api-keys": apiKeysModule,
    "./availability": availabilityModule,
  });
  const chain = { state: "active" as const };
  const shared = {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/evm/escrow": { reconcileLoanEscrow: async () => chain }, "@/lib/billing/loan": billingLoan,
    "@/lib/models/registry": models, "@/lib/runner/failure-policy": failurePolicy, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": provenance,
    "@/lib/tee/runner-client": runnerClient, "@/lib/loans/settlement-status": settlementStatus, "./borrower": borrower,
    "./release-tier": releaseTier, "./settlement-evidence": { recordSettlementEvidence: async (id: string) => { calls.evidence.push(id); return true; } },
    "./settlement-queued": { settlementQueuedError },
  };
  const callsModule = load<typeof import("./calls")>("src/lib/sirius/calls.ts", { ...shared, "./api-keys": apiKeysModule, "./availability": availabilityModule, "./rental": rental });
  const extend = load<typeof import("./extend")>("src/lib/sirius/extend.ts", { ...shared, "./rental": rental });
  const routes = {
    predict: load<typeof import("../../app/api/v1/models/[loanId]/predict/route")>("src/app/api/v1/models/[loanId]/predict/route.ts", { "@/lib/sirius/public-api": publicApi }),
    info: load<typeof import("../../app/api/v1/models/[loanId]/route")>("src/app/api/v1/models/[loanId]/route.ts", { "@/lib/sirius/public-api": publicApi }),
    keys: load<typeof import("../../app/api/loans/[id]/api-keys/route")>("src/app/api/loans/[id]/api-keys/route.ts", {
      "next/server": { NextResponse }, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson }, "@/lib/http/rate-limit": noLimit,
      "@/lib/sirius/api-keys": apiKeysModule, "@/lib/sirius/availability": availabilityModule,
    }),
    key: load<typeof import("../../app/api/loans/[id]/api-keys/[keyId]/route")>("src/app/api/loans/[id]/api-keys/[keyId]/route.ts", {
      "next/server": { NextResponse }, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson }, "@/lib/http/rate-limit": noLimit,
      "@/lib/sirius/api-keys": apiKeysModule, "@/lib/sirius/availability": availabilityModule,
    }),
    calls: load<typeof import("../../app/api/loans/[id]/calls/route")>("src/app/api/loans/[id]/calls/route.ts", {
      "next/server": { NextResponse }, "@/lib/db": db, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson },
      "@/lib/http/rate-limit": noLimit, "@/lib/billing/api-pricing": apiPricing, "@/lib/runner/failure-policy": failurePolicy,
      "@/lib/loans/settlement-status": settlementStatus, "@/lib/sirius/availability": availabilityModule, "@/lib/sirius/calls": callsModule,
    }),
    loans: load<typeof import("../../app/api/loans/route")>("src/app/api/loans/route.ts", {
      "next/server": { NextResponse }, "@/lib/db": db, "@/lib/sirius/borrower": borrower, "@/lib/auth/require-auth": auth,
      "@/lib/errors": errors, "@/lib/http/body": { readJson }, "@/lib/billing/loan": billingLoan, "@/lib/http/rate-limit": noLimit,
      "@/lib/billing/rental": rentalRules, "@/lib/sirius/api-keys": apiKeysModule, "@/lib/sirius/availability": availabilityModule,
    }),
  };
  const reaper = () => load<typeof import("./reaper")>("src/lib/sirius/reaper.ts", {
    "server-only": {}, "@/lib/db": db,
    "@/lib/evm/escrow": { readLoan: async () => null, reconcileLoanEscrow: async () => chain },
    "@/lib/evm/client": { getPublicClient: () => client },
    "./reaper-policy": reaperPolicy, "./reaper-errors": reaperErrors,
    "./recover-loan": { recoverUnsubmittedLoan: async () => {} },
    "@/lib/evm/history": { resolveLoanEscrow: async () => ({}) },
    "./settle": { recoverLoanResult: async () => false, settlePreparedLoan: async () => { throw new Error("règlement ordinaire inattendu"); } },
    "./fast-settlement-review": { verifyFastSettlement: async () => ({ state: "pending" }) },
    "@/lib/runner/failure-policy": failurePolicy, "@/lib/app-error": { AppError }, "@/lib/models/registry": models,
    "./extend": extend, "./calls": callsModule, "./rental": rental, "@/lib/loans/settlement-status": settlementStatus,
  });

  const signedHeaders = (keyId = KEY_ID) => ({
    "sirius-key": keyId, "sirius-timestamp": String(Math.floor(Date.now() / 1000)),
    "sirius-nonce": `nonce-${Math.random().toString(36).slice(2).padEnd(12, "x")}`, "sirius-signature": "a".repeat(64),
  });
  const api = {
    predict: (body: string = JSON.stringify({ features }), headers: Record<string, string> = signedHeaders(), loanId = "loan-1") => routes.predict.POST(
      new Request(`https://test.invalid/api/v1/models/${loanId}/predict`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }),
      { params: Promise.resolve({ loanId }) },
    ),
    info: (headers: Record<string, string> = signedHeaders(), loanId = "loan-1") => routes.info.GET(
      new Request(`https://test.invalid/api/v1/models/${loanId}`, { headers }),
      { params: Promise.resolve({ loanId }) },
    ),
  };
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const manage = {
    list: (id = "loan-1") => routes.keys.GET(new Request(`https://test.invalid/api/loans/${id}/api-keys`), { params: Promise.resolve({ id }) }),
    create: (body: unknown, id = "loan-1") => routes.keys.POST(new Request(`https://test.invalid/api/loans/${id}/api-keys`, json("POST", body)), { params: Promise.resolve({ id }) }),
    revoke: (keyId: string, id = "loan-1") => routes.key.DELETE(
      new Request(`https://test.invalid/api/loans/${id}/api-keys/${keyId}`, json("DELETE", { authorization: { payload: {}, signature: "signed" } })),
      { params: Promise.resolve({ id, keyId }) },
    ),
    calls: (body: unknown, id = "loan-1") => routes.calls.POST(new Request(`https://test.invalid/api/loans/${id}/calls`, json("POST", body)), { params: Promise.resolve({ id }) }),
    quote: (body: unknown) => routes.loans.POST(new Request("https://test.invalid/api/loans", json("POST", body))),
  };
  return { prisma, calls, session, api, manage, signedHeaders, extend, callsModule, reaper };
}

const activeKey = (overrides: Row = {}): Row => ({ id: KEY_ID, loanId: "loan-1", owner: BORROWER.toLowerCase(), name: "prod", createdAt: new Date(0), revokedAt: null, lastUsedAt: null, ...overrides });
const envelope = { version: 1, ephemeralPublicKey: "epk", salt: "salt", iv: "iv", ciphertext: "cipher" };
const grant = { payload: {}, signature: "signed" };

// --- Adresse publique -------------------------------------------------------------------------

test("proxy : l'hôte API réécrit /v1/... vers /api/v1/..., tout autre chemin y répond 404 JSON", async () => {
  assert.equal(isApiHost("api.sirius-data.tech"), true);
  assert.equal(isApiHost("API.sirius-data.tech:443"), true);
  assert.equal(isApiHost("api.sirius-data.tech.evil.com"), false);
  assert.equal(isApiHost("sirius-data.tech"), false);
  assert.equal(apiHostPath("/v1/models/loan-1/predict"), "/api/v1/models/loan-1/predict");
  for (const path of ["/", "/train", "/api/loans", "/api/v1/models/x", "/v1/../api/loans", "/v1//models", "/v1/models/"]) assert.equal(apiHostPath(path), null, path);

  const onApiHost = (path: string, method = "POST") => proxy(new NextRequest(`https://api.sirius-data.tech${path}`, { method, headers: { host: "api.sirius-data.tech" } }));
  const rewritten = await onApiHost("/v1/models/loan-1/predict");
  assert.equal(new URL(rewritten.headers.get("x-middleware-rewrite")!).pathname, "/api/v1/models/loan-1/predict");
  assert.equal(new URL((await onApiHost("/v1/models/loan-1", "GET")).headers.get("x-middleware-rewrite")!).pathname, "/api/v1/models/loan-1");
  for (const path of ["/", "/train", "/api/loans", "/api/v1/models/loan-1/predict", "/v1"]) {
    const response = await onApiHost(path, "GET");
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("x-middleware-rewrite"), null, path);
    assert.deepEqual(await response.json(), { error: { code: "not_found", message: "Route inconnue" } }, path);
  }
  // Ailleurs, /api/v1/* reste joignable directement, sans réécriture.
  const direct = await proxy(new NextRequest("https://staging.sirius-data.tech/api/v1/models/loan-1/predict", { method: "POST", headers: { host: "staging.sirius-data.tech" } }));
  assert.equal(direct.headers.get("x-middleware-rewrite"), null);
  assert.equal(direct.headers.get("x-middleware-next"), "1");
});

// --- API publique -----------------------------------------------------------------------------

test("prédiction publique : requête brute relayée à l'enclave (chemin public, corps exact), réponse revalidée, usage journalisé", async () => {
  const sys = system({ apiKeys: [activeKey()] });
  const body = `{ "features" : {"income": 45000, "debt": 12} }`;
  const headers = sys.signedHeaders();
  const response = await sys.api.predict(body, headers);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.decision, "1");
  assert.equal(result.outputKind, "decision");
  assert.equal(result.counter, 3);
  assert.deepEqual(result.remaining, { today: 49, credits: 0 });
  assert.equal(typeof result.expiresAt, "string");
  assert.equal(result.signer, runnerKey.address);
  assert.equal(result.modelId, "logistic_regression");
  assert.equal(sys.calls.runner.length, 1);
  const [op, input] = sys.calls.runner[0];
  assert.equal(op, "apiPredict");
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    loanId: "loan-1", keyId: KEY_ID, timestamp: Number(headers["sirius-timestamp"]), nonce: headers["sirius-nonce"],
    signature: headers["sirius-signature"], method: "POST", path: "/v1/models/loan-1/predict", body,
    loanReceipt: "loan-receipt", settleTxHash: SETTLE_TX, finalityTier: "FULL",
  });
  const usage = sys.prisma.apiUsageDay.rows;
  assert.equal(usage.length, 1);
  assert.equal(usage[0].calls, 1);
  assert.ok(sys.prisma.apiKey.rows[0].lastUsedAt instanceof Date);

  const info = await sys.api.info();
  assert.equal(info.status, 200);
  assert.deepEqual((await info.json()).features, ["income", "debt"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sys.calls.runner[1][1])).path, "/v1/models/loan-1");
  assert.equal(sys.calls.runner[1][1].method, "GET");
  assert.equal(sys.calls.runner[1][1].body, "");
});

test("prédiction publique : une réponse d'enclave falsifiée ne sort pas", async () => {
  const sys = system({ apiKeys: [activeKey()], runner: {
    apiPredict: async (input) => ({ ...(await signPrediction(String(input.loanId), OTHER)), remaining: { today: 1, credits: 0 }, expiresAt: Date.now() + DAY }),
  } });
  const response = await sys.api.predict();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "runner_error");
});

test("prédiction publique : codes du runner rendus tels quels en { error: { code, message } } avec le bon statut", async () => {
  const cases: [string, number, string][] = [
    ["invalid_signature", 401, "Signature invalide"],
    ["request_expired", 401, "Requête expirée"],
    ["replayed_request", 409, "Requête rejouée"],
    ["key_revoked", 401, "Clé API révoquée"],
    ["unknown_key", 401, "Clé API inconnue"],
    ["rental_expired", 403, "Location expirée"],
    ["quota_exceeded", 429, "Quota épuisé"],
    ["api_not_available_for_profile", 409, "API indisponible"],
    ["invalid_features", 400, "Variables invalides"],
  ];
  for (const [code, status, message] of cases) {
    const sys = system({ apiKeys: [activeKey()], runner: { apiPredict: async () => { throw new AppError(message, status, code); } } });
    const response = await sys.api.predict();
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: { code, message } }, code);
    // Refus après authentification (quota, variables, location, profil) comptés ; signature ou clé, jamais.
    const refused = sys.prisma.apiUsageDay.rows[0]?.refused ?? 0;
    assert.equal(refused, ["quota_exceeded", "invalid_features", "rental_expired", "api_not_available_for_profile"].includes(code) ? 1 : 0, code);
    assert.equal(sys.prisma.apiUsageDay.rows[0]?.calls ?? 0, 0, code);
  }
  const down = system({ apiKeys: [activeKey()], runner: { apiPredict: async () => { throw new AppError("Runner confidentiel indisponible", 503); } } });
  const response = await down.api.predict();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "runner_unavailable", message: "Runner confidentiel indisponible" } });
});

test("prédiction publique : refus côté Next avant l'enclave (en-têtes, clé, prêt, corps)", async () => {
  const sys = system({
    loans: [origin(), origin({ id: "loan-2" }), attached("pack", { status: "SETTLED" })],
    apiKeys: [activeKey(), activeKey({ id: OTHER_KEY_ID, loanId: "loan-2" }), activeKey({ id: "CCCCCCCCCCCCCCCCCCCCCC", revokedAt: new Date(1) })],
  });
  const expect = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).error.code, code);
  };
  const { "sirius-signature": _signature, ...unsigned } = sys.signedHeaders();
  await expect(await sys.api.predict(undefined, unsigned), 401, "invalid_signature");
  await expect(await sys.api.predict(undefined, { ...sys.signedHeaders(), "sirius-signature": "A".repeat(64) }), 401, "invalid_signature");
  await expect(await sys.api.predict(undefined, { ...sys.signedHeaders(), "sirius-key": "sk_live_x" }), 401, "invalid_signature");
  await expect(await sys.api.predict(undefined, sys.signedHeaders("DDDDDDDDDDDDDDDDDDDDDD")), 401, "unknown_key");
  await expect(await sys.api.predict(undefined, sys.signedHeaders(OTHER_KEY_ID)), 401, "unknown_key");
  await expect(await sys.api.predict(undefined, sys.signedHeaders("CCCCCCCCCCCCCCCCCCCCCC")), 401, "key_revoked");
  await expect(await sys.api.predict(JSON.stringify({ features, extra: 1 })), 400, "invalid_features");
  await expect(await sys.api.predict(JSON.stringify({ features: { a: "1" } })), 400, "invalid_features");
  await expect(await sys.api.predict("pas du json"), 400, "invalid_features");
  await expect(await sys.api.predict(JSON.stringify({ features: { a: 1 }, pad: "x".repeat(17_000) })), 413, "payload_too_large");
  assert.equal(sys.calls.runner.length, 0, "aucun appel à l'enclave");

  const expired = system({ loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) })], apiKeys: [activeKey()] });
  await expect(await expired.api.predict(), 403, "rental_expired");
  assert.equal(expired.calls.runner.length, 0);
});

test("CVM pas encore allumée : 503 enclave_starting avec Retry-After, sans appel ni réveil anonyme", async () => {
  for (const [phase, status, retry] of [["starting", "starting", 60], ["stopped", "stopped", 120], ["stopping", "stopped", 120]] as const) {
    const sys = system({ phase, apiKeys: [activeKey()] });
    for (const response of [await sys.api.predict(), await sys.api.info()]) {
      assert.equal(response.status, 503, phase);
      assert.equal(response.headers.get("retry-after"), String(retry), phase);
      const body = await response.json();
      assert.equal(body.error.code, "enclave_starting", phase);
      assert.equal(body.code, "enclave_starting");
      assert.equal(body.status, status);
      assert.equal(body.retryAfterSeconds, retry);
      assert.equal(typeof body.message, "string");
    }
    assert.equal(sys.calls.runner.length, 0, phase);
    assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "un appel anonyme ne réveille jamais la CVM");
  }
  // Allumée : relayée normalement.
  const running = system({ phase: "running", apiKeys: [activeKey()] });
  assert.equal((await running.api.predict()).status, 200);
});

test("débit : 120 requêtes par minute et par clé, prédiction et description confondues", async () => {
  const sys = system({ loans: [origin(), origin({ id: "loan-2" })], apiKeys: [activeKey(), activeKey({ id: OTHER_KEY_ID, loanId: "loan-2" })] });
  for (let i = 0; i < 119; i++) assert.equal((await sys.api.info()).status, 200, `appel ${i + 1}`);
  assert.equal((await sys.api.predict()).status, 200, "120e appel");
  const limited = await sys.api.info();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal(sys.calls.runner.length, 120, "le 121e n'atteint pas l'enclave");
  // Une autre clé garde son propre budget.
  assert.equal((await sys.api.info(sys.signedHeaders(OTHER_KEY_ID), "loan-2")).status, 200);
});

// --- Gestion des clés -------------------------------------------------------------------------

test("clés API : création scellée dans l'enclave puis listée sans secret ; révocation idempotente", async () => {
  const sys = system();
  const prepared = await sys.manage.create({});
  assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { ingressKey: { version: 1, publicKey: "ingress", origin: "runner" } });
  const created = await sys.manage.create({ keyId: KEY_ID, name: " prod ", envelope, authorization: grant });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await created.json()).name, "prod");
  const [op, input] = sys.calls.runner[0];
  assert.equal(op, "register");
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    loanId: "loan-1", keyId: KEY_ID, envelope, loanReceipt: "loan-receipt", settleTxHash: SETTLE_TX, authorization: grant, finalityTier: "FULL",
  });
  assert.equal(sys.prisma.apiKey.rows.length, 1);
  // Rejeu (même clé) : pas de doublon.
  assert.equal((await sys.manage.create({ keyId: KEY_ID, name: "prod", envelope, authorization: grant })).status, 201);
  assert.equal(sys.prisma.apiKey.rows.length, 1);

  const list = await (await sys.manage.list()).json();
  assert.equal(list.callsPerDay, 50);
  assert.equal(list.enclave, "running");
  assert.deepEqual(list.keys.map((key: Row) => [key.keyId, key.name, key.revokedAt, key.calls30d]), [[KEY_ID, "prod", null, 0]]);
  assert.doesNotMatch(JSON.stringify(list), /cipher|secret/);

  const revoked = await sys.manage.revoke(KEY_ID);
  assert.equal(revoked.status, 200);
  const revokedAt = (await revoked.json()).revokedAt;
  assert.equal((await (await sys.manage.revoke(KEY_ID)).json()).revokedAt, revokedAt, "révocation rejouée : même date");
  assert.equal(sys.calls.runner.filter(([name]) => name === "revoke").length, 1);
});

test("clés API refusées à un autre compte, pour la régression linéaire, sur une location échue et au-delà de 5", async () => {
  const stranger = system({ apiKeys: [activeKey()] });
  stranger.session.address = OTHER;
  for (const response of [await stranger.manage.list(), await stranger.manage.create({}), await stranger.manage.create({ keyId: OTHER_KEY_ID, name: "x", envelope, authorization: grant }), await stranger.manage.revoke(KEY_ID)]) {
    assert.equal(response.status, 403);
  }
  assert.equal(stranger.calls.runner.length, 0);

  const linear = system({ loans: [origin({ modelId: "linear_regression" })] });
  for (const response of [await linear.manage.list(), await linear.manage.create({}), await linear.manage.create({ keyId: KEY_ID, name: "x", envelope, authorization: grant })]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "API indisponible pour la régression linéaire (le modèle serait reconstructible)");
  }
  assert.equal(linear.calls.runner.length, 0);

  const expired = system({ loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) })] });
  assert.equal((await expired.manage.create({ keyId: KEY_ID, name: "x", envelope, authorization: grant })).status, 403);
  assert.equal((await expired.manage.list()).status, 200, "la liste reste lisible après l'échéance");

  const full = system({ apiKeys: ["1", "2", "3", "4", "5"].map((n) => activeKey({ id: n.repeat(22) })) });
  const refused = await full.manage.create({ keyId: KEY_ID, name: "x", envelope, authorization: grant });
  assert.equal(refused.status, 409);
  assert.equal(full.calls.runner.length, 0);
  const malformed = system();
  assert.equal((await malformed.manage.create({ keyId: KEY_ID, name: "x", envelope: { ...envelope, extra: "1" }, authorization: grant })).status, 400);
});

test("action wallet de l'emprunteur, CVM éteinte : réveil demandé 15 min et 503 enclave_starting, rien relayé", async () => {
  const sys = system({ phase: "stopped" });
  const before = Date.now();
  const response = await sys.manage.create({});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "120");
  assert.equal((await response.json()).error.code, "enclave_starting");
  const until = sys.prisma.runnerAvailability.rows[0].requestedUntil as Date;
  assert.ok(until.getTime() >= before + 15 * 60_000 - 1000 && until.getTime() <= Date.now() + 15 * 60_000);
  // Achat d'appels : même réveil avant toute préparation (rien n'est payé).
  const pack = await sys.manage.calls({ size: 100 });
  assert.equal(pack.status, 503);
  assert.equal(sys.calls.lockRequests.length, 0);
  // Un autre compte ne réveille rien.
  const stranger = system({ phase: "stopped" });
  stranger.session.address = OTHER;
  assert.equal((await stranger.manage.create({})).status, 403);
  assert.equal(stranger.prisma.runnerAvailability.rows[0].requestedUntil, null);
});

// --- Réveil par le devis d'emprunt et la publication --------------------------------------------

const pendingLoan = (): Row => origin({
  id: "pending-1", status: "PENDING", evmLockTxHash: null, settleTxHash: null, runnerReceipt: null, modelCid: null,
  rentalExpiresAt: null, createdAt: new Date(), updatedAt: new Date(0),
});

test("devis d'emprunt, CVM éteinte : réveil 15 min et 503 enclave_starting, sans remplacer le PENDING ni réserver ; relance une fois allumée", async () => {
  const sys = system({ phase: "stopped", loans: [origin(), pendingLoan()] });
  const before = Date.now();
  const response = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "120");
  assert.equal((await response.json()).error.code, "enclave_starting");
  const until = sys.prisma.runnerAvailability.rows[0].requestedUntil as Date;
  assert.ok(until.getTime() >= before + 15 * 60_000 - 1000 && until.getTime() <= Date.now() + 15 * 60_000);
  assert.equal(sys.calls.lockRequests.length, 0, "aucun devis demandé à l'enclave");
  assert.deepEqual(sys.prisma.loan.rows.map((loan) => [loan.id, loan.status]), [["loan-1", "SETTLED"], ["pending-1", "PENDING"]]);

  // Même requête une fois la CVM allumée : un seul nouveau prêt, comme sans réveil.
  sys.prisma.runnerAvailability.rows[0].phase = "running";
  const retried = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 });
  assert.equal(retried.status, 201, await retried.clone().text());
  assert.equal(sys.calls.lockRequests.length, 1);
  assert.equal(sys.prisma.loan.rows.length, 3);
  assert.equal(sys.prisma.loan.rows.find((loan) => loan.id === "pending-1")!.status, "CANCELLED");
});

test("devis d'emprunt : requête anonyme, invalide ou refusée ne réveille pas la CVM ; CVM allumée : devis inchangé", async () => {
  const anonymous = system({ phase: "stopped" });
  anonymous.session.address = "";
  assert.equal((await anonymous.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 401);
  const invalid = system({ phase: "stopped" });
  assert.equal((await invalid.manage.quote({ rentalDays: 7 })).status, 400);
  assert.equal((await invalid.manage.quote({ datasetId: "dataset-1", rentalDays: 0 })).status, 400);
  assert.equal((await invalid.manage.quote({ datasetId: "dataset-1", rentalDays: 31 })).status, 400, "au-delà de maxRentalDays du dataset");
  assert.equal((await invalid.manage.quote({ datasetId: "absent", rentalDays: 7 })).status, 404);
  const ownDataset = system({ phase: "stopped" });
  ownDataset.session.address = PROVIDER;
  assert.equal((await ownDataset.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 400);
  for (const sys of [anonymous, invalid, ownDataset]) {
    assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null);
    assert.equal(sys.calls.lockRequests.length, 0);
  }

  for (const phase of ["running", null]) {
    const sys = system({ phase });
    const response = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 });
    assert.equal(response.status, 201, String(phase));
    assert.equal(sys.calls.lockRequests.length, 1);
    if (phase) assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "CVM allumée : aucun réveil écrit");
  }
});

/** `POST /api/datasets` réel (route, brouillon, pipeline) ; base, KYB et runner en mémoire. */
function publicationSystem(phase: string | null, options: { kybRefused?: boolean } = {}) {
  const datasets = table([]);
  const insert = datasets.create;
  // Valeur par défaut du schéma : un dataset naît brouillon.
  datasets.create = ({ data }) => insert({ data: { status: "DRAFT", ...data } });
  const runnerAvailability = table(phase === null ? [] : [{ id: 1, phase, since: new Date(0), requestedUntil: null }]);
  const prisma = { dataset: datasets, runnerAvailability };
  const db = { prisma, serializableTransaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma) };
  const calls = { ingress: 0 };
  const session: { address: string } = { address: PROVIDER };
  const runner = { runnerKind: "PHALA", runnerDeploymentId: "phala:1" };
  const availabilityModule = load<typeof import("./availability")>("src/lib/sirius/availability.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": { AppError, errorResponse },
  });
  const pipeline = load<typeof import("./pipeline")>("src/lib/sirius/pipeline.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/app-error": { AppError }, "@/lib/models/registry": models,
    "@/lib/tee/runner-client": { datasetIngressKeyInRunner: async () => { calls.ingress++; return { version: 1, publicKey: "ingress", origin: "runner" }; } },
    "@/lib/sirius/access": { requireAcceptedKyb: async () => { if (options.kybRefused) throw new AppError("KYB requis", 403); } },
    "@/lib/sirius/availability": availabilityModule, "@/lib/ipfs/pinata": {},
    "@/lib/runner/provenance": { currentRunnerProvenance: async () => runner, assertCurrentRunner: async () => runner },
  });
  const draft = load<typeof import("../datasets/draft")>("src/lib/datasets/draft.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/app-error": { AppError }, "@/lib/sirius/pipeline": pipeline, "./publication": publication,
  });
  const route = load<typeof import("../../app/api/datasets/route")>("src/app/api/datasets/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": db,
    "@/lib/auth/require-auth": { requireAuth: () => {
      if (!session.address) throw new AppError("Authentification requise", 401);
      return session;
    } },
    "@/lib/auth/session": {}, "@/lib/errors": { errorResponse }, "@/lib/http/body": { readJson }, "@/lib/sirius/reputation": {},
    "@/lib/sirius/dataset-response": {}, "@/lib/datasets/create-request": createRequest,
    "@/lib/sirius/chunked-upload": { requireChunkedUploads: () => {} }, "@/lib/datasets/draft": draft,
    "@/lib/billing/config": { billingEnabled: () => false }, "@/lib/datasets/tariff-server": { publishedTariff: () => null },
    "@/lib/evm/deployment": { requireCurrentEvmDeployment: async () => {} }, "@/lib/sirius/availability": availabilityModule,
  });
  const publish = (body: unknown) => route.POST(new Request("https://test.invalid/api/datasets", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { prisma, calls, session, pipeline, publish };
}

const publicationBody = {
  name: "Crédit", sizeBytes: 1200, priceUsdc: "10", category: publication.DATASET_CATEGORIES[0], maxRentalDays: 30,
  listingDays: 30, trainingConsent: false, modelId: "linear_regression",
};

test("publication, CVM éteinte : réveil 15 min et 503 enclave_starting sans brouillon ; la relance crée un seul brouillon", async () => {
  const sys = publicationSystem("stopped");
  const before = Date.now();
  const response = await sys.publish(publicationBody);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "120");
  assert.equal((await response.json()).error.code, "enclave_starting");
  const until = sys.prisma.runnerAvailability.rows[0].requestedUntil as Date;
  assert.ok(until.getTime() >= before + 15 * 60_000 - 1000 && until.getTime() <= Date.now() + 15 * 60_000);
  assert.equal(sys.prisma.dataset.rows.length, 0, "aucun brouillon tant que l'enclave démarre");
  assert.equal(sys.calls.ingress, 0);

  sys.prisma.runnerAvailability.rows[0].phase = "starting";
  assert.equal((await sys.publish(publicationBody)).status, 503);
  sys.prisma.runnerAvailability.rows[0].phase = "running";
  const created = await sys.publish(publicationBody);
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(sys.prisma.dataset.rows.length, 1);
  assert.equal(sys.calls.ingress, 1);

  // CVM arrêtée avant le scellement : même réveil, brouillon intact.
  const draft = sys.prisma.dataset.rows[0];
  const touched = draft.updatedAt;
  sys.prisma.runnerAvailability.rows[0].phase = "stopped";
  sys.prisma.runnerAvailability.rows[0].requestedUntil = null;
  await assert.rejects(sys.pipeline.authorizeDatasetUpload(String(draft.id), PROVIDER), (error: AppError) => error.status === 503);
  assert.ok(sys.prisma.runnerAvailability.rows[0].requestedUntil instanceof Date);
  assert.equal(draft.updatedAt, touched);
});

test("publication : requête anonyme, invalide ou sans KYB ne réveille pas la CVM ; CVM allumée : brouillon créé sans réveil", async () => {
  const anonymous = publicationSystem("stopped");
  anonymous.session.address = "";
  assert.equal((await anonymous.publish(publicationBody)).status, 401);
  const invalid = publicationSystem("stopped");
  assert.equal((await invalid.publish({ ...publicationBody, category: "" })).status, 400);
  assert.equal((await invalid.publish({ ...publicationBody, modelId: "inconnu" })).status, 400);
  assert.equal((await invalid.publish({ ...publicationBody, sizeBytes: 0 })).status, 413);
  const unverified = publicationSystem("stopped", { kybRefused: true });
  assert.equal((await unverified.publish(publicationBody)).status, 403);
  for (const sys of [anonymous, invalid, unverified]) {
    assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null);
    assert.equal(sys.prisma.dataset.rows.length, 0);
  }

  for (const phase of ["running", null]) {
    const sys = publicationSystem(phase);
    assert.equal((await sys.publish(publicationBody)).status, 201, String(phase));
    assert.equal(sys.prisma.dataset.rows.length, 1);
    if (phase) assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "CVM allumée : aucun réveil écrit");
  }
});

// --- Packs d'appels ---------------------------------------------------------------------------

test("pack d'appels : préparé au prix déduit du prix par jour, jours du prêt d'origine repris", async () => {
  const sys = system();
  const response = await sys.manage.calls({ size: 100 });
  assert.equal(response.status, 201, await response.clone().text());
  const prepared = await response.json();
  assert.deepEqual(JSON.parse(JSON.stringify(sys.calls.lockRequests)), [{ rentalDays: 7, callPack: 100, packForLoanId: "loan-1" }]);
  const pack = sys.prisma.loan.rows.find((row) => row.id === prepared.loanId)!;
  // 100 × ceil(1 000 001 / 50) = 100 × 20 001.
  assert.equal(pack.datasetAmountUsdcAtomic, "2000100");
  assert.equal(pack.computeAmountUsdcAtomic, NO_TRAINING_COMPUTE);
  assert.equal(pack.maxFailureFeeUsdcAtomic, "0");
  assert.equal(pack.amountUsdcAtomic, "2100100");
  assert.equal(pack.packForLoanId, "loan-1");
  assert.equal(pack.callPack, 100);
  assert.equal(pack.extendsLoanId, null);
  assert.deepEqual(prepared.approveTransaction, { amount: "2100100" });

  for (const size of [50, "100", 0]) assert.equal((await sys.manage.calls({ size })).status, 400, String(size));
  const linear = system({ loans: [origin({ modelId: "linear_regression" })] });
  assert.equal((await linear.manage.calls({ size: 100 })).status, 409);
  const stranger = system();
  stranger.session.address = OTHER;
  assert.equal((await stranger.manage.calls({ size: 100 })).status, 403);
  const expired = system({ loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) })] });
  assert.equal((await expired.manage.calls({ size: 1000 })).status, 403);
  assert.equal(linear.calls.lockRequests.length + stranger.calls.lockRequests.length + expired.calls.lockRequests.length, 0);
});

test("pack d'appels : règlement par le runner puis SETTLED, rejouable sans second crédit", async () => {
  const sys = system({ loans: [origin(), attached("pack")] });
  const settle = () => sys.manage.calls({ packLoanId: "pack-9", authorization: grant });
  const response = await settle();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { loanId: "pack-9", originalLoanId: "loan-1", settleTxHash: PACK_TX, callPack: 100, credits: 100 });
  const buys = sys.calls.runner.filter(([op]) => op === "buyCalls");
  assert.equal(buys.length, 1);
  const input = JSON.parse(JSON.stringify(buys[0][1]));
  assert.equal(input.loanId, "pack-9");
  assert.equal(input.originalLoanId, "loan-1");
  assert.equal(input.loanReceipt, "loan-receipt");
  assert.equal(input.lockBlock, "12");
  assert.deepEqual(input.authorization, grant);
  assert.equal(input.billingQuote.quote.packForLoanId, "loan-1");
  assert.equal(sys.prisma.loan.rows.find((row) => row.id === "pack-9")!.status, "SETTLED");
  const replay = await settle();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).settleTxHash, PACK_TX);
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1, "aucun second appel au runner");

  const foreign = system({ loans: [origin(), origin({ id: "loan-3" }), attached("pack", { packForLoanId: "loan-3" })] });
  assert.equal((await foreign.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 404);
  const stranger = system({ loans: [origin(), attached("pack")] });
  stranger.session.address = OTHER;
  assert.equal((await stranger.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 403);
  assert.equal(foreign.calls.runner.length + stranger.calls.runner.length, 0);
});

test("pack d'appels : release en attente de finalité ⇒ 202, runner en échec ⇒ retour à ESCROWED", async () => {
  const pending = system({ loans: [origin(), attached("pack")], runner: { buyCalls: async () => { throw new failurePolicy.RunnerFinalityPending(PACK_TX); } } });
  const response = await pending.manage.calls({ packLoanId: "pack-9", authorization: grant });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { pending: true, settleTxHash: PACK_TX, error: settlementStatus.CALLS_PENDING });
  const row = pending.prisma.loan.rows.find((loan) => loan.id === "pack-9")!;
  assert.equal(row.status, "SETTLING");
  assert.equal(row.settleTxHash, PACK_TX);

  const failing = system({ loans: [origin(), attached("pack")], runner: { buyCalls: async () => { throw new AppError("Runner confidentiel indisponible", 503); } } });
  assert.equal((await failing.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 503);
  assert.equal(failing.prisma.loan.rows.find((loan) => loan.id === "pack-9")!.status, "ESCROWED");
});

test("reaper : un pack verrouillé non réglé est repris sans autorisation ; location close ⇒ aucune reprise", async () => {
  const sys = system({ loans: [origin(), attached("pack")] });
  const pass = await sys.reaper().runLoanReaper(new Date());
  assert.equal(pass.failed, 0);
  const buys = sys.calls.runner.filter(([op]) => op === "buyCalls");
  assert.equal(buys.length, 1, "buy-calls rejoué par le reaper");
  assert.equal(buys[0][1].authorization, undefined, "chemin serveur, sans grant de l'emprunteur");
  assert.equal(sys.prisma.loan.rows.find((row) => row.id === "pack-9")!.status, "SETTLED");
  // Passe suivante : le pack réglé n'est plus rejoué.
  await sys.reaper().runLoanReaper(new Date());
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1);

  const closed = system({ loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) }), attached("pack")] });
  const closedPass = await closed.reaper().runLoanReaper(new Date());
  assert.equal(closedPass.failed, 0);
  assert.equal(closed.calls.runner.length, 0);
  assert.equal(closed.prisma.loan.rows.find((row) => row.id === "pack-9")!.status, "ESCROWED");

  const overdue = system({ loans: [origin(), attached("pack", { evmDeadline: new Date(Date.now() - 1) })] });
  await overdue.reaper().runLoanReaper(new Date());
  assert.equal(overdue.calls.runner.length, 0);
});

test("reaper : pack réglé sans politique de facturation dans l'environnement Next, le runner restant l'autorité", async () => {
  const sys = system({ loans: [origin(), attached("pack")], policy: false });
  const pass = await sys.reaper().runLoanReaper(new Date());
  assert.equal(pass.failed, 0);
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1);
  assert.equal(sys.prisma.loan.rows.find((row) => row.id === "pack-9")!.status, "SETTLED");

  // L'emprunteur, lui, reste soumis au contrôle de profil avant tout release.
  const signed = system({ loans: [origin(), attached("pack")], policy: false });
  assert.equal((await signed.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 409);
  assert.equal(signed.calls.runner.length, 0);
});

test("pack SETTLING avec release diffusé : terminé après l'échéance de la location, sans politique, scope toujours vérifié", async () => {
  const settling = (overrides: Row = {}) => attached("pack", { status: "SETTLING", settleTxHash: PACK_TX, updatedAt: new Date(0), ...overrides });
  const expired = { rentalExpiresAt: new Date(Date.now() - 1) };
  const sys = system({ loans: [origin(expired), settling()], policy: false });
  const pass = await sys.reaper().runLoanReaper(new Date());
  assert.equal(pass.failed, 0);
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1);
  assert.equal(sys.prisma.loan.rows.find((row) => row.id === "pack-9")!.status, "SETTLED");

  // Même chemin par l'emprunteur : la location échue n'empêche pas de finir le règlement.
  const borrower = system({ loans: [origin(expired), settling()] });
  assert.equal((await borrower.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 200);

  // Autre emprunteur ou autre dataset que le prêt d'origine : refus, aucun appel au runner.
  const foreign = system({ loans: [origin({ ...expired, borrower: OTHER }), settling()], policy: false });
  await assert.rejects(foreign.callsModule.settleCallPack("pack-9"), (error: AppError) => error.status === 403);
  const otherDataset = system({ loans: [origin({ ...expired, datasetId: "dataset-2" }), settling()], policy: false });
  await assert.rejects(otherDataset.callsModule.settleCallPack("pack-9"), (error: AppError) => error.status === 409);
  assert.equal(foreign.calls.runner.length + otherDataset.calls.runner.length, 0);
});

// --- Finalité rapide --------------------------------------------------------------------------

test("finalité rapide : prolongation et pack sous les plafonds passent au palier FAST, au-delà en finalité complète", async () => {
  for (const kind of ["extension", "pack"] as const) {
    const settle = (sys: ReturnType<typeof system>) => kind === "pack" ? sys.callsModule.settleCallPack("pack-9", grant as never) : sys.extend.settleLoanExtension("ext-9", grant as never);
    const op = kind === "pack" ? "buyCalls" : "extend";
    const id = kind === "pack" ? "pack-9" : "ext-9";

    // 5 USDC, sous le plafond unitaire (25) et total (100) : FAST, garde de profondeur au palier rapide.
    const fast = system({ fast: true, loans: [origin(), attached(kind)] });
    await settle(fast);
    assert.equal(fast.prisma.loan.rows.find((row) => row.id === id)!.finalityTier, "FAST", kind);
    assert.deepEqual(fast.calls.stable, ["FAST"], kind);
    assert.equal(fast.calls.runner.find(([name]) => name === op)![1].finalityTier, "FAST", kind);
    assert.deepEqual(fast.calls.evidence, [id], kind);

    // Plafond total déjà occupé par des prêts rapides en cours : finalité complète, champ absent.
    const busy = system({ fast: true, loans: [origin(), attached(kind), origin({ id: "inflight", status: "TRAINING", finalityTier: "FAST", amountUsdcAtomic: usdc("98") })] });
    await settle(busy);
    assert.equal(busy.prisma.loan.rows.find((row) => row.id === id)!.finalityTier, "FULL", kind);
    assert.deepEqual(busy.calls.stable, ["FULL"], kind);
    assert.equal("finalityTier" in busy.calls.runner.find(([name]) => name === op)![1], false, kind);

    // Au-delà du plafond unitaire : finalité complète.
    const large = system({ fast: true, loans: [origin(), attached(kind, { amountUsdcAtomic: usdc("26") })] });
    await settle(large);
    assert.equal(large.prisma.loan.rows.find((row) => row.id === id)!.finalityTier, "FULL", kind);

    // Coupe-circuit fermé : finalité complète, comme avant.
    const closed = system({ loans: [origin(), attached(kind)] });
    await settle(closed);
    assert.deepEqual(closed.calls.stable, ["FULL"], kind);
  }
});

test("GET /api/loans : champs API et packs exposés", async () => {
  const sys = system();
  const apiKeys = load<typeof import("./api-keys")>("src/lib/sirius/api-keys.ts", {
    "server-only": {}, "@/lib/db": { prisma: sys.prisma }, "@/lib/errors": { AppError }, "@/lib/evm/address": addresses,
    "@/lib/billing/config": { billingEnabled: () => true, billingPolicy: () => ({ apiCallsPerDay: API_CALLS_PER_DAY }) },
    "@/lib/billing/api-pricing": apiPricing, "@/lib/models/registry": models, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": {}, "@/lib/tee/contract": contract,
    "@/lib/tee/runner-client": {}, "./access": {}, "./availability": {}, "./finality-tier": {}, "./rental": {},
  });
  const rows = [origin(), origin({ id: "linear", modelId: "linear_regression" }), attached("pack"), attached("extension")];
  const route = load<typeof import("../../app/api/loans/route")>("src/app/api/loans/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": { prisma: { loan: { findMany: async () => rows } } },
    "@/lib/sirius/borrower": {}, "@/lib/auth/require-auth": { requireAuth: () => ({ address: BORROWER }) },
    "@/lib/errors": { errorResponse }, "@/lib/http/body": { readJson }, "@/lib/billing/loan": { loanBillingQuote: () => undefined },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => {} }, "@/lib/billing/rental": rentalRules,
    "@/lib/sirius/api-keys": apiKeys, "@/lib/sirius/availability": { loanRouteErrorResponse: errorResponse },
  });
  const body = await (await route.GET(new Request("https://test.invalid/api/loans"))).json();
  assert.deepEqual(body.map((loan: Row) => [loan.id, loan.apiEnabled, loan.callsPerDay, loan.callPack, loan.packForLoanId]), [
    ["loan-1", true, 50, null, null],
    ["linear", false, null, null, null],
    ["pack-9", false, null, 100, "loan-1"],
    ["ext-9", false, null, null, null],
  ]);
});
