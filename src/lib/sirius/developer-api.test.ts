import * as viem from "viem";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/app-error";
import * as profileAdmission from "@/lib/runner/profile-admission";
import { errorResponse } from "@/lib/errors";
import { readBody, readJson } from "@/lib/http/body";
import * as rateLimit from "@/lib/http/rate-limit";
import { hashRunnerIntent } from "@/lib/runner/authorization";
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
/** Tarif journalier de l'accès API (D-32) : 1,50 USDC ; part fournisseur d'un pass : 0,001 USDC. */
const API_ACCESS_DAILY_FEE = "1500000";
const PASS_PROVIDER_SHARE = "1000";

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

/**
 * Double de `wake-budget.ts` : mêmes plafonds et même `Retry-After` (fonctions réelles du module),
 * fenêtres tenues dans `store`, partageable entre « instances ». L'instruction SQL atomique elle-même
 * est éprouvée sur PostgreSQL, entre processus, dans `postgres.integration.test.ts`.
 */
function wakeBudgetDouble(store = new Map<string, { hourStart: Date; hourCount: number; dayStart: Date; dayCount: number }>()) {
  const real = load<typeof import("./wake-budget")>("src/lib/sirius/wake-budget.ts", { "server-only": {}, "@/lib/db": { prisma: {} } });
  const spendWakeBudget = async (subject: string, now: Date) => {
    const row = store.get(subject);
    const hourOpen = row !== undefined && row.hourStart.getTime() > now.getTime() - 3_600_000;
    const dayOpen = row !== undefined && row.dayStart.getTime() > now.getTime() - 86_400_000;
    if ((hourOpen && row.hourCount >= real.WAKE_WRITES_PER_HOUR) || (dayOpen && row.dayCount >= real.WAKE_WRITES_PER_DAY)) {
      return { spent: false as const, retryAfterSeconds: real.wakeRetryAfterSeconds(row!, now) };
    }
    store.set(subject, {
      hourStart: hourOpen ? row.hourStart : now, hourCount: hourOpen ? row.hourCount + 1 : 1,
      dayStart: dayOpen ? row.dayStart : now, dayCount: dayOpen ? row.dayCount + 1 : 1,
    });
    return { spent: true as const };
  };
  return { store, module: { spendWakeBudget } };
}

function origin(overrides: Row = {}): Row {
  return {
    id: "loan-1", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "SETTLED",
    modelId: "logistic_regression", modelVersion: "1.0.0", modelCid: FINGERPRINT, runnerReceipt: "loan-receipt",
    settleTxHash: SETTLE_TX, finalityReview: null, finalityTier: "FULL", rentalDays: 7, rentalExpiresAt: new Date(Date.now() + DAY),
    extendsLoanId: null, packForLoanId: null, callPack: null, apiAccessDays: null, apiPaidUntil: new Date(Date.now() + DAY),
    amountUsdcAtomic: usdc("7"), updatedAt: new Date(0), createdAt: new Date(0),
    runnerKind: "PHALA", runnerDeploymentId: "phala:1", ...overrides,
  };
}

function quoteFor(loan: Row): string {
  return JSON.stringify({ quote: {
    loanId: loan.id, datasetId: loan.datasetId, borrower: String(loan.borrower).toLowerCase(), rentalDays: 7,
    datasetAmount: loan.datasetAmountUsdcAtomic, computeAmount: NO_TRAINING_COMPUTE, maxFailureFee: "0",
    ...(loan.packForLoanId && loan.callPack ? { callPack: loan.callPack, packForLoanId: loan.packForLoanId } : {}),
    ...(loan.packForLoanId && loan.apiAccessDays ? { apiAccessDays: loan.apiAccessDays, packForLoanId: loan.packForLoanId } : {}),
    ...(loan.extendsLoanId ? { extendsLoanId: loan.extendsLoanId } : {}),
  }, authorization: { deadline: 1, signature: "0x" } });
}

/** Prêt rattaché verrouillé (ESCROWED, lock finalisé) : pack d'appels, pass d'accès API ou prolongation. */
function attached(kind: "pack" | "pass" | "extension", overrides: Row = {}): Row {
  const purchase = kind !== "extension";
  const row: Row = {
    id: kind === "pack" ? "pack-9" : kind === "pass" ? "pass-9" : "ext-9", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "ESCROWED",
    modelId: "logistic_regression", modelVersion: "1.0.0", modelCid: null, runnerReceipt: null, settleTxHash: null,
    finalityReview: null, finalityTier: "FULL", rentalDays: purchase ? 7 : 5, rentalExpiresAt: null,
    extendsLoanId: kind === "extension" ? "loan-1" : null, packForLoanId: purchase ? "loan-1" : null,
    callPack: kind === "pack" ? 100 : null, apiAccessDays: kind === "pass" ? 3 : null, apiPaidUntil: null,
    datasetAmountUsdcAtomic: kind === "pass" ? PASS_PROVIDER_SHARE : "2000100", amountUsdcAtomic: usdc("5"),
    evmLoanKey: `0x${(kind === "pack" ? "99" : kind === "pass" ? "97" : "98").repeat(32)}`, evmLockTxHash: LOCK_TX, evmLockBlock: "12",
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
  /** `false` : politique sans `apiAccessDailyComputeAmount` (accès API non vendu, D-32). */
  apiAccessFee?: false;
  /** Quotas API de la politique (par défaut `API_CALLS_PER_DAY`). */
  apiCallsPerDay?: Partial<Record<string, number>>;
  /** Jours que l'enclave signe dans le devis d'un pass. */
  passDays?: number;
  /** Résolution on-chain vue par le reaper selon le palier demandé (défaut : lock actif). */
  reaperChain?: (releaseTier: string) => Promise<unknown>;
  /** Résolution on-chain relue par `settleLoanPack`/`settleLoanExtension` après un échec du runner (défaut : lock actif) ; fonction : peut lever. */
  settleChain?: unknown;
  /** Hash du release vu on-chain à n'importe quelle profondeur (`releasedTxHashAnyDepth`, défaut : aucun). */
  releasedAnyDepth?: string | null;
  /** Verdict de la revue à finalité complète d'un release rapide (défaut : en attente). */
  fastVerdict?: unknown;
}

function system(options: SystemOptions = {}) {
  const loans = table(options.loans ?? [origin()], { touch: true });
  const apiKeys = table(options.apiKeys ?? []);
  const apiUsageDay = table([], {
    unique: (where) => (where.keyId_day ?? where) as Where,
    view: (row) => ({ ...row, key: apiKeys.rows.find((key) => key.id === row.keyId) ?? {} }),
  });
  const availability: Row[] = options.phase === null || options.phase === undefined ? [] : [{ id: 1, phase: options.phase, since: new Date(0), requestedUntil: null, validUntil: null }];
  const runnerAvailability = table(availability);
  const datasets = table([{
    id: "dataset-1", status: "LISTED", provider: PROVIDER, evmDatasetId: `0x${"cd".repeat(32)}`, priceUsdcAtomic: PRICE_PER_DAY,
    ipfsCid: "bafy", wrappedKey: "wrapped", merkleRoot: `0x${"ee".repeat(32)}`, runnerReceipt: "dataset-receipt",
    modelId: "logistic_regression", modelVersion: "1.0.0", maxRentalDays: 30, challengeDays: 7, listingExpiresAt: null,
    runnerKind: "PHALA", runnerDeploymentId: "phala:1",
  }]);
  const prisma = { loan: loans, apiKey: apiKeys, apiUsageDay, runnerAvailability, dataset: datasets,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma) };
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
      const passDays = rental.apiAccess ? options.passDays ?? 3 : undefined;
      const datasetAmount = passDays ? PASS_PROVIDER_SHARE
        : rental.callPack ? (BigInt(Number(rental.callPack)) * perCall).toString() : rentalRules.datasetAmountFor(String(dataset.priceUsdcAtomic), Number(rental.rentalDays));
      const hashlock = `0x${"ab".repeat(32)}`;
      // API incluse (D-32/D-33) : jours × tarif journalier ajoutés au compute, comme le signe l'enclave.
      const apiAccessAmount = rental.includeApiAccess ? apiPricing.apiAccessComputeAmount(API_ACCESS_DAILY_FEE, Number(rental.rentalDays)) : undefined;
      return { hashlock, authorization: { deadline: 1 }, billingQuote: { quote: {
        loanId, datasetId: dataset.datasetId, borrower: borrower.toLowerCase(), onChainDatasetId: `0x${"cd".repeat(32)}`, hashlock,
        rentalDays: rental.rentalDays, datasetAmount, usdcDecimals: DECIMALS, expiresAt: 1, maxFailureFee: "0",
        computeAmount: passDays ? apiPricing.apiAccessComputeAmount(API_ACCESS_DAILY_FEE, passDays)
          : apiAccessAmount ? (BigInt(NO_TRAINING_COMPUTE) + BigInt(apiAccessAmount)).toString() : NO_TRAINING_COMPUTE,
        ...(rental.callPack ? { callPack: rental.callPack, packForLoanId: rental.packForLoanId } : {}),
        ...(passDays ? { apiAccessDays: passDays, packForLoanId: rental.packForLoanId } : {}),
        ...(apiAccessAmount ? { apiAccessIncluded: true, apiAccessAmount } : {}),
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
  const wakeBudget = wakeBudgetDouble();
  const availabilityModule = load<typeof import("./availability")>("src/lib/sirius/availability.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": errors, "./wake-budget": wakeBudget.module,
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
      return { apiCallsPerDay: options.apiCallsPerDay ?? API_CALLS_PER_DAY, noTrainingComputeAmount: NO_TRAINING_COMPUTE,
        ...(options.apiAccessFee === false ? {} : { apiAccessDailyComputeAmount: API_ACCESS_DAILY_FEE }) };
    } },
    "@/lib/billing/api-pricing": apiPricing, "@/lib/models/registry": models, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": provenance,
    "@/lib/evm/networks": { resolveUsdcDecimals: () => DECIMALS },
    "@/lib/tee/contract": contract, "@/lib/tee/runner-client": runnerClient, "./access": { requireAcceptedKyb: async () => {} },
    "@/lib/runner/authorization": { hashRunnerIntent },
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
    "@/lib/evm/networks": { resolveUsdcDecimals: () => DECIMALS }, "./reaper-policy": reaperPolicy,
    "./availability": availabilityModule,
  });
  const chain = { state: "active" as const };
  const shared = {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/evm/escrow": {
      reconcileLoanEscrow: async () => typeof options.settleChain === "function" ? options.settleChain() : options.settleChain ?? chain,
      releasedTxHashAnyDepth: async () => options.releasedAnyDepth ?? null,
    },
    "@/lib/billing/loan": billingLoan,
    "@/lib/models/registry": models, "@/lib/runner/failure-policy": failurePolicy, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": provenance,
    "@/lib/tee/runner-client": runnerClient, "@/lib/loans/settlement-status": settlementStatus, "./borrower": borrower,
    "./release-tier": releaseTier, "./settlement-evidence": { recordSettlementEvidence: async (id: string) => { calls.evidence.push(id); return true; } },
    "./settlement-queued": { settlementQueuedError },
  };
  const callsModule = load<typeof import("./calls")>("src/lib/sirius/calls.ts", {
    ...shared, "@/lib/billing/api-pricing": apiPricing, "./api-keys": apiKeysModule, "./availability": availabilityModule, "./rental": rental,
  });
  const extend = load<typeof import("./extend")>("src/lib/sirius/extend.ts", { ...shared, "./rental": rental });
  const routes = {
    predict: load<typeof import("../../app/api/v1/models/[loanId]/predict/route")>("src/app/api/v1/models/[loanId]/predict/route.ts", { "@/lib/sirius/public-api": publicApi }),
    info: load<typeof import("../../app/api/v1/models/[loanId]/route")>("src/app/api/v1/models/[loanId]/route.ts", { "@/lib/sirius/public-api": publicApi }),
    keys: load<typeof import("../../app/api/loans/[id]/api-keys/route")>("src/app/api/loans/[id]/api-keys/route.ts", {
      "next/server": { NextResponse }, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson }, "@/lib/http/rate-limit": noLimit,
      "@/lib/sirius/api-keys": apiKeysModule, "@/lib/sirius/availability": availabilityModule, "@/lib/billing/api-pricing": apiPricing, "@/lib/errors": errors,
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
    run: load<typeof import("../../app/api/loans/[id]/run/route")>("src/app/api/loans/[id]/run/route.ts", {
      "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": errors, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson },
      "@/lib/runner/authorization": { hashRunnerIntent }, "@/lib/sirius/availability": availabilityModule, "@/lib/models/registry": models,
      // `prepareLoanResult` (settle.ts) : passage en TRAINING puis job ; tout appel est compté.
      "@/lib/sirius/settle": { prepareLoanResult: async (loanId: string) => {
        calls.runner.push(["runLoanJob", { loanId }]);
        return { loanId, modelCid: FINGERPRINT, runnerReceipt: "receipt" };
      } },
    }),
    settle: load<typeof import("../../app/api/loans/[id]/settle/route")>("src/app/api/loans/[id]/settle/route.ts", {
      "next/server": { NextResponse }, "@/lib/db": db, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson },
      "@/lib/http/rate-limit": noLimit, "@/lib/sirius/availability": availabilityModule, "@/lib/runner/failure-policy": failurePolicy,
      "@/lib/loans/settlement-status": settlementStatus, "@/lib/sirius/finality-tier": finalityTier,
      "@/lib/sirius/settle": { settlePreparedLoan: async (loanId: string) => {
        calls.runner.push(["settleLoan", { loanId }]);
        return { loanId, modelCid: FINGERPRINT, runnerReceipt: "receipt", settleTxHash: SETTLE_TX };
      } },
    }),
    extend: load<typeof import("../../app/api/loans/[id]/extend/route")>("src/app/api/loans/[id]/extend/route.ts", {
      "next/server": { NextResponse }, "@/lib/db": db, "@/lib/auth/require-auth": auth, "@/lib/http/body": { readJson },
      "@/lib/http/rate-limit": noLimit, "@/lib/sirius/availability": availabilityModule, "@/lib/sirius/rental": rental,
      "@/lib/billing/rental": rentalRules, "@/lib/runner/failure-policy": failurePolicy, "@/lib/loans/settlement-status": settlementStatus,
      "@/lib/sirius/extend": extend,
    }),
  };
  const reaper = () => load<typeof import("./reaper")>("src/lib/sirius/reaper.ts", {
    "server-only": {}, "@/lib/db": db,
    "@/lib/evm/escrow": {
      readLoan: async () => null,
      reconcileLoanEscrow: async (_key: unknown, _block: unknown, _binding: unknown, releaseTier = "FULL") => options.reaperChain ? options.reaperChain(releaseTier) : chain,
    },
    "@/lib/evm/client": { getPublicClient: () => client },
    "./reaper-policy": reaperPolicy, "./reaper-errors": reaperErrors, "@/lib/billing/api-pricing": apiPricing,
    "./recover-loan": { recoverUnsubmittedLoan: async () => {} },
    "@/lib/evm/history": { resolveLoanEscrow: async () => ({}) },
    "./settle": {
      recoverLoanResult: async (loanId: string) => { calls.runner.push(["recoverLoanJob", { loanId }]); return false; },
      settlePreparedLoan: async () => { throw new Error("règlement ordinaire inattendu"); },
    },
    "./fast-settlement-review": { verifyFastSettlement: async () => options.fastVerdict ?? { state: "pending" } },
    "@/lib/runner/failure-policy": failurePolicy, "@/lib/app-error": { AppError }, "@/lib/models/registry": models,
    "./extend": extend, "./calls": callsModule, "./rental": rental, "@/lib/loans/settlement-status": settlementStatus,
    "./finality-tier": finalityTier, "./availability": availabilityModule,
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
    revoke: (keyId: string, id = "loan-1", authorization: unknown = revokeGrant(id, keyId)) => routes.key.DELETE(
      new Request(`https://test.invalid/api/loans/${id}/api-keys/${keyId}`, json("DELETE", { authorization })),
      { params: Promise.resolve({ id, keyId }) },
    ),
    calls: (body: unknown, id = "loan-1") => routes.calls.POST(new Request(`https://test.invalid/api/loans/${id}/calls`, json("POST", body)), { params: Promise.resolve({ id }) }),
    quote: (body: unknown) => routes.loans.POST(new Request("https://test.invalid/api/loans", json("POST", body))),
    run: (id: string, authorization: unknown = runGrant(id)) => routes.run.POST(new Request(`https://test.invalid/api/loans/${id}/run`, json("POST", { authorization })), { params: Promise.resolve({ id }) }),
    settle: (id: string) => routes.settle.POST(new Request(`https://test.invalid/api/loans/${id}/settle`, json("POST", { authorization: grant })), { params: Promise.resolve({ id }) }),
    settleExtension: (extensionLoanId: string, id = "loan-1") => routes.extend.POST(
      new Request(`https://test.invalid/api/loans/${id}/extend`, json("POST", { extensionLoanId, authorization: grant })), { params: Promise.resolve({ id }) },
    ),
  };
  return { prisma, calls, session, api, manage, signedHeaders, extend, callsModule, reaper, wakeBudget: wakeBudget.store };
}

