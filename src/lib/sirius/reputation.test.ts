import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as policy from "./reputation-policy";
import type * as Reputation from "./reputation";

// Réputation lue en base : seuls les emprunts comptent, jamais les achats rattachés (audit B P3-2).

type Row = Record<string, unknown>;

function load(rows: Row[]): typeof Reputation {
  const exports = {};
  const matches = (row: Row, where: Row) => Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === "object" && "in" in condition && Array.isArray(condition.in)) return condition.in.includes(row[key]);
    if (condition && typeof condition === "object" && "not" in condition) return (row[key] ?? null) !== condition.not;
    return (row[key] ?? null) === condition;
  });
  const prisma = { loan: { groupBy: async ({ by: [field], where }: { by: [string]; where: Row }) => {
    const counts = new Map<unknown, number>();
    for (const row of rows.filter((candidate) => matches(candidate, where))) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
    return [...counts].map(([key, count]) => ({ [field]: key, _count: { _all: count } }));
  } } };
  const source = ts.transpileModule(readFileSync("src/lib/sirius/reputation.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = { "server-only": {}, "@/lib/db": { prisma }, "./reputation-policy": policy };
  runInNewContext(source, { exports, require: (name: string) => dependencies[name] });
  return exports as typeof Reputation;
}

const PROVIDER = "0x3333333333333333333333333333333333333333";
const BORROWER = "0x2222222222222222222222222222222222222222";
const loan = (overrides: Row): Row => ({
  provider: PROVIDER, borrower: BORROWER, extendsLoanId: null, packForLoanId: null,
  status: "SETTLED", settleTxHash: "0xsettle", cancelTxHash: null, ...overrides,
});

test("réputation : prolongation, pack et pass (même caduc et remboursé) ne comptent ni en réussite ni en échec", async () => {
  const rental = load([loan({})]);
  const withPurchases = load([
    loan({}),
    loan({ extendsLoanId: "loan-1" }),
    loan({ packForLoanId: "loan-1" }),
    loan({ packForLoanId: "loan-1", status: "CANCELLED", settleTxHash: null, cancelTxHash: "0xrefund" }),
  ]);
  for (const [address, role] of [[PROVIDER, "provider"], [BORROWER, "borrower"]] as const) {
    assert.deepEqual(await withPurchases.reputationForAddress(address, role), await rental.reputationForAddress(address, role), role);
  }
});
