import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError } from "@/lib/app-error";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import * as addresses from "@/lib/evm/address";
import * as models from "@/lib/models/registry";
import * as rentalRules from "@/lib/billing/rental";
import * as settlementStatus from "@/lib/loans/settlement-status";
import * as failurePolicy from "@/lib/runner/failure-policy";
import * as reaperPolicy from "./reaper-policy";
import * as reaperErrors from "./reaper-errors";
import { settlementQueuedError } from "./settlement-queued";
import type * as Rental from "./rental";
import type * as Extend from "./extend";
import type * as Reaper from "./reaper";
import type * as ExtendRoute from "../../app/api/loans/[id]/extend/route";

// D-29 : prolongation d'une location. Exécution réelle de la route, de `extend.ts`, de `rental.ts` et
// du reaper, dépendances externes (base, chaîne, runner) remplacées.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, console, process, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const DAY = 86_400_000;
const BORROWER = addresses.normalizeAddress(`0x${"22".repeat(20)}`);
const PROVIDER = addresses.normalizeAddress(`0x${"33".repeat(20)}`);
const OTHER = addresses.normalizeAddress(`0x${"44".repeat(20)}`);
const RELEASE_TX = `0x${"55".repeat(32)}`;
const EXTENSION_TX = `0x${"66".repeat(32)}`;
const LOCK_TX = `0x${"77".repeat(32)}`;
const MODEL = { modelId: "linear_regression", modelVersion: "1.0.0" } as const;

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (condition && typeof condition === "object" && "lt" in condition) {
      return value instanceof Date && value.getTime() < (condition as { lt: Date }).lt.getTime();
    }
    return (value ?? null) === condition;
  });
}

function original(overrides: Partial<Row> = {}): Row {
  return {
    id: "loan-1", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "SETTLED", ...MODEL,
    settleTxHash: RELEASE_TX, runnerReceipt: "loan-receipt", finalityReview: null, rentalDays: 7,
    rentalExpiresAt: new Date(Date.now() + DAY), extendsLoanId: null, updatedAt: new Date(0), ...overrides,
  };
}

function extension(overrides: Partial<Row> = {}): Row {
  return {
    id: "loan-2", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER, status: "ESCROWED", ...MODEL,
    extendsLoanId: "loan-1", rentalDays: 5, rentalExpiresAt: null, settleTxHash: null, billingQuoteHash: `0x${"88".repeat(32)}`,
    evmLoanKey: `0x${"99".repeat(32)}`, evmLockTxHash: LOCK_TX, evmLockBlock: "12", evmDeadline: new Date(Date.now() + 3 * DAY),
    updatedAt: new Date(0), ...overrides,
  };
}

interface FixtureOptions {
  session?: string;
  /** Réponse du runner à `extend-loan` : échéance (ms) ou erreur. */
  runner?: () => Promise<{ settleTxHash: string; expiresAt: number }>;
  chain?: { state: "active" } | { state: "settled"; txHash: string } | { state: "cancelled"; txHash: string };
}