const activeKey = (overrides: Row = {}): Row => ({ id: KEY_ID, loanId: "loan-1", owner: BORROWER.toLowerCase(), name: "prod", createdAt: new Date(0), revokedAt: null, lastUsedAt: null, ...overrides });
const envelope = { version: 1, ephemeralPublicKey: "epk", salt: "salt", iv: "iv", ciphertext: "cipher" };
const grant = { payload: {}, signature: "signed" };
/** Grant de révocation au périmètre attendu par l'enclave (`revoke-api-key`, prêt, `[loanId, keyId]`). */
const revokeGrant = (loanId: string, keyId: string, overrides: Row = {}) => ({
  payload: { operation: "revoke-api-key", loanId, payloadHash: hashRunnerIntent([loanId, keyId]), ...overrides }, signature: "signed",
});
/** Grant `run-loan-job` au périmètre que vérifiera l'enclave (dataset `dataset-1` du harnais). */
const runGrant = (loanId: string, overrides: Row = {}) => ({
  payload: {
    operation: "run-loan-job", loanId, datasetId: "dataset-1",
    payloadHash: hashRunnerIntent([loanId, "dataset-1", "dataset-receipt", "logistic_regression", "1.0.0", "served"]), ...overrides,
  },
  signature: "signed",
});

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

test("CVM pas encore allumée, clé valide d'une location en cours : réveil 15 min et 503 enclave_starting avec Retry-After, rien relayé", async () => {
  for (const [phase, status, retry] of [["starting", "starting", 30], ["stopped", "stopped", 45], ["stopping", "stopped", 45]] as const) {
    const sys = system({ phase, apiKeys: [activeKey()] });
    const before = Date.now();
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
    const until = sys.prisma.runnerAvailability.rows[0].requestedUntil as Date;
    assert.ok(until.getTime() >= before + 15 * 60_000 - 1000 && until.getTime() <= Date.now() + 15 * 60_000, phase);
  }
  // Allumée : relayée normalement, et l'activité garde la CVM voulue.
  const running = system({ phase: "running", apiKeys: [activeKey()] });
  assert.equal((await running.api.predict()).status, 200);
  assert.ok(running.prisma.runnerAvailability.rows[0].requestedUntil instanceof Date);
});

test("CVM éteinte : en-têtes invalides, clé inconnue, révoquée ou d'un autre prêt, location échue ne réveillent rien", async () => {
  const REVOKED = "CCCCCCCCCCCCCCCCCCCCCC";
  const sys = system({
    phase: "stopped", loans: [origin(), origin({ id: "loan-2" })],
    apiKeys: [activeKey({ id: OTHER_KEY_ID, loanId: "loan-2" }), activeKey({ id: REVOKED, revokedAt: new Date(1) })],
  });
  assert.equal((await sys.api.predict(undefined, { ...sys.signedHeaders(), "sirius-signature": "" })).status, 401, "en-têtes invalides");
  assert.equal((await sys.api.predict(undefined, sys.signedHeaders())).status, 401, "clé inconnue");
  assert.equal((await sys.api.predict(undefined, sys.signedHeaders(OTHER_KEY_ID))).status, 401, "clé d'un autre prêt");
  assert.equal((await sys.api.info(sys.signedHeaders(REVOKED))).status, 401, "clé révoquée");
  assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null);

  const expired = system({ phase: "stopped", loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) })], apiKeys: [activeKey()] });
  assert.equal((await expired.api.predict()).status, 403);
  assert.equal(expired.prisma.runnerAvailability.rows[0].requestedUntil, null, "location échue");
  for (const sys2 of [sys, expired]) assert.equal(sys2.calls.runner.length, 0);
});

function availabilityHarness(rows: Row[], budget = wakeBudgetDouble()) {
  const runnerAvailability = table(rows);
  let writes = 0;
  const updateMany = runnerAvailability.updateMany;
  runnerAvailability.updateMany = async (args) => { writes++; return updateMany(args); };
  const db = { prisma: { runnerAvailability } };
  const availability = load<typeof import("./availability")>("src/lib/sirius/availability.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": { AppError, errorResponse },
    "./wake-budget": budget.module,
  });
  return { availability, rows, budget, writes: () => writes };
}
const availabilityRow = (requestedUntil: Date | null, phase = "running"): Row => ({ id: 1, phase, since: new Date(0), requestedUntil, validUntil: null });
const WAKE_NOW = new Date(Date.UTC(2026, 10, 8, 12));
const MINUTE = 60_000;

test("réveil : écrit seulement s'il reste moins de 10 min, quelle que soit la phase ; jamais raccourci ; sans contrôleur, rien", async () => {
  for (const phase of ["running", "stopped"]) {
    for (const [label, current] of [["aucun réveil", null], ["bientôt échu", new Date(WAKE_NOW.getTime() + 9 * MINUTE)], ["échu", new Date(WAKE_NOW.getTime() - MINUTE)]] as const) {
      const sys = availabilityHarness([availabilityRow(current, phase)]);
      await sys.availability.requireRunnerOrWake({ now: WAKE_NOW }).catch((error: AppError) => assert.equal(error.status, 503));
      assert.equal(sys.writes(), 1, `${phase} ${label}`);
      assert.equal((sys.rows[0].requestedUntil as Date).getTime(), WAKE_NOW.getTime() + sys.availability.RUNNER_WAKE_MS, label);
    }
    // Encore frais (plus de 10 min devant lui) : aucune écriture ; les relances d'une même attente n'écrivent pas.
    for (const minutes of [11, 15, 30]) {
      const fresh = new Date(WAKE_NOW.getTime() + minutes * MINUTE);
      const sys = availabilityHarness([availabilityRow(fresh, phase)]);
      await sys.availability.requireRunnerOrWake({ now: WAKE_NOW }).catch((error: AppError) => assert.equal(error.status, 503));
      assert.equal(sys.writes(), 0, `${phase} ${minutes} min`);
      assert.equal(sys.rows[0].requestedUntil, fresh);
    }
  }
  assert.equal(availabilityHarness([]).availability.ACTIVITY_REFRESH_MS, 5 * MINUTE);
  const none = availabilityHarness([]);
  await none.availability.requireRunnerOrWake({ now: WAKE_NOW, wakeSubject: BORROWER });
  assert.equal(none.writes(), 0, "sans ligne : aucun contrôleur, rien à écrire");
});

test("budget de réveil par compte : 6 écritures par heure ; au-delà, 429 sans écrire si éteinte, requête servie sans prolonger si allumée", async () => {
  const sys = availabilityHarness([availabilityRow(null, "stopped")]);
  const wake = (subject: string, at = WAKE_NOW) => sys.availability.requireRunnerOrWake({ now: at, wakeSubject: subject });
  for (let i = 0; i < 6; i++) {
    sys.rows[0].requestedUntil = null;
    await assert.rejects(wake(PROVIDER, new Date(WAKE_NOW.getTime() + i * MINUTE)), (error: AppError) => error.status === 503);
  }
  assert.equal(sys.writes(), 6);
  sys.rows[0].requestedUntil = null;
  await assert.rejects(wake(PROVIDER.toUpperCase().replace("0X", "0x")), (error: AppError & { retryAfterSeconds?: number }) =>
    error.status === 429 && error instanceof sys.availability.WakeRateLimited && error.retryAfterSeconds === 600);
  assert.equal(sys.writes(), 6, "budget épuisé : rien d'écrit");
  assert.equal(sys.rows[0].requestedUntil, null);
  // Un autre compte garde son budget.
  await assert.rejects(wake(BORROWER), (error: AppError) => error.status === 503);
  assert.equal(sys.writes(), 7);
  // CVM allumée, budget épuisé : la requête passe, sans prolongation.
  sys.rows[0].phase = "running";
  sys.rows[0].requestedUntil = null;
  await wake(PROVIDER);
  assert.equal(sys.writes(), 7);
  assert.equal(sys.rows[0].requestedUntil, null);
  // Allumée avec un réveil encore frais : rien à écrire, rien à refuser.
  sys.rows[0].requestedUntil = new Date(WAKE_NOW.getTime() + 14 * MINUTE);
  await wake(PROVIDER);
  assert.equal(sys.writes(), 7);
  // L'heure suivante, le budget horaire repart.
  sys.rows[0].phase = "stopped";
  sys.rows[0].requestedUntil = null;
  await assert.rejects(wake(PROVIDER, new Date(WAKE_NOW.getTime() + 61 * MINUTE)), (error: AppError) => error.status === 503);
  assert.equal(sys.writes(), 8);
});

test("budget de réveil : Retry-After calculé sur la fin de la fenêtre (au plus 600 s) ; CVM qui démarre déjà ⇒ 503, pas 429", async () => {
  const sys = availabilityHarness([availabilityRow(null, "stopped")]);
  for (let i = 0; i < 6; i++) {
    sys.rows[0].requestedUntil = null;
    await assert.rejects(sys.availability.requireRunnerOrWake({ now: WAKE_NOW, wakeSubject: PROVIDER }), (error: AppError) => error.status === 503);
  }
  sys.rows[0].requestedUntil = null;
  await assert.rejects(sys.availability.requireRunnerOrWake({ now: new Date(WAKE_NOW.getTime() + 55 * MINUTE), wakeSubject: PROVIDER }),
    (error: AppError & { retryAfterSeconds?: number }) => error.status === 429 && error.retryAfterSeconds === 300);
  // Un prêt en cours la fait déjà démarrer : le client attend avec le 503 habituel, sans rien écrire.
  for (const phase of ["starting"]) {
    sys.rows[0].phase = phase;
    await assert.rejects(sys.availability.requireRunnerOrWake({ now: new Date(WAKE_NOW.getTime() + 55 * MINUTE), wakeSubject: PROVIDER }),
      (error: AppError & { code?: string }) => error.status === 503 && error instanceof sys.availability.EnclaveStarting);
  }
  sys.rows[0].phase = "stopping";
  await assert.rejects(sys.availability.requireRunnerOrWake({ now: new Date(WAKE_NOW.getTime() + 55 * MINUTE), wakeSubject: PROVIDER }),
    (error: AppError) => error.status === 429);
  assert.equal(sys.writes(), 6);
  assert.equal(sys.rows[0].requestedUntil, null);
});

test("budget de réveil : partagé par les instances (lu en base à chaque requête, pas en mémoire)", async () => {
  const shared = wakeBudgetDouble();
  const first = availabilityHarness([availabilityRow(null, "stopped")], shared);
  for (let i = 0; i < 6; i++) {
    first.rows[0].requestedUntil = null;
    await assert.rejects(first.availability.requireRunnerOrWake({ now: WAKE_NOW, wakeSubject: PROVIDER }), (error: AppError) => error.status === 503);
  }
  // Nouvelle instance (module rechargé, aucun état en mémoire) : même budget, déjà épuisé.
  const second = availabilityHarness([availabilityRow(null, "stopped")], shared);
  await assert.rejects(second.availability.requireRunnerOrWake({ now: WAKE_NOW, wakeSubject: PROVIDER }), (error: AppError) => error.status === 429);
  assert.equal(second.writes(), 0);
  assert.deepEqual(shared.store.get(PROVIDER)?.hourCount, 6);
});

test("budget de réveil par compte : 12 écritures par jour, indépendamment du budget horaire", async () => {
  const sys = availabilityHarness([availabilityRow(null, "stopped")]);
  const at = (minutes: number) => new Date(WAKE_NOW.getTime() + minutes * MINUTE);
  for (const hour of [0, 1]) {
    for (let i = 0; i < 6; i++) {
      sys.rows[0].requestedUntil = null;
      await assert.rejects(sys.availability.requireRunnerOrWake({ now: at(hour * 61 + i), wakeSubject: PROVIDER }), (error: AppError) => error.status === 503);
    }
  }
  assert.equal(sys.writes(), 12);
  // Troisième heure : budget horaire neuf, mais journalier épuisé.
  sys.rows[0].requestedUntil = null;
  await assert.rejects(sys.availability.requireRunnerOrWake({ now: at(3 * 61), wakeSubject: PROVIDER }), (error: AppError) => error.status === 429);
  assert.equal(sys.writes(), 12);
  // Le lendemain, il repart.
  await assert.rejects(sys.availability.requireRunnerOrWake({ now: at(24 * 60 + 1), wakeSubject: PROVIDER }), (error: AppError) => error.status === 503);
  assert.equal(sys.writes(), 13);
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

/** Adresse client lue dans `X-Real-IP` (ingress de confiance) le temps de `fn`. */
async function withTrustedProxy(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.SIRIUS_TRUST_PROXY_HEADERS;
  process.env.SIRIUS_TRUST_PROXY_HEADERS = "true";
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.SIRIUS_TRUST_PROXY_HEADERS;
    else process.env.SIRIUS_TRUST_PROXY_HEADERS = previous;
  }
}
const randomKeyId = (i: number) => `z${String(i).padStart(21, "0")}`;
const ATTACKER_IP = "203.0.113.9";
const BORROWER_IP = "198.51.100.7";

test("débit (audit A F1, revue B) : des milliers d'identifiants inconnus ne touchent pas la fenêtre d'une vraie clé ; trafic invalide plafonné pour l'instance", async () => {
  const sys = system({ loans: [origin(), origin({ id: "loan-2" })], apiKeys: [activeKey(), activeKey({ id: OTHER_KEY_ID, loanId: "loan-2" })] });
  assert.equal((await sys.api.info()).status, 200, "clé authentifiée par l'enclave sur cette instance");
  // Plus que le plafond d'instance du trafic invalide (3 000), sans ingress de confiance.
  let refusedBeforeBase = 0;
  for (let i = 0; i < 3_100; i++) {
    const status = (await sys.api.info(sys.signedHeaders(randomKeyId(i)))).status;
    if (status === 429) refusedBeforeBase++;
    else if (status !== 401) assert.fail(`identifiant inconnu ${i} : ${status}`);
  }
  assert.equal(refusedBeforeBase, 100, "au-delà de 3 000 échecs par minute, refus avant la base");
  for (let i = 1; i < 120; i++) assert.equal((await sys.api.info()).status, 200, `appel légitime ${i + 1}`);
  assert.equal((await sys.api.info()).status, 429, "la vraie clé garde exactement sa fenêtre de 120");
  // Plafond plein : une clé que l'enclave n'a pas encore servie ici attend la minute suivante.
  assert.equal((await sys.api.info(sys.signedHeaders(OTHER_KEY_ID), "loan-2")).status, 429);
  assert.equal(sys.calls.runner.length, 120);
});

test("débit (audit A F1) : requêtes en échec limitées par IP avant la base ; identifiant inconnu gardé 30 s en cache négatif", async () => {
  await withTrustedProxy(async () => {
    const sys = system({ apiKeys: [activeKey()] });
    let lookups = 0;
    const findUnique = sys.prisma.apiKey.findUnique;
    sys.prisma.apiKey.findUnique = async (args) => { lookups++; return findUnique(args); };
    const from = (ip: string, keyId = KEY_ID) => ({ ...sys.signedHeaders(keyId), "x-real-ip": ip });
    // Même identifiant inconnu répété : une seule lecture en base.
    assert.equal((await sys.api.info(from(ATTACKER_IP, randomKeyId(0)))).status, 401);
    assert.equal((await sys.api.info(from(ATTACKER_IP, randomKeyId(0)))).status, 401);
    assert.equal(lookups, 1);
    // 60 échecs au total pour cette IP (les deux ci-dessus compris) : le 61e est refusé.
    for (let i = 1; i < 59; i++) assert.equal((await sys.api.info(from(ATTACKER_IP, randomKeyId(i)))).status, 401);
    const before = lookups;
    const blocked = await sys.api.info(from(ATTACKER_IP, randomKeyId(999)));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    assert.equal((await blocked.json()).error.code, "rate_limited");
    assert.equal(lookups, before, "IP au-delà de son budget : aucune lecture en base");
    // L'emprunteur, depuis une autre adresse, est servi ; sa fenêtre n'a rien perdu.
    for (let i = 0; i < 120; i++) assert.equal((await sys.api.info(from(BORROWER_IP))).status, 200, `appel ${i + 1}`);
    assert.equal(sys.calls.runner.length, 120);
  });
});

test("débit (audit A F2) : un keyId sans son secret (signature refusée par l'enclave) ne consomme pas la fenêtre de la clé", async () => {
  const FORGED = "b".repeat(64);
  const runner = { apiInfo: async (input: Row) => {
    if (input.signature === FORGED) throw new AppError("Signature de requête invalide", 401, "invalid_signature");
    return { loanId: input.loanId, modelId: "logistic_regression", modelVersion: "1.0.0", features: ["income", "debt"], expiresAt: Date.now() + DAY, remaining: { today: 50, credits: 0 } };
  } };
  const sys = system({ apiKeys: [activeKey()], runner });
  for (let i = 0; i < 200; i++) assert.equal((await sys.api.info({ ...sys.signedHeaders(), "sirius-signature": FORGED })).status, 401);
  for (let i = 0; i < 120; i++) assert.equal((await sys.api.info()).status, 200, `appel légitime ${i + 1}`);
  assert.equal((await sys.api.info()).status, 429);
  assert.equal(sys.prisma.apiUsageDay.rows.length, 0, "signature refusée : jamais journalisée");

  // Derrière l'ingress : l'IP qui envoie des signatures fausses est bornée, pas l'emprunteur.
  await withTrustedProxy(async () => {
    const behind = system({ apiKeys: [activeKey()], runner });
    const forged = () => behind.api.info({ ...behind.signedHeaders(), "sirius-signature": FORGED, "x-real-ip": ATTACKER_IP });
    for (let i = 0; i < 60; i++) assert.equal((await forged()).status, 401);
    assert.equal((await forged()).status, 429);
    assert.equal(behind.calls.runner.length, 60, "au-delà, rien ne part vers l'enclave");
    assert.equal((await behind.api.info({ ...behind.signedHeaders(), "x-real-ip": BORROWER_IP })).status, 200);
  });
});

test("débit (revue A) : attente de démarrage, runner saturé, débit de l'enclave et refus de location ne bloquent jamais l'IP d'une clé valide", async () => {
  await withTrustedProxy(async () => {
    let answered = 0;
    const sys = system({
      phase: "stopped",
      loans: [origin(), origin({ id: "loan-2", rentalExpiresAt: new Date(Date.now() - 1) })],
      apiKeys: [activeKey(), activeKey({ id: OTHER_KEY_ID, loanId: "loan-2" })],
      runner: { apiInfo: async (input) => {
        answered++;
        if (answered <= 70) throw new AppError("Runner saturé", 503);
        if (answered <= 140) throw new AppError("Trop de requêtes pour ce modèle", 429, "rate_limited");
        return { loanId: input.loanId, modelId: "logistic_regression", modelVersion: "1.0.0", features: ["income", "debt"], expiresAt: Date.now() + DAY, remaining: { today: 50, credits: 0 } };
      } },
    });
    const from = (keyId = KEY_ID, loanId = "loan-1") => sys.api.info({ ...sys.signedHeaders(keyId), "x-real-ip": BORROWER_IP }, loanId);
    const expect = async (status: number, code: string, keyId?: string, loanId?: string) => {
      for (let i = 0; i < 70; i++) {
        const response = await from(keyId, loanId);
        if (response.status !== status || (await response.json()).error.code !== code) assert.fail(`${code} ${i + 1} : ${response.status}`);
      }
    };
    await expect(503, "enclave_starting");
    sys.prisma.runnerAvailability.rows[0].phase = "running";
    await expect(503, "runner_busy");
    await expect(429, "rate_limited");
    await expect(403, "rental_expired", OTHER_KEY_ID, "loan-2");
    // Plus de 60 de chaque, depuis la même adresse : la requête signée valide passe.
    assert.equal((await from()).status, 200);
  });
});

test("débit (revue B) : IPv6 comptée par /64, seau overflow appliqué", async () => {
  assert.equal(rateLimit.clientNetworkKey("ip:2001:db8:1:2::a"), "ip6:2001:db8:1:2::/64");
  assert.equal(rateLimit.clientNetworkKey("ip:2001:0db8:0001:0002:ffff:1:2:3"), "ip6:2001:db8:1:2::/64");
  assert.equal(rateLimit.clientNetworkKey("ip:::1"), "ip6:0:0:0:0::/64");
  assert.equal(rateLimit.clientNetworkKey("ip:::ffff:192.0.2.1"), "ip:192.0.2.1");
  assert.equal(rateLimit.clientNetworkKey("ip:192.0.2.1"), "ip:192.0.2.1");

  const limiter = new rateLimit.FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 2, maxGlobal: 100, maxTrackedKeys: 2 });
  for (const key of ["a", "b", "c", "d"]) limiter.consume(key, 0);
  assert.equal(limiter.blockedBy("e", 1), "overflow", "places prises : une nouvelle clé tombe dans le seau commun, plein");
  assert.equal(limiter.blockedBy("a", 1), null);
  assert.equal(limiter.blockedBy("e", 60_001), null, "fenêtres échues : une place se libère");

  await withTrustedProxy(async () => {
    const sys = system({ apiKeys: [activeKey()] });
    let next = 0;
    const from = (ip: string) => sys.api.info({ ...sys.signedHeaders(randomKeyId(next++)), "x-real-ip": ip });
    for (let i = 0; i < 60; i++) assert.equal((await from(`2001:db8:1:2::${(i + 1).toString(16)}`)).status, 401);
    assert.equal((await from("2001:db8:1:2:ffff::1")).status, 429, "même /64, autre adresse : refusée");
    assert.equal((await from("2001:db8:1:3::1")).status, 401, "autre /64 : budget à part");
  });
});