function fixture(rows: Row[], options: FixtureOptions = {}) {
  const loans = new Map(rows.map((row) => [row.id, row]));
  const calls = { prepared: [] as unknown[][], runner: [] as Record<string, unknown>[] };
  const store = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = loans.get(where.id);
      return row ? { ...row } : null;
    },
    findMany: async () => [...loans.values()].map((row) => ({ ...row })),
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const hits = [...loans.values()].filter((row) => matches(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  };
  const prisma = { loan: store };
  const db = { prisma, serializableTransaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma) };
  const client = {
    getTransactionReceipt: async () => ({ status: "success", blockNumber: BigInt(10) }),
    getBlock: async () => ({ timestamp: BigInt(0) }),
  };
  const rental = load<typeof Rental>("src/lib/sirius/rental.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": { AppError }, "@/lib/evm/address": addresses,
    "@/lib/evm/client": { getPublicClient: () => client }, "@/lib/billing/rental": rentalRules,
  });
  const chain = options.chain ?? { state: "active" as const };
  const extend = load<typeof Extend>("src/lib/sirius/extend.ts", {
    "server-only": {}, "@/lib/db": db, "@/lib/errors": { AppError }, "@/lib/evm/address": addresses,
    "@/lib/evm/escrow": { reconcileLoanEscrow: async () => chain },
    // Palier : finalité complète ici (garde de profondeur passée) ; le palier rapide est couvert par developer-api.test.ts.
    "./release-tier": { releaseFinalityTier: async () => "FULL" },
    "./settlement-evidence": { recordSettlementEvidence: async () => false },
    "@/lib/billing/loan": { loanBillingQuote: (loan: Row) => ({ quote: { loanId: loan.id, extendsLoanId: loan.extendsLoanId, rentalDays: loan.rentalDays } }) },
    "@/lib/models/registry": models,
    "@/lib/runner/failure-policy": failurePolicy,
    "@/lib/runner/provenance": { assertCurrentRunner: async () => ({}) },
    "@/lib/tee/runner-client": { extendLoanInRunner: async (input: Record<string, unknown>) => {
      calls.runner.push(input);
      return options.runner ? options.runner() : { settleTxHash: EXTENSION_TX, expiresAt: Date.now() + 6 * DAY };
    } },
    "@/lib/loans/settlement-status": settlementStatus,
    "./borrower": { prepareLoan: async (...args: unknown[]) => {
      calls.prepared.push(args);
      return { loan: { id: "loan-2" }, approveTransaction: {}, lockTransaction: {}, billingQuote: { quote: {} } };
    } },
    "./rental": rental,
    "./settlement-queued": { settlementQueuedError },
  });
  const session = { address: options.session ?? BORROWER };
  const route = load<typeof ExtendRoute>("src/app/api/loans/[id]/extend/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": db,
    "@/lib/auth/require-auth": {
      requireAuth: () => session, assertAuthenticGrant: async () => {},
      assertOwner: (current: typeof session, owner: string) => {
        if (!addresses.addressesEqual(current.address, owner)) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
      },
    },
    "@/lib/errors": { errorResponse }, "@/lib/http/body": { readJson },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => {} },
    "@/lib/billing/rental": rentalRules, "@/lib/runner/failure-policy": failurePolicy,
    "@/lib/loans/settlement-status": settlementStatus, "@/lib/sirius/extend": extend,
  });
  const send = (body: unknown, id = "loan-1") => route.POST(
    new Request(`https://test.invalid/api/loans/${id}/extend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  /** Reaper réel sur la même base et le même `extend.ts` ; `chain` : état de l'escrow relu par le reaper. */
  const reaperFor = (reaperChain: FixtureOptions["chain"] = { state: "active" }) => {
    const settled: string[] = [];
    const reaper = load<typeof Reaper>("src/lib/sirius/reaper.ts", {
      "server-only": {}, "@/lib/db": db,
      "@/lib/evm/escrow": { readLoan: async () => null, reconcileLoanEscrow: async () => reaperChain },
      "@/lib/evm/client": { getPublicClient: () => client },
      "./reaper-policy": reaperPolicy, "./reaper-errors": reaperErrors,
      "./recover-loan": { recoverUnsubmittedLoan: async () => {} },
      "@/lib/evm/history": { resolveLoanEscrow: async () => ({}) },
      "./settle": { recoverLoanResult: async () => false, settlePreparedLoan: async (id: string) => { settled.push(id); } },
      "./fast-settlement-review": { verifyFastSettlement: async () => ({ state: "pending" }) },
      "@/lib/runner/failure-policy": failurePolicy, "@/lib/app-error": { AppError }, "@/lib/models/registry": models,
      "./extend": extend, "./rental": rental, "@/lib/loans/settlement-status": settlementStatus,
      "./calls": { settleCallPack: async () => { throw new Error("aucun pack dans ce scénario"); } },
    });
    return { reaper, settled };
  };
  return { loans, calls, extend, client, send, reaperFor };
}

async function errorOf(response: Response): Promise<[number, string]> {
  return [response.status, (await response.json()).error];
}

test("prolongation : préparée pour l'emprunteur d'un prêt loué, même échu, tant que le modèle n'est pas supprimé", async () => {
  const { calls, send } = fixture([original({ rentalExpiresAt: new Date(Date.now() - 2 * DAY) })]);
  const response = await send({ rentalDays: 5 });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).loanId, "loan-2");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.prepared)), [["dataset-1", BORROWER, 5, { originalLoanId: "loan-1", model: MODEL }]]);
});

test("prolongation refusée à un autre compte, sur un prêt hérité, un modèle supprimé ou une durée invalide, avant tout lock", async () => {
  const cases: [Row, FixtureOptions, unknown, number, string][] = [
    [original(), { session: OTHER }, 5, 403, "Accès refusé : emprunt d’un autre compte"],
    [original({ rentalDays: null, rentalExpiresAt: null }), {}, 5, 409, "Prêt sans durée de location : rien à prolonger"],
    [original({ rentalExpiresAt: new Date(Date.now() - 31 * DAY) }), {}, 5, 409, "Modèle supprimé : location close"],
    [original({ rentalExpiresAt: new Date(Date.now() - 30 * DAY) }), {}, 5, 409, "Modèle supprimé : location close"],
    [original({ extendsLoanId: "loan-0" }), {}, 5, 409, "Une prolongation ne se prolonge pas : prolonge le prêt d’origine"],
    [original({ status: "SETTLING" }), {}, 5, 409, "Règlement du prêt non confirmé"],
    [original(), {}, 0, 400, "Durée de location invalide"],
    [original(), {}, 366, 400, "Durée de location invalide"],
    [original(), {}, "5", 400, "Durée de location invalide"],
  ];
  for (const [row, options, rentalDays, status, error] of cases) {
    const { calls, send } = fixture([row], options);
    assert.deepEqual(await errorOf(await send({ rentalDays })), [status, error], `${error} (${JSON.stringify(rentalDays)})`);
    assert.equal(calls.prepared.length, 0, error);
  }
});

test("une échéance absente est relue du bloc de release avant de décider : modèle supprimé, prolongation refusée", async () => {
  // Release il y a 40 jours, location de 7 jours : échéance il y a 33 jours, au-delà du délai de grâce.
  const { calls, client, loans, send } = fixture([original({ rentalExpiresAt: null })]);
  client.getBlock = async () => ({ timestamp: BigInt(Math.floor((Date.now() - 40 * DAY) / 1000)) });
  assert.deepEqual(await errorOf(await send({ rentalDays: 5 })), [409, "Modèle supprimé : location close"]);
  assert.equal(calls.prepared.length, 0);
  assert.ok(loans.get("loan-1")!.rentalExpiresAt instanceof Date, "l'échéance relue est enregistrée");
});

test("règlement d'une prolongation : release par le runner, échéance reportée sur le prêt d'origine, rejouable", async () => {
  const expiresAt = Date.now() + 6 * DAY;
  const { loans, calls, send } = fixture([original(), extension()], { runner: async () => ({ settleTxHash: EXTENSION_TX, expiresAt }) });
  const response = await send({ extensionLoanId: "loan-2", authorization: { payload: {}, signature: "signed" } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { loanId: "loan-2", originalLoanId: "loan-1", settleTxHash: EXTENSION_TX, rentalExpiresAt: new Date(expiresAt).toISOString() });
  assert.equal(calls.runner.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.runner[0])), {
    loanId: "loan-2", originalLoanId: "loan-1", loanReceipt: "loan-receipt", lockBlock: "12",
    billingQuote: { quote: { loanId: "loan-2", extendsLoanId: "loan-1", rentalDays: 5 } },
    authorization: { payload: {}, signature: "signed" },
  });
  assert.equal(loans.get("loan-2")!.status, "SETTLED");
  assert.equal(loans.get("loan-2")!.settleTxHash, EXTENSION_TX);
  assert.equal(Number(loans.get("loan-1")!.rentalExpiresAt), expiresAt);
  // Rejeu (onglet rouvert) : même résultat, sans nouvel appel au runner.
  const replay = await send({ extensionLoanId: "loan-2", authorization: { payload: {}, signature: "signed" } });
  assert.equal((await replay.json()).rentalExpiresAt, new Date(expiresAt).toISOString());
  assert.equal(calls.runner.length, 1);
});

test("règlement d'une prolongation refusé à un autre compte, ou quand le modèle d'origine est supprimé, sans release", async () => {
  const stranger = fixture([original(), extension()], { session: OTHER });
  const refused = await stranger.send({ extensionLoanId: "loan-2", authorization: { payload: {}, signature: "signed" } });
  assert.equal(refused.status, 403);
  assert.equal(stranger.calls.runner.length, 0);

  const deleted = fixture([original({ rentalExpiresAt: new Date(Date.now() - 31 * DAY) }), extension()]);
  assert.deepEqual(await errorOf(await deleted.send({ extensionLoanId: "loan-2", authorization: { payload: {}, signature: "signed" } })),
    [409, "Modèle supprimé : location close"]);
  assert.equal(deleted.calls.runner.length, 0);
  assert.equal(deleted.loans.get("loan-2")!.status, "ESCROWED", "la prolongation reste remboursable à son échéance");

  const foreign = fixture([original(), extension({ extendsLoanId: "loan-9" })]);
  assert.equal((await foreign.send({ extensionLoanId: "loan-2", authorization: { payload: {}, signature: "signed" } })).status, 404);
  assert.equal(foreign.calls.runner.length, 0);
});

test("un runner en échec rend la prolongation à ESCROWED ; un remboursement on-chain la clôt", async () => {
  const failing = fixture([original(), extension()], { runner: async () => { throw new AppError("Runner confidentiel indisponible", 503); } });
  await assert.rejects(failing.extend.settleLoanExtension("loan-2"), /Runner confidentiel indisponible/);
  assert.equal(failing.loans.get("loan-2")!.status, "ESCROWED");

  const refunded = fixture([original(), extension()], {
    runner: async () => { throw new AppError("Escrow inactif", 409); }, chain: { state: "cancelled", txHash: LOCK_TX },
  });
  await assert.rejects(refunded.extend.settleLoanExtension("loan-2"), /Escrow inactif/);
  assert.equal(refunded.loans.get("loan-2")!.status, "CANCELLED");
  assert.equal(refunded.loans.get("loan-1")!.rentalExpiresAt instanceof Date, true, "l'échéance d'origine n'est pas touchée");
});

test("reaper : une prolongation verrouillée non réglée est reprise sans autorisation, et l'échéance reportée", async () => {
  const expiresAt = Date.now() + 6 * DAY;
  const context = fixture([extension({ updatedAt: new Date(Date.now() - DAY) })], { runner: async () => ({ settleTxHash: EXTENSION_TX, expiresAt }) });
  context.loans.set("loan-1", original());
  const { reaper, settled } = context.reaperFor();
  const pass = await reaper.runLoanReaper(new Date());
  assert.equal(pass.failed, 0);
  assert.equal(context.calls.runner.length, 1, "extend-loan rejoué par le reaper");
  assert.equal(context.calls.runner[0].authorization, undefined, "chemin serveur, sans grant de l'emprunteur");
  assert.equal(context.loans.get("loan-2")!.status, "SETTLED");
  assert.equal(Number(context.loans.get("loan-1")!.rentalExpiresAt), expiresAt);
  assert.deepEqual(settled, [], "le prêt d'origine, déjà réglé, n'est pas re-réglé");
});

test("reaper : une prolongation échue sans release ou remboursée n'est pas rejouée", async () => {
  const overdue = fixture([extension({ evmDeadline: new Date(Date.now() - 1) })]);
  overdue.loans.set("loan-1", original());
  await overdue.reaperFor().reaper.runLoanReaper(new Date());
  assert.equal(overdue.calls.runner.length, 0);
  assert.equal(overdue.loans.get("loan-2")!.status, "ESCROWED");

  const refunded = fixture([extension()]);
  refunded.loans.set("loan-1", original());
  await refunded.reaperFor({ state: "cancelled", txHash: LOCK_TX }).reaper.runLoanReaper(new Date());
  assert.equal(refunded.calls.runner.length, 0);
  assert.equal(refunded.loans.get("loan-2")!.status, "CANCELLED");
});