test("corps invalide (audit A F3) : refusé avant tout réveil de la CVM, sans refus journalisé", async () => {
  const sys = system({ phase: "stopped", apiKeys: [activeKey()] });
  for (const [body, status, code] of [
    ["pas du json", 400, "invalid_features"],
    [JSON.stringify({ features: { a: "1" } }), 400, "invalid_features"],
    [JSON.stringify({ features, pad: "x".repeat(17_000) }), 413, "payload_too_large"],
  ] as const) {
    const response = await sys.api.predict(body);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "aucun réveil");
  assert.equal(sys.prisma.apiUsageDay.rows.length, 0, "refus de Next : jamais compté comme refus authentifié");
  assert.equal(sys.calls.runner.length, 0);
  // Corps valide : réveil et 503 enclave_starting, comme avant.
  assert.equal((await sys.api.predict()).status, 503);
  const woken: unknown = sys.prisma.runnerAvailability.rows[0].requestedUntil;
  assert.ok(woken instanceof Date);
});

test("codes d'erreur (audit A F6) : tout code rendu figure dans l'OpenAPI ; runner saturé ⇒ 503 runner_busy réessayable", async () => {
  const spec = readFileSync("public/openapi/v1.yaml", "utf8");
  const enumBlock = /code:\n\s+type: string\n\s+enum:\n((?:\s+- [a-z_]+\n)+)/.exec(spec);
  assert.ok(enumBlock, "énumération des codes introuvable");
  const documented = new Set(enumBlock[1].split("\n").map((line) => line.trim().replace(/^- /, "")).filter(Boolean));
  const cases: [AppError, number, string][] = [
    [new AppError("Règlement on-chain non confirmé", 409), 409, "conflict"],
    [new AppError("Prédiction numérique instable", 422), 422, "prediction_unstable"],
    [new AppError("Entité non traitable", 422), 422, "invalid_request"],
    [new AppError("Runner saturé", 503), 503, "runner_busy"],
    [new AppError("Runner confidentiel indisponible", 503), 503, "runner_unavailable"],
    [new AppError("Runner confidentiel en échec", 502), 502, "runner_error"],
    [new AppError("Clé API réservée à l’emprunteur", 403), 403, "forbidden"],
    [new AppError("Lecture de requête expirée", 408), 408, "request_timeout"],
  ];
  for (const [error, status, code] of cases) {
    const sys = system({ apiKeys: [activeKey()], runner: { apiPredict: async () => { throw error; } } });
    const response = await sys.api.predict();
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).error.code, code);
    assert.ok(documented.has(code), `${code} absent de l'OpenAPI`);
    assert.equal(response.headers.get("retry-after"), code === "runner_busy" ? "1" : null, code);
  }
  for (const code of ["invalid_signature", "unknown_key", "rate_limited", "enclave_starting", "internal_error", "unsupported_media_type"]) {
    assert.ok(documented.has(code), code);
  }
  // Réponse servie : domaine EIP-712 et décision en texte, tels que l'OpenAPI les publie.
  const served = await (await system({ apiKeys: [activeKey()] }).api.predict()).json();
  const domain = /name: \{ type: string, const: ([A-Za-z]+) \}\n\s+version: \{ type: string, const: "(\d+)" \}/.exec(spec);
  assert.ok(domain, "domaine EIP-712 absent de l'OpenAPI");
  assert.deepEqual([served.domain.name, served.domain.version], [domain[1], domain[2]]);
  assert.equal(typeof served.decision, "string");
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

test("clé créée d'office (D-33) : une seule par prêt, réservée avant le scellement, refusée dès qu'une clé existe", async () => {
  const sys = system({ apiKeys: [] });
  assert.equal((await sys.manage.create({ auto: true })).status, 200);
  const created = await sys.manage.create({ keyId: KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(sys.prisma.apiKey.rows.map((row) => [row.id, row.name, row.revokedAt]), [[KEY_ID, "Clé par défaut", null]]);
  // Second appareil : refus distinct, aux deux temps, sans rien sceller dans l'enclave.
  for (const body of [{ auto: true }, { keyId: OTHER_KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true }]) {
    const refused = await sys.manage.create(body);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: apiPricing.AUTO_API_KEY_EXISTS, code: apiPricing.AUTO_API_KEY_EXISTS_CODE });
  }
  assert.equal(sys.calls.runner.filter(([op]) => op === "register").length, 1);
  // Création manuelle inchangée : une seconde clé reste possible.
  assert.equal((await sys.manage.create({ keyId: OTHER_KEY_ID, name: "prod", envelope, authorization: grant })).status, 201);

  // Toutes les clés révoquées : jamais de clé d'office.
  const revoked = system({ apiKeys: [activeKey({ revokedAt: new Date(0) })] });
  const refused = await revoked.manage.create({ keyId: OTHER_KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true });
  assert.equal((await refused.json()).code, apiPricing.AUTO_API_KEY_EXISTS_CODE);
  assert.equal(revoked.calls.runner.length, 0);
  assert.equal(revoked.prisma.apiKey.rows.length, 1);

  // Refus net de l'enclave (4xx) : rien de scellé, la réservation disparaît, une nouvelle tentative reste possible.
  const refusedSeal = system({ apiKeys: [], runner: { register: async () => { throw new AppError("Enveloppe de clé API invalide", 400); } } });
  assert.equal((await refusedSeal.manage.create({ keyId: KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true })).status, 400);
  assert.equal(refusedSeal.prisma.apiKey.rows.length, 0);
  assert.equal((await refusedSeal.manage.create({ auto: "yes" })).status, 400);
});

test("clé d'office sans réponse sûre de l'enclave (réseau, 5xx, réponse illisible) : réservation gardée, révocable", async () => {
  for (const failure of [
    async () => { throw new AppError("Runner confidentiel indisponible", 503); },
    async () => { throw new AppError("Runner confidentiel en échec", 500); },
    async () => { throw new Error("socket hang up"); },
    async () => ({ keyId: OTHER_KEY_ID, createdAt: 0 }),
  ]) {
    const sys = system({ apiKeys: [], runner: { register: failure, revoke: async () => { throw new AppError("Clé API inconnue", 404, "unknown_key"); } } });
    const response = await sys.manage.create({ keyId: KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true });
    assert.ok(response.status >= 500, String(response.status));
    assert.equal((await response.json()).error, apiPricing.AUTO_API_KEY_UNCONFIRMED);
    // La ligne reste : listée sous son nom, elle bloque une seconde clé d'office.
    const listed = await (await sys.manage.list()).json();
    assert.deepEqual(listed.keys.map((key: Row) => [key.keyId, key.name, key.revokedAt]), [[KEY_ID, "Clé par défaut", null]]);
    const second = await sys.manage.create({ keyId: OTHER_KEY_ID, name: "Clé par défaut", envelope, authorization: grant, auto: true });
    assert.equal((await second.json()).code, apiPricing.AUTO_API_KEY_EXISTS_CODE);
    // Réservation récente : le scellement peut encore aboutir, la révocation est refusée sans rien marquer.
    const early = await sys.manage.revoke(KEY_ID);
    assert.equal(early.status, 409, await early.clone().text());
    assert.equal(sys.prisma.apiKey.rows[0].revokedAt ?? null, null);
    // Jamais scellée (réservation de plus de 2 min) : l'enclave répond « clé inconnue », la révocation réussit.
    sys.prisma.apiKey.rows[0].createdAt = new Date(Date.now() - 3 * 60_000);
    const revoked = await sys.manage.revoke(KEY_ID);
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.ok(sys.prisma.apiKey.rows[0].revokedAt instanceof Date);
    assert.equal(sys.calls.runner.filter(([op]) => op === "revoke").length, 2, "la révocation passe par l'enclave");
  }
  // Autre refus de l'enclave à la révocation : remonte, rien n'est marqué.
  const denied = system({ apiKeys: [activeKey()], runner: { revoke: async () => { throw new AppError("Révocation réservée à l’emprunteur", 403); } } });
  assert.equal((await denied.manage.revoke(KEY_ID)).status, 403);
  assert.equal(denied.prisma.apiKey.rows[0].revokedAt, null);
});

test("clé manuelle (audit A F4) : réservée avant le scellement ; réponse douteuse ⇒ ligne gardée et révocable ; refus net ⇒ retirée", async () => {
  for (const failure of [
    async () => { throw new AppError("Runner confidentiel indisponible", 503); },
    async () => { throw new Error("socket hang up"); },
    async () => ({ keyId: OTHER_KEY_ID, createdAt: 0 }),
  ]) {
    const sys = system({ apiKeys: [], runner: { register: failure, revoke: async () => { throw new AppError("Clé API inconnue", 404, "unknown_key"); } } });
    const response = await sys.manage.create({ keyId: KEY_ID, name: "prod", envelope, authorization: grant });
    assert.ok(response.status >= 500, String(response.status));
    assert.equal((await response.json()).error, apiPricing.API_KEY_UNCONFIRMED);
    const listed = await (await sys.manage.list()).json();
    assert.deepEqual(listed.keys.map((key: Row) => [key.keyId, key.name, key.revokedAt]), [[KEY_ID, "prod", null]]);
    sys.prisma.apiKey.rows[0].createdAt = new Date(Date.now() - 3 * 60_000);
    const revoked = await sys.manage.revoke(KEY_ID);
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.ok(sys.prisma.apiKey.rows[0].revokedAt instanceof Date);
  }
  // La ligne existe pendant le scellement : elle compte dans la capacité.
  let during: Row[] = [];
  const sealing = system({ apiKeys: [], runner: { register: async (input) => {
    during = sealing.prisma.apiKey.rows.map((row) => ({ ...row }));
    return { keyId: input.keyId, createdAt: 1_700_000_000_000 };
  } } });
  const created = await sealing.manage.create({ keyId: KEY_ID, name: "prod", envelope, authorization: grant });
  assert.equal(created.status, 201);
  assert.deepEqual(during.map((row) => [row.id, row.revokedAt]), [[KEY_ID, null]]);
  assert.equal((await created.json()).createdAt, new Date(1_700_000_000_000).toISOString(), "date de scellement de l'enclave");

  const refused = system({ apiKeys: [], runner: { register: async () => { throw new AppError("Limite de clés API actives atteinte pour ce prêt : révoque une clé d’abord", 409, "key_limit_reached"); } } });
  assert.equal((await refused.manage.create({ keyId: KEY_ID, name: "prod", envelope, authorization: grant })).status, 409);
  assert.equal(refused.prisma.apiKey.rows.length, 0, "refus net : rien de scellé, réservation retirée");
});

test("révocation (audit E F1) : grant hors périmètre refusé sans réveil ; location échue ⇒ réveil sur le budget du compte", async () => {
  const sys = system({ phase: "stopped", apiKeys: [activeKey()] });
  for (const [label, authorization] of [
    ["autre opération", revokeGrant("loan-1", KEY_ID, { operation: "register-api-key" })],
    ["autre clé", revokeGrant("loan-1", KEY_ID, { payloadHash: hashRunnerIntent(["loan-1", OTHER_KEY_ID]) })],
    ["autre prêt", revokeGrant("loan-2", KEY_ID)],
    ["sans périmètre", grant],
  ] as const) {
    const response = await sys.manage.revoke(KEY_ID, "loan-1", authorization);
    assert.equal(response.status, 401, label);
  }
  assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "aucun réveil");
  assert.equal(sys.calls.runner.length, 0);
  // Location en cours : réveil hors budget, comme toute action de l'emprunteur.
  assert.equal((await sys.manage.revoke(KEY_ID)).status, 503);
  assert.equal(sys.wakeBudget.size, 0);

  const expired = system({ phase: "stopped", loans: [origin({ rentalExpiresAt: new Date(Date.now() - 1) })], apiKeys: [activeKey()] });
  for (let i = 0; i < 6; i++) {
    expired.prisma.runnerAvailability.rows[0].requestedUntil = null;
    assert.equal((await expired.manage.revoke(KEY_ID)).status, 503, `réveil ${i + 1}`);
  }
  assert.equal(expired.wakeBudget.get(BORROWER.toLowerCase())?.hourCount, 6);
  expired.prisma.runnerAvailability.rows[0].requestedUntil = null;
  const limited = await expired.manage.revoke(KEY_ID);
  assert.equal(limited.status, 429, "budget épuisé : la CVM n'est plus réveillée");
  assert.ok(limited.headers.get("retry-after"));
  assert.equal(expired.prisma.runnerAvailability.rows[0].requestedUntil, null);
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
  assert.equal(response.headers.get("retry-after"), "45");
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
  assert.equal(response.headers.get("retry-after"), "45");
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
    if (phase) assert.ok(sys.prisma.runnerAvailability.rows[0].requestedUntil instanceof Date, "CVM allumée : l'activité la garde voulue");
  }
});

/** `POST /api/datasets` réel (route, brouillon, pipeline) ; base, KYB et runner en mémoire. */
function publicationSystem(phase: string | null, options: { kybRefused?: boolean } = {}) {
  const datasets = table([]);
  const insert = datasets.create;
  // Valeur par défaut du schéma : un dataset naît brouillon.
  datasets.create = ({ data }) => insert({ data: { status: "DRAFT", ...data } });
  const runnerAvailability = table(phase === null ? [] : [{ id: 1, phase, since: new Date(0), requestedUntil: null, validUntil: null }]);
  const prisma = { dataset: datasets, runnerAvailability };
  const db = { prisma, serializableTransaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma) };
  const calls = { ingress: 0 };
  const session: { address: string } = { address: PROVIDER };
  const runner = { runnerKind: "PHALA", runnerDeploymentId: "phala:1" };
  const availabilityModule = load<typeof import("./availability")>("src/lib/sirius/availability.ts", {
    "server-only": {}, "next/server": { NextResponse }, "@/lib/db": db, "@/lib/errors": { AppError, errorResponse },
    "./wake-budget": wakeBudgetDouble().module,
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
  listingDays: 30, trainingConsent: false, modelId: "logistic_regression",
};

test("publication, CVM éteinte : réveil 15 min et 503 enclave_starting sans brouillon ; la relance crée un seul brouillon", async () => {
  const sys = publicationSystem("stopped");
  const before = Date.now();
  const response = await sys.publish(publicationBody);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "45");
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

test("publication : requête anonyme, invalide ou sans KYB ne réveille pas la CVM ; CVM allumée : brouillon créé, activité enregistrée", async () => {
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
    if (phase) assert.ok(sys.prisma.runnerAvailability.rows[0].requestedUntil instanceof Date, "CVM allumée : l'activité la garde voulue");
  }
});

test("publication : fournisseur au quota de brouillons, aucun réveil ; au-delà du budget de réveil, 429 avec Retry-After, autre compte servi", async () => {
  const full = publicationSystem("stopped");
  for (let i = 0; i < 5; i++) {
    full.prisma.dataset.rows.push({ id: `draft-${i}`, provider: PROVIDER, status: "DRAFT", ipfsCid: null, wrappedKey: null, runnerReceipt: null, createdAt: new Date(), updatedAt: new Date() });
  }
  assert.equal((await full.publish(publicationBody)).status, 429);
  assert.equal(full.prisma.runnerAvailability.rows[0].requestedUntil, null, "quota atteint : la CVM n'est pas réveillée");
  // Brouillons abandonnés (vides depuis plus de 30 min) : ils ne comptent plus, comme dans la transaction.
  for (const row of full.prisma.dataset.rows) row.updatedAt = new Date(Date.now() - 31 * 60_000);
  assert.equal((await full.publish(publicationBody)).status, 503);

  const sys = publicationSystem("stopped");
  const availability = sys.prisma.runnerAvailability.rows[0];
  for (let i = 0; i < 6; i++) {
    availability.requestedUntil = null;
    assert.equal((await sys.publish(publicationBody)).status, 503, `réveil ${i + 1}`);
  }
  availability.requestedUntil = null;
  const limited = await sys.publish(publicationBody);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  assert.equal(typeof (await limited.json()).error, "string");
  assert.equal(availability.requestedUntil, null, "budget épuisé : rien d'écrit");
  sys.session.address = OTHER;
  assert.equal((await sys.publish(publicationBody)).status, 503, "un autre compte garde son budget");
  assert.ok(sys.prisma.runnerAvailability.rows[0].requestedUntil instanceof Date);
  // CVM allumée, budget épuisé : la publication passe, sans prolonger la CVM.
  sys.session.address = PROVIDER;
  availability.phase = "running";
  availability.requestedUntil = null;
  assert.equal((await sys.publish(publicationBody)).status, 201);
  assert.equal(availability.requestedUntil, null);
});

test("devis : emprunteur au plafond de PENDING, aucun réveil ; au-delà du budget de réveil, 429 avec Retry-After, devis servi si la CVM tourne", async () => {
  const pending = Array.from({ length: 5 }, (_, i) => ({ ...pendingLoan(), id: `pending-${i}` }));
  const capped = system({ phase: "stopped", loans: [origin(), ...pending] });
  assert.equal((await capped.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 429);
  assert.equal(capped.prisma.runnerAvailability.rows[0].requestedUntil, null);
  assert.ok(capped.prisma.loan.rows.filter((loan) => loan.status === "PENDING").length === 5, "aucun PENDING remplacé");

  const sys = system({ phase: "stopped" });
  const availability = sys.prisma.runnerAvailability.rows[0];
  for (let i = 0; i < 6; i++) {
    availability.requestedUntil = null;
    assert.equal((await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 503, `réveil ${i + 1}`);
  }
  availability.requestedUntil = null;
  const limited = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  assert.equal(availability.requestedUntil, null);
  availability.phase = "running";
  assert.equal((await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 201);
  assert.equal(availability.requestedUntil, null, "servi sans prolonger la CVM");
  assert.equal(sys.calls.lockRequests.length, 1);
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
  assert.deepEqual(await response.json(), {
    loanId: "pack-9", originalLoanId: "loan-1", settleTxHash: PACK_TX, callPack: 100, apiAccessDays: null, credits: 100, apiPaidUntil: null,
  });
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
  await assert.rejects(foreign.callsModule.settleLoanPack("pack-9"), (error: AppError) => error.status === 403);
  const otherDataset = system({ loans: [origin({ ...expired, datasetId: "dataset-2" }), settling()], policy: false });
  await assert.rejects(otherDataset.callsModule.settleLoanPack("pack-9"), (error: AppError) => error.status === 409);
  assert.equal(foreign.calls.runner.length + otherDataset.calls.runner.length, 0);
});

// --- Finalité rapide --------------------------------------------------------------------------

test("finalité rapide : prolongation et pack sous les plafonds passent au palier FAST, au-delà en finalité complète", async () => {
  for (const kind of ["extension", "pack"] as const) {
    const settle = (sys: ReturnType<typeof system>) => kind === "pack" ? sys.callsModule.settleLoanPack("pack-9", grant as never) : sys.extend.settleLoanExtension("ext-9", grant as never);
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

test("reaper : pack, pass ou prolongation FAST au release diffusé, à la profondeur rapide mais non finalisé ⇒ réglé dans la passe ; FULL attend", async () => {
  // Release vu à la profondeur rapide, pas encore sous le bloc finalisé : seule une demande au
  // palier FAST l'accepte, comme `assertCanonicalReceipt` (escrow.ts).
  const tiers: string[] = [];
  const reaperChain = async (tier: string) => {
    tiers.push(tier);
    if (tier !== "FAST") throw new AppError("Transaction on-chain non confirmée ou réorganisée", 409);
    return { state: "settled", txHash: PACK_TX, preimage: `0x${"01".repeat(32)}` };
  };
  for (const kind of ["pack", "pass", "extension"] as const) {
    const id = kind === "pack" ? "pack-9" : kind === "pass" ? "pass-9" : "ext-9";
    const op = kind === "extension" ? "extend" : "buyCalls";
    const settling = (tier: string) => attached(kind, {
      status: "SETTLING", settleTxHash: PACK_TX, finalityTier: tier, billingQuoteHash: `0x${"bb".repeat(32)}`, updatedAt: new Date(0),
    });

    tiers.length = 0;
    const runner = kind === "pass" ? { buyCalls: async () => ({ settleTxHash: PACK_TX, apiPaidUntil: Date.now() + 3 * DAY }) } : undefined;
    const fast = system({ fast: true, loans: [origin({ apiPaidUntil: null }), settling("FAST")], reaperChain, runner });
    assert.equal((await fast.reaper().runLoanReaper(new Date())).failed, 0, kind);
    assert.deepEqual(tiers, ["FAST"], kind);
    // Toujours FAST avec `settledAt` : la revue à finalité complète (`needsFastReview`) le reprendra.
    const settled = fast.prisma.loan.rows.find((row) => row.id === id)!;
    assert.equal(settled.finalityTier, "FAST", kind);
    assert.ok(settled.settledAt instanceof Date, kind);
    assert.equal(fast.calls.runner.filter(([name]) => name === op).length, 1, kind);
    assert.equal(fast.prisma.loan.rows.find((row) => row.id === id)!.status, "SETTLED", kind);

    tiers.length = 0;
    const errors = mock.method(console, "error", () => {});
    const full = system({ fast: true, loans: [origin({ apiPaidUntil: null }), settling("FULL")], reaperChain });
    assert.equal((await full.reaper().runLoanReaper(new Date())).failed, 1, kind);
    errors.mock.restore();
    assert.deepEqual(tiers, ["FULL"], kind);
    assert.equal(full.calls.runner.length, 0, kind);
    assert.equal(full.prisma.loan.rows.find((row) => row.id === id)!.status, "SETTLING", kind);

    // Coupe-circuit fermé (SIRIUS_FAST_FINALITY off) : une ligne restée FAST est vérifiée à finalité
    // complète, comme partout ailleurs (`effectiveLoanFinalityTier`) ; jamais au palier rapide désactivé.
    tiers.length = 0;
    const offErrors = mock.method(console, "error", () => {});
    const off = system({ fast: false, loans: [origin({ apiPaidUntil: null }), settling("FAST")], reaperChain });
    assert.equal((await off.reaper().runLoanReaper(new Date())).failed, 1, kind);
    offErrors.mock.restore();
    assert.deepEqual(tiers, ["FULL"], kind);
    assert.equal(off.calls.runner.length, 0, kind);
  }
});

test("GET /api/loans : champs API et packs exposés", async () => {
  const sys = system();
  const apiKeys = load<typeof import("./api-keys")>("src/lib/sirius/api-keys.ts", {
    "server-only": {}, "@/lib/db": { prisma: sys.prisma }, "@/lib/errors": { AppError }, "@/lib/evm/address": addresses,
    "@/lib/billing/config": { billingEnabled: () => true, billingPolicy: () => ({ apiCallsPerDay: API_CALLS_PER_DAY }) },
    "@/lib/billing/api-pricing": apiPricing, "@/lib/models/registry": models, "@/lib/runner/profile-admission": profileAdmission, "@/lib/runner/provenance": {}, "@/lib/tee/contract": contract,
    "@/lib/evm/networks": { resolveUsdcDecimals: () => DECIMALS },
    "@/lib/tee/runner-client": {}, "./access": {}, "./availability": {}, "./finality-tier": {}, "./rental": {}, "@/lib/runner/authorization": {},
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

// --- Pass d'accès API payé au jour (D-32) ----------------------------------------------------------

test("pass d'accès API : sans journée payée, l'API publique refuse avant l'enclave et ne réveille pas la CVM", async () => {
  for (const apiPaidUntil of [null, new Date(Date.now() - 1)]) {
    const sys = system({ phase: "stopped", loans: [origin({ apiPaidUntil })], apiKeys: [activeKey()] });
    for (const response of [await sys.api.predict(), await sys.api.info()]) {
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: { code: apiPricing.API_ACCESS_REQUIRED_CODE, message: apiPricing.API_ACCESS_REQUIRED } });
    }
    assert.equal(sys.prisma.runnerAvailability.rows[0].requestedUntil, null, "aucun réveil");
    assert.equal(sys.calls.runner.length, 0, "rien relayé");
  }
  const paid = system({ phase: "running", loans: [origin()], apiKeys: [activeKey()] });
  assert.equal((await paid.api.predict()).status, 200, "pass couvrant l'instant présent");
});

test("pass d'accès API : création de clé refusée sans pass couvrant l'instant présent", async () => {
  const sys = system({ loans: [origin({ apiPaidUntil: null })] });
  for (const response of [await sys.manage.create({}), await sys.manage.create({ keyId: KEY_ID, name: "prod", envelope, authorization: grant })]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, apiPricing.API_ACCESS_REQUIRED);
  }
  assert.equal(sys.calls.runner.length, 0);
  assert.equal(sys.prisma.apiKey.rows.length, 0);
  const list = await (await sys.manage.list()).json();
  assert.equal(list.apiAccess.paidUntil, null);
  assert.equal(list.apiAccess.dailyFee, API_ACCESS_DAILY_FEE);
});

test("pass d'accès API : devis jusqu'à l'échéance (jour entamé compté), part fournisseur minimale, refus avant tout paiement", async () => {
  const rentalExpiresAt = new Date(Date.now() + 2.5 * DAY);
  const sys = system({ loans: [origin({ rentalExpiresAt, apiPaidUntil: null })] });
  const listed = await (await sys.manage.list()).json();
  // ceil(2,5 jours) = 3 jours × 1,50 + 0,001 au fournisseur.
  assert.equal(listed.apiAccess.daysToBuy, 3);
  assert.equal(listed.apiAccess.price, "4501000");
  const response = await sys.manage.calls({ apiAccess: true });
  assert.equal(response.status, 201, await response.clone().text());
  const prepared = await response.json();
  assert.deepEqual(JSON.parse(JSON.stringify(sys.calls.lockRequests)), [{ rentalDays: 7, apiAccess: true, packForLoanId: "loan-1" }]);
  const pass = sys.prisma.loan.rows.find((row) => row.id === prepared.loanId)!;
  assert.deepEqual([pass.packForLoanId, pass.apiAccessDays, pass.callPack, pass.extendsLoanId], ["loan-1", 3, null, null]);
  assert.deepEqual([pass.datasetAmountUsdcAtomic, pass.computeAmountUsdcAtomic, pass.maxFailureFeeUsdcAtomic, pass.amountUsdcAtomic],
    [PASS_PROVIDER_SHARE, "4500000", "0", "4501000"]);

  // Tarif sans `apiAccessDailyComputeAmount` : pas en vente, jamais gratuit.
  const notForSale = system({ apiAccessFee: false, loans: [origin({ apiPaidUntil: null })] });
  const refused = await notForSale.manage.calls({ apiAccess: true });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, apiPricing.API_ACCESS_NOT_FOR_SALE);
  assert.equal((await (await notForSale.manage.list()).json()).apiAccess.price, null);
  // Location déjà couverte jusqu'à l'échéance, pass déjà en paiement, requêtes mal formées.
  const covered = system({ loans: [origin({ rentalExpiresAt, apiPaidUntil: rentalExpiresAt })] });
  assert.equal((await covered.manage.calls({ apiAccess: true })).status, 409);
  const inFlight = system({ loans: [origin({ apiPaidUntil: null }), attached("pass")] });
  assert.equal((await inFlight.manage.calls({ apiAccess: true })).status, 409);
  for (const body of [{ apiAccess: "yes" }, { apiAccess: true, size: 100 }]) assert.equal((await sys.manage.calls(body)).status, 400);
  for (const other of [notForSale, covered, inFlight]) assert.equal(other.calls.lockRequests.length, 0);
});

test("pass d'accès API : complément après prolongation, jours ajoutés seulement", async () => {
  const oldEnd = new Date(Date.now() + DAY);
  const sys = system({ loans: [origin({ apiPaidUntil: oldEnd, rentalExpiresAt: new Date(oldEnd.getTime() + 5 * DAY) })] });
  const listed = await (await sys.manage.list()).json();
  assert.equal(listed.apiAccess.daysToBuy, 5, "couverture repartant de l'ancienne date payée");
  assert.equal(listed.apiAccess.paidUntil, oldEnd.toISOString());
});

test("pass d'accès API : règlement par le runner, couverture reflétée sur le prêt d'origine, rejouable et jamais en arrière", async () => {
  const paidUntil = Date.now() + 3 * DAY;
  const sys = system({
    loans: [origin({ apiPaidUntil: null }), attached("pass")],
    runner: { buyCalls: async () => ({ settleTxHash: PACK_TX, apiPaidUntil: paidUntil }) },
  });
  const settle = () => sys.manage.calls({ packLoanId: "pass-9", authorization: grant });
  const response = await settle();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    loanId: "pass-9", originalLoanId: "loan-1", settleTxHash: PACK_TX, callPack: null, apiAccessDays: 3, credits: null,
    apiPaidUntil: new Date(paidUntil).toISOString(),
  });
  const rows = sys.prisma.loan.rows;
  assert.equal(rows.find((row) => row.id === "pass-9")!.status, "SETTLED");
  assert.equal((rows.find((row) => row.id === "loan-1")!.apiPaidUntil as Date).getTime(), paidUntil);
  assert.equal((await (await settle()).json()).apiPaidUntil, new Date(paidUntil).toISOString());
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1, "aucun second appel au runner");

  const later = new Date(paidUntil + DAY);
  const monotonic = system({ loans: [origin({ apiPaidUntil: later }), attached("pass")], runner: { buyCalls: async () => ({ settleTxHash: PACK_TX, apiPaidUntil: paidUntil }) } });
  assert.equal((await monotonic.manage.calls({ packLoanId: "pass-9", authorization: grant })).status, 200);
  assert.equal(monotonic.prisma.loan.rows.find((row) => row.id === "loan-1")!.apiPaidUntil, later);

  const pending = system({ loans: [origin(), attached("pass")], runner: { buyCalls: async () => { throw new failurePolicy.RunnerFinalityPending(PACK_TX); } } });
  const waiting = await pending.manage.calls({ packLoanId: "pass-9", authorization: grant });
  assert.equal(waiting.status, 202);
  assert.deepEqual(await waiting.json(), { pending: true, settleTxHash: PACK_TX, error: settlementStatus.API_ACCESS_PENDING });
});

test("reaper : un pass verrouillé non réglé est enregistré sans autorisation", async () => {
  const paidUntil = Date.now() + 2 * DAY;
  const sys = system({ loans: [origin({ apiPaidUntil: null }), attached("pass")], runner: { buyCalls: async () => ({ settleTxHash: PACK_TX, apiPaidUntil: paidUntil }) } });
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 0);
  assert.equal(sys.prisma.loan.rows.find((row) => row.id === "pass-9")!.status, "SETTLED");
  assert.equal((sys.prisma.loan.rows.find((row) => row.id === "loan-1")!.apiPaidUntil as Date).getTime(), paidUntil);
});

test("pass caduc (base du prix changée) : refusé pour toujours, jamais rejoué ni libéré, même après une prolongation", async () => {
  let stale = true;
  const sys = system({ loans: [origin(), attached("pass")], runner: { buyCalls: async () => {
    if (stale) throw new AppError(apiPricing.API_ACCESS_STALE, 409, apiPricing.API_ACCESS_STALE_CODE);
    return { settleTxHash: PACK_TX, apiPaidUntil: Date.now() + 7 * DAY };
  } } });
  const refused = await sys.manage.calls({ packLoanId: "pass-9", authorization: grant });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, apiPricing.API_ACCESS_STALE);
  const pass = sys.prisma.loan.rows.find((row) => row.id === "pass-9")!;
  assert.equal(pass.status, "ESCROWED", "fonds toujours dans l'escrow, remboursables à l'échéance");
  assert.ok(pass.apiAccessRefusedAt instanceof Date);
  // Prolongation d'un jour : même si l'enclave ne refusait plus, rien n'est rejoué.
  stale = false;
  sys.prisma.loan.rows.find((row) => row.id === "loan-1")!.rentalExpiresAt = new Date(Date.now() + 2 * DAY);
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 0);
  assert.equal((await sys.manage.calls({ packLoanId: "pass-9", authorization: grant })).status, 409);
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 1, "une seule tentative, jamais de release");
  assert.equal(pass.status, "ESCROWED");
  // Le pass refusé ne bloque pas un nouvel achat.
  const fresh = system({ loans: [origin({ apiPaidUntil: null }), attached("pass", { apiAccessRefusedAt: new Date() })] });
  assert.equal((await fresh.manage.calls({ apiAccess: true })).status, 201);
  // Reaper seul : refus marqué de la même façon.
  const reaped = system({ loans: [origin(), attached("pass")], runner: { buyCalls: async () => {
    throw new AppError(apiPricing.API_ACCESS_STALE, 409, apiPricing.API_ACCESS_STALE_CODE);
  } } });
  assert.equal((await reaped.reaper().runLoanReaper(new Date())).failed, 0);
  assert.ok(reaped.prisma.loan.rows.find((row) => row.id === "pass-9")!.apiAccessRefusedAt instanceof Date);
  await reaped.reaper().runLoanReaper(new Date());
  assert.equal(reaped.calls.runner.filter(([op]) => op === "buyCalls").length, 1);
});

test("pass en préparation (PENDING ou remplacé, sans lock) : aucun second pass tant que son autorisation de lock vaut", async () => {
  const preparing = (overrides: Row) => attached("pass", { status: "PENDING", evmLockTxHash: null, createdAt: new Date(), ...overrides });
  for (const row of [preparing({}), preparing({ status: "CANCELLED", cancelTxHash: null })]) {
    const sys = system({ loans: [origin({ apiPaidUntil: null }), row] });
    const response = await sys.manage.calls({ apiAccess: true });
    assert.equal(response.status, 409, String(row.status));
    assert.equal((await response.json()).error, apiPricing.API_ACCESS_PREPARING);
    assert.equal(sys.calls.lockRequests.length, 0);
  }
  const stalePreparation = system({ loans: [origin({ apiPaidUntil: null }), preparing({ createdAt: new Date(Date.now() - reaperPolicy.PENDING_REAPER_TTL_MS - 1) })] });
  assert.equal((await stalePreparation.manage.calls({ apiAccess: true })).status, 201, "autorisation de lock expirée : plus de risque");
});

test("emprunt : API toujours incluse (jours × tarif journalier), sans option pour s'en passer", async () => {
  for (const body of [{}, { includeApiAccess: false }, { includeApiAccess: "yes" }]) {
    const sys = system({ loans: [] });
    const response = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 3, ...body });
    assert.equal(response.status, 201, await response.clone().text());
    assert.deepEqual(JSON.parse(JSON.stringify(sys.calls.lockRequests)), [{ rentalDays: 3, includeApiAccess: true }], JSON.stringify(body));
    const { loanId, billingQuote } = await response.json();
    // 3 jours × 1,5 : part API ajoutée au compute signé, part fournisseur inchangée.
    assert.deepEqual([billingQuote.quote.apiAccessIncluded, billingQuote.quote.apiAccessAmount], [true, "4500000"]);
    const loan = sys.prisma.loan.rows.find((row) => row.id === loanId)!;
    const datasetAmount = rentalRules.datasetAmountFor(PRICE_PER_DAY, 3);
    const computeAmount = (BigInt(NO_TRAINING_COMPUTE) + BigInt(4_500_000)).toString();
    assert.equal(billingQuote.quote.computeAmount, computeAmount, "compute = base + 3 × 1,5");
    assert.deepEqual([loan.datasetAmountUsdcAtomic, loan.computeAmountUsdcAtomic, loan.amountUsdcAtomic],
      [datasetAmount, computeAmount, (BigInt(datasetAmount) + BigInt(computeAmount)).toString()]);
  }
});

test("emprunt refusé avant tout devis si le tarif ne vend pas l'API ou ne l'ouvre pas au profil", async () => {
  for (const [options, status, error] of [
    [{ apiAccessFee: false }, 409, apiPricing.RENTAL_API_ACCESS_NOT_FOR_SALE],
    [{ apiCallsPerDay: {} }, 409, "Location indisponible : le tarif en vigueur n’ouvre pas l’API pour ce profil, or toute location inclut l’accès API"],
  ] as const) {
    const sys = system({ loans: [], ...options });
    const refused = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 3 });
    assert.equal(refused.status, status, JSON.stringify(options));
    const body = await refused.json();
    assert.equal(body.error, error);
    assert.equal(sys.calls.lockRequests.length, 0, "aucun devis demandé à l'enclave");
    assert.equal(sys.prisma.loan.rows.length, 0, "aucun prêt préparé");
  }
});

test("emprunt d'un profil linéaire réactivé : jamais d'API (D-27), devis sans part API", async () => {
  const previous = process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
  process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = "linear_regression";
  try {
    const sys = system({ loans: [] });
    Object.assign(sys.prisma.dataset.rows[0], { modelId: "linear_regression", modelVersion: "1.0.0" });
    const response = await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 2 });
    assert.equal(response.status, 201, await response.clone().text());
    assert.deepEqual(JSON.parse(JSON.stringify(sys.calls.lockRequests)), [{ rentalDays: 2 }]);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    else process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = previous;
  }
});

// --- Audit facturation (C P2-1, C P2-2/B P2-2, B P2-1, B P3-1, C P3-4) ------------------------

test("pack réglé on-chain sans réponse du runner : reste SETTLING avec le hash, crédité même location échue depuis", async () => {
  let lost = true;
  const sys = system({
    loans: [origin({ rentalExpiresAt: new Date(Date.now() + 60_000) }), attached("pack")],
    settleChain: { state: "settled", txHash: PACK_TX, preimage: `0x${"01".repeat(32)}` },
    runner: { buyCalls: async () => {
      if (lost) { lost = false; throw new AppError("Runner confidentiel indisponible", 503); }
      return { settleTxHash: PACK_TX, credits: 100 };
    } },
  });
  assert.equal((await sys.manage.calls({ packLoanId: "pack-9", authorization: grant })).status, 503);
  const pack = sys.prisma.loan.rows.find((row) => row.id === "pack-9")!;
  assert.equal(pack.status, "SETTLING", "l'argent a bougé : plus de retour à ESCROWED");
  assert.equal(pack.settleTxHash, PACK_TX);
  // La location se termine avant la reprise : le crédit payé est quand même enregistré.
  sys.prisma.loan.rows.find((row) => row.id === "loan-1")!.rentalExpiresAt = new Date(Date.now() - 1);
  const retry = await sys.manage.calls({ packLoanId: "pack-9", authorization: grant });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(pack.status, "SETTLED");
  assert.equal(sys.calls.runner.filter(([op]) => op === "buyCalls").length, 2);
});

test("achat rendu à ESCROWED après un échec : palier FAST rendu, le plafond rapide en cours est libéré", async () => {
  for (const kind of ["pack", "extension"] as const) {
    const id = kind === "pack" ? "pack-9" : "ext-9";
    const op = kind === "pack" ? "buyCalls" : "extend";
    let failing = true;
    const fail = async () => {
      if (failing) throw new AppError("Runner confidentiel indisponible", 503);
      return kind === "pack" ? { settleTxHash: PACK_TX, credits: 100 } : { settleTxHash: PACK_TX, expiresAt: Date.now() + 6 * DAY };
    };
    // 94 USDC rapides déjà en cours : l'achat (5) passe en FAST, un second achat (5) ne tiendrait plus.
    const sys = system({ fast: true, runner: { [op]: fail }, loans: [
      origin(), attached(kind), attached(kind, { id: `${id}-b`, evmLoanKey: `0x${"96".repeat(32)}` }),
      origin({ id: "inflight", status: "TRAINING", finalityTier: "FAST", amountUsdcAtomic: usdc("94") }),
    ] });
    const settle = (loanId: string) => kind === "pack" ? sys.callsModule.settleLoanPack(loanId, grant as never) : sys.extend.settleLoanExtension(loanId, grant as never);
    await assert.rejects(settle(id));
    const row = sys.prisma.loan.rows.find((loan) => loan.id === id)!;
    assert.equal(row.status, "ESCROWED", kind);
    assert.equal(row.finalityTier, "FULL", kind);
    failing = false;
    await settle(`${id}-b`);
    assert.equal(sys.prisma.loan.rows.find((loan) => loan.id === `${id}-b`)!.finalityTier, "FAST", `${kind} : plafond libéré`);
  }
});

test("pass caduc : rendu en finalité complète ; reaper : achat FAST échu ou caduc rend son palier", async () => {
  const stale = system({ fast: true, loans: [origin(), attached("pass")], runner: { buyCalls: async () => {
    throw new AppError(apiPricing.API_ACCESS_STALE, 409, apiPricing.API_ACCESS_STALE_CODE);
  } } });
  await assert.rejects(stale.callsModule.settleLoanPack("pass-9", grant as never));
  const pass = stale.prisma.loan.rows.find((row) => row.id === "pass-9")!;
  assert.ok(pass.apiAccessRefusedAt instanceof Date);
  assert.equal(pass.finalityTier, "FULL");

  const recent = new Date();
  for (const [label, row] of [
    ["pack échu", attached("pack", { finalityTier: "FAST", evmDeadline: new Date(Date.now() - 1), updatedAt: recent })],
    ["prolongation échue", attached("extension", { finalityTier: "FAST", evmDeadline: new Date(Date.now() - 1), updatedAt: recent })],
    ["pass caduc", attached("pass", { finalityTier: "FAST", apiAccessRefusedAt: recent, updatedAt: recent })],
  ] as const) {
    const sys = system({ fast: true, loans: [origin(), row] });
    // Passe vue plus tard (bail du reaper dépassé), sans atteindre le délai d'inactivité de la ligne.
    await sys.reaper().runLoanReaper(new Date(recent.getTime() + reaperPolicy.CHAIN_REAPER_LEASE_MS));
    assert.equal(sys.prisma.loan.rows.find((loan) => loan.id === row.id)!.finalityTier, "FULL", label);
    assert.equal(sys.calls.runner.length, 0, label);
  }
});

test("pass dont le lock a été soumis puis annulé (revert) : ne bloque plus un nouveau pass une fois l'autorisation expirée", async () => {
  const reverted = (createdAt: Date) => attached("pass", { status: "CANCELLED", cancelTxHash: null, evmLockTxHash: LOCK_TX, createdAt });
  const fresh = system({ loans: [origin({ apiPaidUntil: null }), reverted(new Date())] });
  const blocked = await fresh.manage.calls({ apiAccess: true });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, apiPricing.API_ACCESS_IN_FLIGHT);
  const old = system({ loans: [origin({ apiPaidUntil: null }), reverted(new Date(Date.now() - reaperPolicy.PENDING_REAPER_TTL_MS - 1))] });
  assert.equal((await old.manage.calls({ apiAccess: true })).status, 201);
});

test("admission : packs, passes et prolongations récents ne comptent pas dans les 3 emprunts par heure et par dataset", async () => {
  const now = new Date();
  const purchases = [
    attached("pack", { status: "SETTLED", createdAt: now }), attached("pass", { status: "SETTLED", createdAt: now }),
    attached("extension", { status: "SETTLED", createdAt: now }),
  ];
  const sys = system({ loans: [origin(), ...purchases] });
  assert.equal((await sys.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 201);
  const rentals = [1, 2, 3].map((i) => origin({ id: `loan-r${i}`, createdAt: now }));
  const capped = system({ loans: [origin(), ...rentals] });
  assert.equal((await capped.manage.quote({ datasetId: "dataset-1", rentalDays: 7 })).status, 429);
});

test("revue de finalité ouverte sur un pack rapide : posée aussi sur le prêt d'origine, l'API publique est gelée", async () => {
  const sys = system({
    loans: [origin(), attached("pack", { status: "SETTLED", finalityTier: "FAST", settleTxHash: PACK_TX, settledAt: new Date(0) })],
    apiKeys: [activeKey()], fastVerdict: { state: "discrepancy", reason: "release disparu après réorganisation : escrow encore verrouillé" },
  });
  const errors = mock.method(console, "error", () => {});
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 1);
  errors.mock.restore();
  const original = sys.prisma.loan.rows.find((row) => row.id === "loan-1")!;
  assert.match(String(original.finalityReview), /^pack d'appels pack-9 : release disparu/);
  assert.ok(original.finalityReviewAt instanceof Date);
  assert.notEqual((await sys.api.predict()).status, 200);
  assert.equal(sys.calls.runner.filter(([op]) => op === "apiPredict").length, 0);
});

test("release miné mais pas assez profond, réponse perdue : l'achat garde son état « release diffusé » et se termine", async () => {
  for (const kind of ["pack", "extension"] as const) {
    const id = kind === "pack" ? "pack-9" : "ext-9";
    const op = kind === "pack" ? "buyCalls" : "extend";
    let lost = true;
    const sys = system({
      loans: [origin({ rentalExpiresAt: new Date(Date.now() + 60_000) }), attached(kind)],
      settleChain: () => { throw new AppError("Résolution on-chain non confirmée", 409); },
      releasedAnyDepth: PACK_TX,
      runner: { [op]: async () => {
        if (lost) { lost = false; throw new AppError("Runner confidentiel indisponible", 503); }
        return kind === "pack" ? { settleTxHash: PACK_TX, credits: 100 } : { settleTxHash: PACK_TX, expiresAt: Date.now() + 6 * DAY };
      } },
    });
    const settle = () => kind === "pack" ? sys.callsModule.settleLoanPack(id, grant as never) : sys.extend.settleLoanExtension(id, grant as never);
    await assert.rejects(settle());
    const row = sys.prisma.loan.rows.find((loan) => loan.id === id)!;
    assert.equal(row.status, "SETTLING", kind);
    assert.equal(row.settleTxHash, PACK_TX, kind);
    // Location close (pack) ou modèle supprimé (prolongation) avant la reprise : terminée quand même.
    sys.prisma.loan.rows.find((loan) => loan.id === "loan-1")!.rentalExpiresAt = new Date(Date.now() - 31 * DAY);
    await settle();
    assert.equal(row.status, "SETTLED", kind);
  }
});

test("reprise d'un achat SETTLING avec hash : une erreur passagère du runner ne le rend pas à ESCROWED", async () => {
  for (const kind of ["pack", "pass", "extension"] as const) {
    const id = kind === "pack" ? "pack-9" : kind === "pass" ? "pass-9" : "ext-9";
    const op = kind === "extension" ? "extend" : "buyCalls";
    const sys = system({
      fast: true,
      loans: [origin(), attached(kind, { status: "SETTLING", settleTxHash: PACK_TX, finalityTier: "FAST", updatedAt: new Date(0) })],
      runner: { [op]: async () => { throw new AppError("Runner confidentiel indisponible", 503); } },
    });
    await assert.rejects(kind === "extension" ? sys.extend.settleLoanExtension(id) : sys.callsModule.settleLoanPack(id));
    const row = sys.prisma.loan.rows.find((loan) => loan.id === id)!;
    assert.equal(row.status, "SETTLING", kind);
    assert.equal(row.settleTxHash, PACK_TX, kind);
    assert.equal(row.finalityTier, "FAST", `${kind} : l'argent a bougé, le palier reste`);
  }
});

test("revues de finalité de plusieurs achats : toutes ajoutées à celle du prêt d'origine, sans doublon", async () => {
  const flagged = (id: string, key: string) => attached("pack", { id, evmLoanKey: `0x${key.repeat(32)}`, status: "SETTLED", finalityTier: "FAST", settleTxHash: PACK_TX, settledAt: new Date(0) });
  const sys = system({
    loans: [origin(), flagged("pack-9", "99"), flagged("pack-8", "95")],
    fastVerdict: { state: "discrepancy", reason: "bloc du release réorganisé après le règlement rapide" },
  });
  const errors = mock.method(console, "error", () => {});
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 2);
  // Passe suivante : les achats déjà en revue ne sont plus revus, rien n'est dupliqué.
  await sys.reaper().runLoanReaper(new Date());
  errors.mock.restore();
  const review = String(sys.prisma.loan.rows.find((row) => row.id === "loan-1")!.finalityReview);
  assert.deepEqual(review.split(" ; ").sort(), [
    "pack d'appels pack-8 : bloc du release réorganisé après le règlement rapide",
    "pack d'appels pack-9 : bloc du release réorganisé après le règlement rapide",
  ]);
});

test("revue du prêt d'origine modifiée pendant l'ajout : l'achat n'est pas mis en revue, la passe suivante ajoute son entrée", async () => {
  const sys = system({
    loans: [origin(), attached("pack", { status: "SETTLED", finalityTier: "FAST", settleTxHash: PACK_TX, settledAt: new Date(0) })],
    fastVerdict: { state: "discrepancy", reason: "bloc du release réorganisé après le règlement rapide" },
  });
  const original = sys.prisma.loan.rows.find((row) => row.id === "loan-1")!;
  const pack = sys.prisma.loan.rows.find((row) => row.id === "pack-9")!;
  const updateMany = sys.prisma.loan.updateMany;
  let raced = false;
  sys.prisma.loan.updateMany = async (args) => {
    // Écriture concurrente sur la revue du prêt d'origine, entre la lecture et l'écriture du reaper.
    if (!raced && args.where.id === "loan-1") { raced = true; original.finalityReview = "revue manuelle en cours"; }
    return updateMany(args);
  };
  const errors = mock.method(console, "error", () => {});
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 1);
  assert.equal(pack.finalityReview, null, "l'achat reste sélectionné par le reaper");
  assert.equal((await sys.reaper().runLoanReaper(new Date())).failed, 1);
  errors.mock.restore();
  assert.equal(original.finalityReview, "revue manuelle en cours ; pack d'appels pack-9 : bloc du release réorganisé après le règlement rapide");
  assert.equal(pack.finalityReview, "bloc du release réorganisé après le règlement rapide");
});

// --- Audit E : bornes du réveil (F1 règlement d'un pack, F2 `/run`, F4 contrôleur muet) ---------------

const requested = (sys: ReturnType<typeof system>) => sys.prisma.runnerAvailability.rows[0].requestedUntil;
const spent = (sys: ReturnType<typeof system>) => sys.wakeBudget.get(BORROWER.toLowerCase())?.hourCount ?? 0;

test("F1 : règlement d'un pack, CVM éteinte : réglé ou refusé ⇒ réponse sans réveil, sans lock ⇒ 409 sans réveil", async () => {
  const sys = system({ phase: "stopped", loans: [
    origin(),
    attached("pack", { id: "pack-settled", status: "SETTLED", settleTxHash: PACK_TX }),
    attached("pass", { id: "pass-refused", apiAccessRefusedAt: new Date(0) }),
    attached("pack", { id: "pack-cancelled", status: "CANCELLED", evmLockTxHash: null, evmLockBlock: null }),
    attached("pack", { id: "pack-pending", status: "PENDING", evmLockTxHash: null }),
  ] });
  const settled = await sys.manage.calls({ packLoanId: "pack-settled", authorization: grant });
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).settleTxHash, PACK_TX);
  assert.equal((await sys.manage.calls({ packLoanId: "pass-refused", authorization: grant })).status, 409);
  for (const packLoanId of ["pack-cancelled", "pack-pending"]) {
    const refused = await sys.manage.calls({ packLoanId, authorization: grant });
    assert.equal(refused.status, 409, packLoanId);
    assert.equal((await refused.json()).error, "Pack d’appels non verrouillé ou déjà clos");
  }
  assert.equal(requested(sys), null, "aucun réveil");
  assert.equal(spent(sys), 0, "aucun budget dépensé");
  assert.equal(sys.calls.runner.length, 0);
});

test("F1 : règlement d'un pack verrouillé, CVM éteinte : réveil au budget de l'emprunteur, 429 une fois épuisé", async () => {
  const sys = system({ phase: "stopped", loans: [origin(), attached("pack")] });
  const response = await sys.manage.calls({ packLoanId: "pack-9", authorization: grant });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "enclave_starting");
  assert.ok(requested(sys) instanceof Date);
  assert.equal(spent(sys), 1);
  assert.equal(sys.calls.runner.length, 0, "rien relayé avant l'enclave");

  const exhausted = system({ phase: "stopped", loans: [origin(), attached("pack")] });
  exhausted.wakeBudget.set(BORROWER.toLowerCase(), { hourStart: new Date(), hourCount: 6, dayStart: new Date(), dayCount: 6 });
  const limited = await exhausted.manage.calls({ packLoanId: "pack-9", authorization: grant });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(requested(exhausted), null);
});

const lockedLoan = (overrides: Row = {}) => origin({
  id: "loan-7", status: "ESCROWED", modelCid: null, runnerReceipt: null, settleTxHash: null, rentalExpiresAt: null,
  evmDeadline: new Date(Date.now() + 3 * DAY), ...overrides,
});

test("F2 : /run réveille la CVM pour l'emprunteur d'un prêt verrouillé, au budget de son compte, puis lance une fois allumée", async () => {
  const sys = system({ phase: "stopped", loans: [origin(), lockedLoan()] });
  const waiting = await sys.manage.run("loan-7");
  assert.equal(waiting.status, 503);
  assert.equal(waiting.headers.get("retry-after"), "45");
  assert.equal((await waiting.json()).code, "enclave_starting");
  assert.ok(requested(sys) instanceof Date);
  assert.equal(spent(sys), 1);
  assert.equal(sys.calls.runner.length, 0, "aucun entraînement lancé CVM éteinte");
  sys.prisma.runnerAvailability.rows[0].phase = "running";
  const run = await sys.manage.run("loan-7");
  assert.equal(run.status, 200, await run.clone().text());
  assert.deepEqual(sys.calls.runner.map(([op]) => op), ["runLoanJob"]);
  assert.equal(spent(sys), 1, "réveil encore frais : rien de plus dépensé");
});

test("F2 : /run refuse en 409 direct, sans réveil ni passage en TRAINING, un autre compte, un prêt réglé, une prolongation, un pack ou un lock échu", async () => {
  const sys = system({ phase: "stopped", loans: [
    origin(), lockedLoan(),
    lockedLoan({ id: "loan-expired", evmDeadline: new Date(Date.now() - 1) }),
    attached("extension"), attached("pack"),
  ] });
  assert.equal((await sys.manage.run("loan-1")).status, 409, "prêt réglé");
  const expired = await sys.manage.run("loan-expired");
  assert.equal(expired.status, 409, "lock échu");
  assert.equal((await expired.json()).error, "Lock de paiement échu : aucun entraînement possible, rembourse le prêt");
  assert.equal((await sys.manage.run("ext-9")).status, 409);
  assert.equal((await sys.manage.run("pack-9")).status, 409);
  sys.session.address = OTHER;
  assert.equal((await sys.manage.run("loan-7")).status, 403);
  assert.equal(requested(sys), null);
  assert.equal(sys.wakeBudget.size, 0);
  assert.equal(sys.calls.runner.length, 0, "jamais de prepareLoanResult (ni TRAINING ni runner)");
});

test("F2 (revue PR #159) : /run avec un grant hors périmètre refusé en 401 avant le réveil et avant TRAINING, même CVM allumée", async () => {
  for (const phase of ["stopped", "running"]) {
    const sys = system({ phase, loans: [origin(), lockedLoan()] });
    const wrong = [
      { payload: {}, signature: "signed" },
      runGrant("loan-7", { operation: "revoke-api-key" }),
      runGrant("loan-7", { loanId: "loan-1" }),
      runGrant("loan-7", { datasetId: "dataset-2" }),
      runGrant("loan-7", { jobId: "job-1" }),
      runGrant("loan-7", { payloadHash: hashRunnerIntent(["loan-7", "dataset-1", "autre-reçu", "logistic_regression", "1.0.0", "served"]) }),
    ];
    for (const authorization of wrong) {
      const refused = await sys.manage.run("loan-7", authorization);
      assert.equal(refused.status, 401, `${phase} ${JSON.stringify(authorization.payload)}`);
    }
    assert.equal(requested(sys), null, `${phase} : aucun réveil`);
    assert.equal(spent(sys), 0);
    assert.equal(sys.calls.runner.length, 0, `${phase} : aucun passage en TRAINING`);
  }
});

test("audit E : /settle et le règlement d'une prolongation vérifient la phase sans réveiller, le reaper n'y passe pas", async () => {
  const trained = lockedLoan({ status: "TRAINING", modelCid: FINGERPRINT, runnerReceipt: "receipt" });
  for (const [row, code] of [
    [{ phase: "running", validUntil: new Date(Date.now() - 1) }, "controller_unavailable"],
    [{ phase: "maintenance", validUntil: null }, "controller_unavailable"],
    [{ phase: "stopped", validUntil: null }, "enclave_starting"],
  ] as const) {
    const sys = system({ phase: row.phase, loans: [origin(), trained, attached("extension")] });
    Object.assign(sys.prisma.runnerAvailability.rows[0], { validUntil: row.validUntil });
    for (const response of [await sys.manage.settle("loan-7"), await sys.manage.settleExtension("ext-9")]) {
      assert.equal(response.status, 503, `${row.phase}`);
      assert.equal((await response.json()).code, code);
    }
    assert.equal(requested(sys), null, "aucun réveil écrit");
    assert.equal(sys.calls.runner.length, 0, "rien relayé");
    // Le reaper règle toujours la prolongation, sans contrôle de phase (CVM gardée voulue par le prêt).
    await sys.reaper().runLoanReaper(new Date());
    assert.deepEqual(sys.calls.runner.map(([op]) => op), ["extend"], `${row.phase} : reaper inchangé`);
  }
  // CVM servie : règlement relayé comme avant ; prêt déjà réglé : réponse sans contrôle de phase.
  const running = system({ phase: "running", loans: [origin(), trained] });
  Object.assign(running.prisma.runnerAvailability.rows[0], { validUntil: new Date(Date.now() + 60_000) });
  assert.equal((await running.manage.settle("loan-7")).status, 200);
  const settled = system({ phase: "stopped", loans: [origin()] });
  assert.equal((await settled.manage.settle("loan-1")).status, 200);
  // Prolongation refusée pour toujours (modèle d'origine supprimé) : refus définitif, pas d'attente d'enclave.
  const deleted = system({ phase: "stopped", loans: [origin({ rentalExpiresAt: new Date(Date.now() - 31 * DAY) }), attached("extension")] });
  const refused = await deleted.manage.settleExtension("ext-9");
  assert.equal(refused.status, 409);
  assert.equal(deleted.calls.runner.length, 0);
});

test("F2 : le reaper ne reprend pas un prêt verrouillé inactif tant que la CVM est arrêtée, sans compter d'échec", async () => {
  const idle = lockedLoan({ billingQuoteHash: `0x${"bb".repeat(32)}`, updatedAt: new Date(0) });
  const stopped = system({ phase: "stopped", loans: [idle] });
  const pass = await stopped.reaper().runLoanReaper(new Date());
  assert.equal(pass.examined, 1);
  assert.equal(pass.failed, 0);
  assert.equal(stopped.calls.runner.length, 0);
  const running = system({ phase: "running", loans: [{ ...idle }] });
  await running.reaper().runLoanReaper(new Date());
  assert.deepEqual(running.calls.runner.map(([op]) => op), ["recoverLoanJob"]);
});

test("F4 : contrôleur muet ou en maintenance : 503 controller_unavailable distinct, rien relayé ni réveillé", async () => {
  for (const row of [{ phase: "running", validUntil: new Date(Date.now() - 1) }, { phase: "stopped", validUntil: new Date(Date.now() - 1) }, { phase: "maintenance", validUntil: null }]) {
    const sys = system({ phase: row.phase, loans: [origin(), lockedLoan()], apiKeys: [activeKey()] });
    Object.assign(sys.prisma.runnerAvailability.rows[0], { validUntil: row.validUntil });
    const wallet = await sys.manage.run("loan-7");
    assert.equal(wallet.status, 503, row.phase);
    assert.equal(wallet.headers.get("retry-after"), "60");
    const body = await wallet.json();
    assert.equal(body.code, "controller_unavailable");
    assert.notEqual(body.code, "enclave_starting");
    const api = await sys.api.predict();
    assert.equal(api.status, 503);
    assert.equal(api.headers.get("retry-after"), "60", "/v1 : relance annoncée comme sur les routes wallet");
    assert.equal((await api.json()).error.code, "controller_unavailable");
    assert.equal(requested(sys), null, `${row.phase} : aucun réveil écrit`);
    assert.equal(spent(sys), 0);
    assert.equal(sys.calls.runner.length, 0);
  }
  // Phase encore valable, ou ligne d'un contrôleur antérieur (sans validUntil) : comportement habituel.
  for (const validUntil of [new Date(Date.now() + 60_000), null]) {
    const sys = system({ phase: "running", loans: [origin(), lockedLoan()] });
    Object.assign(sys.prisma.runnerAvailability.rows[0], { validUntil });
    assert.equal((await sys.manage.run("loan-7")).status, 200);
  }
});
